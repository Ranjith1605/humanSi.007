package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"time"
)

// CSP is the Content-Security-Policy from docs/ARCHITECTURE.md, verbatim.
// It forbids inline scripts and inline style attributes everywhere in web/;
// the only third-party origins are Google Fonts' stylesheet and font hosts.
const CSP = "default-src 'self'; " +
	"style-src 'self' https://fonts.googleapis.com; " +
	"font-src https://fonts.gstatic.com; " +
	"media-src 'self'; " +
	"img-src 'self' data:; " +
	"connect-src 'self'"

// securityHeaders sets the documented headers on every response, errors
// and redirects included.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", CSP)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// statusWriter records the status and size for the access log. It keeps
// streaming working: Flush passes through, and Unwrap lets
// http.ResponseController reach the connection for write deadlines.
type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += int64(n)
	return n, err
}

func (w *statusWriter) Flush() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := w.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errors.New("api: hijacking not supported")
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// observe logs every request (method, path, status, size, duration: never
// query strings, bodies or client addresses) and turns a panic into a JSON
// 500 instead of a dropped connection.
func (s *Server) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w}
		start := time.Now()
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler { // net/http's own "abort quietly" signal
					panic(v)
				}
				s.log.Error("panic serving request", "method", r.Method, "path", r.URL.Path,
					"panic", fmt.Sprint(v), "stack", string(debug.Stack()))
				if sw.status == 0 {
					writeError(sw, http.StatusInternalServerError, "internal", "Something went wrong on the server.", "")
				}
			}
			level := slog.LevelInfo
			if sw.status >= 500 {
				level = slog.LevelError
			}
			s.log.Log(context.Background(), level, "http",
				"method", r.Method, "path", r.URL.Path, "status", sw.status,
				"bytes", sw.bytes, "durationMs", time.Since(start).Milliseconds())
		}()
		next.ServeHTTP(sw, r)
		if sw.status == 0 {
			sw.status = http.StatusOK
		}
	})
}

// apiError is the documented error body.
type apiError struct {
	Error         string `json:"error"`
	Message       string `json:"message"`
	Field         string `json:"field,omitempty"`
	RetryAfterSec int    `json:"retryAfterSec,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		status = http.StatusInternalServerError
		body = []byte(`{"error":"internal","message":"Could not encode the response."}`)
	}
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	if h.Get("Cache-Control") == "" {
		h.Set("Cache-Control", "no-store")
	}
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}

func writeError(w http.ResponseWriter, status int, code, message, field string) {
	writeJSON(w, status, apiError{Error: code, Message: message, Field: field})
}

func writeRateLimited(w http.ResponseWriter, wait time.Duration, message string) {
	sec := int((wait + time.Second - 1) / time.Second)
	if sec < 1 {
		sec = 1
	}
	w.Header().Set("Retry-After", fmt.Sprint(sec))
	writeJSON(w, http.StatusTooManyRequests, apiError{
		Error: "rate_limited", Message: fmt.Sprintf(message, sec), RetryAfterSec: sec,
	})
}
