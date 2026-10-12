// Command humansi is the HumanSI Synergy fleet server: the site, the Rule
// Book API, the server-scored fleet board with its live feed, launch
// clearance, and the SI console relay to a local Ollama.
//
// Configuration, flag first, then environment, then default:
//
//	-addr         HUMANSI_ADDR          listen address (:8080)
//	-data         HUMANSI_DATA_DIR      board directory (./data)
//	-trust-proxy  HUMANSI_TRUST_PROXY   read client addresses from X-Forwarded-For (false)
//	-ollama       HUMANSI_OLLAMA_URL    Ollama base URL; empty turns the console off
//	              HUMANSI_SECRET        clearance signing key; unset means a random
//	                                    per-process key, so tokens die on restart
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	humansi "github.com/Ranjith1605/humanSi.007"
	"github.com/Ranjith1605/humanSi.007/internal/api"
	"github.com/Ranjith1605/humanSi.007/internal/clearance"
	"github.com/Ranjith1605/humanSi.007/internal/copilot"
	"github.com/Ranjith1605/humanSi.007/internal/leaderboard"
	"github.com/Ranjith1605/humanSi.007/internal/rulebook"
)

// Version is the server's release.
const Version = "0.1.0"

// shutdownGrace is how long in-flight requests get after SIGINT/SIGTERM.
const shutdownGrace = 10 * time.Second

type config struct {
	addr        string
	dataDir     string
	trustProxy  bool
	ollamaURL   string
	secret      string
	showVersion bool
}

// parseConfig reads flags over environment over defaults.
func parseConfig(args []string, getenv func(string) string, stderr io.Writer) (config, error) {
	envOr := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}
	trustDefault := false
	if v := strings.TrimSpace(getenv("HUMANSI_TRUST_PROXY")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return config{}, fmt.Errorf("HUMANSI_TRUST_PROXY=%q is not a boolean", v)
		}
		trustDefault = b
	}

	var c config
	fsf := flag.NewFlagSet("humansi", flag.ContinueOnError)
	fsf.SetOutput(stderr)
	fsf.StringVar(&c.addr, "addr", envOr("HUMANSI_ADDR", ":8080"), "listen address (env HUMANSI_ADDR)")
	fsf.StringVar(&c.dataDir, "data", envOr("HUMANSI_DATA_DIR", "./data"), "directory for leaderboard.json (env HUMANSI_DATA_DIR)")
	fsf.BoolVar(&c.trustProxy, "trust-proxy", trustDefault, "use X-Forwarded-For for client addresses; only behind a proxy you run (env HUMANSI_TRUST_PROXY)")
	fsf.StringVar(&c.ollamaURL, "ollama", envOr("HUMANSI_OLLAMA_URL", ""), "Ollama base URL, e.g. http://localhost:11434; empty turns the SI console off (env HUMANSI_OLLAMA_URL)")
	fsf.BoolVar(&c.showVersion, "version", false, "print the version and exit")
	if err := fsf.Parse(args); err != nil {
		return config{}, err
	}
	if fsf.NArg() > 0 {
		return config{}, fmt.Errorf("unexpected arguments: %v", fsf.Args())
	}
	// The secret is environment-only so it never shows up in a process list.
	c.secret = getenv("HUMANSI_SECRET")
	return c, nil
}

func main() {
	cfg, err := parseConfig(os.Args[1:], os.Getenv, os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "humansi:", err)
		os.Exit(2)
	}
	if cfg.showVersion {
		fmt.Println("humansi", Version)
		return
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(cfg, log); err != nil {
		log.Error("humansi stopped", "err", err.Error())
		os.Exit(1)
	}
}

func run(cfg config, log *slog.Logger) error {
	site, err := fs.Sub(humansi.Web, "web")
	if err != nil {
		return err
	}
	// Fail fast: a server with a broken Rule Book would score runs wrongly.
	rb, models, err := rulebook.Load(site)
	if err != nil {
		return fmt.Errorf("the embedded Rule Book is invalid, rebuild after fixing it: %w", err)
	}

	key := []byte(cfg.secret)
	if len(key) == 0 {
		if key, err = clearance.RandomKey(); err != nil {
			return err
		}
		log.Warn("HUMANSI_SECRET is not set: using a random key, so launch clearances stop working when the server restarts")
	} else if len(key) < 32 {
		log.Warn("HUMANSI_SECRET is shorter than 32 bytes; use a long random value")
	}
	signer, err := clearance.New(key, clearance.DefaultTTL, nil)
	if err != nil {
		return err
	}

	board, err := leaderboard.Open(cfg.dataDir, leaderboard.Options{Logger: log})
	if err != nil {
		return err
	}

	var cp *copilot.Client
	if cfg.ollamaURL != "" {
		if cp, err = copilot.New(cfg.ollamaURL, copilot.Options{}); err != nil {
			return err
		}
		log.Info("SI console enabled", "ollama", cp.BaseURL())
	} else {
		log.Info("SI console off: set HUMANSI_OLLAMA_URL to connect a local model")
	}

	srvAPI := api.New(api.Config{
		Site:       site,
		Rulebook:   rb,
		Models:     models,
		Board:      board,
		Signer:     signer,
		Copilot:    cp,
		Logger:     log,
		Version:    Version,
		TrustProxy: cfg.trustProxy,
	})
	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           srvAPI,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// No WriteTimeout: the fleet feed and console answers are long-lived
		// streams; they set per-write deadlines themselves.
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 64 << 10,
		ErrorLog:       slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	ln, err := net.Listen("tcp", cfg.addr)
	if err != nil {
		return err
	}
	log.Info("humansi listening", "version", Version, "addr", ln.Addr().String(),
		"data", board.Path(), "entries", board.Len(), "trustProxy", cfg.trustProxy)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	stop() // a second signal now kills the process the default way
	log.Info("shutting down", "grace", shutdownGrace.String())
	srvAPI.BeginShutdown() // ends SSE feeds and console streams so Shutdown can drain
	sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		_ = srv.Close()
		return fmt.Errorf("shutdown: %w", err)
	}
	if err := <-errc; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	log.Info("stopped cleanly")
	return nil
}
