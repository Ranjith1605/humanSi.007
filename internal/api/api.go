// Package api is the fleet server's HTTP surface: the JSON API documented
// in docs/ARCHITECTURE.md ("HTTP API"), the live fleet feed over SSE, the
// SI console relay, and the embedded site as static files.
//
// Every response carries the security headers; every error is JSON of the
// documented shape {"error":code,"message":text,"field":name?}. The server
// never trusts a client's score: runs are re-validated and re-scored with
// internal/game, the mirror of web/js/scoring.js.
package api

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/Ranjith1605/humanSi.007/internal/clearance"
	"github.com/Ranjith1605/humanSi.007/internal/copilot"
	"github.com/Ranjith1605/humanSi.007/internal/leaderboard"
	"github.com/Ranjith1605/humanSi.007/internal/rulebook"
)

// Limits are the server's documented limits. Zero values pick the defaults.
type Limits struct {
	RunsPerMinute    float64 // POST /api/runs token refill per client IP (default 5)
	RunsBurst        int     // POST /api/runs bucket size (default 3)
	CopilotPerMinute float64 // POST /api/copilot per client IP (default 10)
	CopilotBurst     int     // default 10
	MaxRunBody       int64   // default 16 KiB
	MaxCopilotBody   int64   // default 192 KiB (12 messages x 2000 characters, escaped)
	PingInterval     time.Duration
	SSEWriteTimeout  time.Duration
}

func (l *Limits) defaults() {
	if l.RunsPerMinute <= 0 {
		l.RunsPerMinute = 5
	}
	if l.RunsBurst <= 0 {
		l.RunsBurst = 3
	}
	if l.CopilotPerMinute <= 0 {
		l.CopilotPerMinute = 10
	}
	if l.CopilotBurst <= 0 {
		l.CopilotBurst = 10
	}
	if l.MaxRunBody <= 0 {
		l.MaxRunBody = 16 << 10
	}
	if l.MaxCopilotBody <= 0 {
		l.MaxCopilotBody = 192 << 10
	}
	if l.PingInterval <= 0 {
		l.PingInterval = 25 * time.Second
	}
	if l.SSEWriteTimeout <= 0 {
		l.SSEWriteTimeout = 30 * time.Second
	}
}

// Config wires the server. Site, Rulebook, Models, Board and Signer are
// required; Copilot nil means the console is off.
type Config struct {
	Site       fs.FS
	Rulebook   *rulebook.Rulebook
	Models     *rulebook.Models
	Board      *leaderboard.Store
	Signer     *clearance.Signer
	Copilot    *copilot.Client
	Logger     *slog.Logger
	Version    string
	TrustProxy bool
	Now        func() time.Time
	Limits     Limits
}

// Server is the HTTP handler plus the state behind it.
type Server struct {
	cfg     Config
	log     *slog.Logger
	now     func() time.Time
	started time.Time
	mux     *http.ServeMux
	handler http.Handler
	prompt  string

	runLimiter     *Limiter
	copilotLimiter *Limiter

	// ctx ends when the server begins shutting down; long-lived streams
	// watch it so http.Server.Shutdown is not left waiting on them.
	ctx    context.Context
	cancel context.CancelFunc

	streamsMu sync.Mutex
	streams   map[string]bool // clearance entry ids with a console stream open

	etags sync.Map // static file name -> ETag
}

// apiRoutes are the documented endpoints and the methods each accepts
// (GET also answers HEAD, as net/http does). Anything else under /api/ is a
// JSON 404 whatever the method, never the static site's answer.
var apiRoutes = map[string]string{
	"/api/health":         "GET, HEAD",
	"/api/rulebook":       "GET, HEAD",
	"/api/leaderboard":    "GET, HEAD",
	"/api/runs":           "POST",
	"/api/fleet/stream":   "GET, HEAD",
	"/api/copilot/status": "GET, HEAD",
	"/api/copilot":        "POST",
}

// New builds the server.
func New(cfg Config) *Server {
	cfg.Limits.defaults()
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{
		cfg:            cfg,
		log:            cfg.Logger,
		now:            cfg.Now,
		started:        cfg.Now(),
		prompt:         copilot.SystemPrompt(cfg.Rulebook),
		runLimiter:     NewLimiter(cfg.Limits.RunsPerMinute/60, cfg.Limits.RunsBurst, cfg.Now),
		copilotLimiter: NewLimiter(cfg.Limits.CopilotPerMinute/60, cfg.Limits.CopilotBurst, cfg.Now),
		ctx:            ctx,
		cancel:         cancel,
		streams:        map[string]bool{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("GET /api/rulebook", s.rulebook)
	mux.HandleFunc("GET /api/leaderboard", s.leaderboard)
	mux.HandleFunc("POST /api/runs", s.postRun)
	mux.HandleFunc("GET /api/fleet/stream", s.fleetStream)
	mux.HandleFunc("GET /api/copilot/status", s.copilotStatus)
	mux.HandleFunc("POST /api/copilot", s.copilotChat)
	mux.HandleFunc("GET /", s.static)
	s.mux = mux

	s.handler = s.observe(securityHeaders(http.HandlerFunc(s.route)))
	return s
}

// ServeHTTP makes the server an http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

// BeginShutdown ends every live stream (fleet feed and console) so that
// http.Server.Shutdown can drain promptly. New streams are refused.
func (s *Server) BeginShutdown() {
	s.cancel()
	s.cfg.Board.Feed().Close()
}

// route answers unknown endpoints and wrong methods in the documented JSON
// shape, then hands everything else to the mux (Go 1.22 method patterns).
func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if p == "/api" || strings.HasPrefix(p, "/api/") {
		allow, ok := apiRoutes[p]
		if !ok {
			writeError(w, http.StatusNotFound, "not_found", "No such endpoint.", "")
			return
		}
		if !methodAllowed(allow, r.Method) {
			w.Header().Set("Allow", allow)
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "This endpoint does not accept "+r.Method+".", "")
			return
		}
	} else if _, pattern := s.mux.Handler(r); pattern == "" {
		// Every path matches "GET /", so no pattern means a method the
		// read-only site does not serve.
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "This endpoint does not accept "+r.Method+".", "")
		return
	}
	s.mux.ServeHTTP(w, r)
}

func methodAllowed(allow, method string) bool {
	for _, m := range strings.Split(allow, ", ") {
		if m == method {
			return true
		}
	}
	return false
}

func (s *Server) clientIP(r *http.Request) string { return ClientIP(r, s.cfg.TrustProxy) }
