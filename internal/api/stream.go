package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/Ranjith1605/humanSi.007/internal/leaderboard"
)

// sseWriter writes server-sent events with a per-write deadline, so one
// stalled client cannot pin a goroutine forever, and clears the deadline
// when done so a reused keep-alive connection does not inherit it.
type sseWriter struct {
	w       http.ResponseWriter
	rc      *http.ResponseController
	timeout time.Duration
}

func startSSE(w http.ResponseWriter, timeout time.Duration) *sseWriter {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // ask nginx-style proxies not to buffer the stream
	w.WriteHeader(http.StatusOK)
	return &sseWriter{w: w, rc: http.NewResponseController(w), timeout: timeout}
}

func (s *sseWriter) send(chunk string) error {
	// Recorders and some wrappers cannot set deadlines; streaming still works.
	_ = s.rc.SetWriteDeadline(time.Now().Add(s.timeout))
	if _, err := io.WriteString(s.w, chunk); err != nil {
		return err
	}
	return s.rc.Flush()
}

func (s *sseWriter) event(name string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.send("event: " + name + "\ndata: " + string(data) + "\n\n")
}

func (s *sseWriter) close() { _ = s.rc.SetWriteDeadline(time.Time{}) }

// fleetStream is the live board feed: one `run` event per accepted run and
// a comment ping every 25 s to keep proxies from closing an idle stream.
func (s *Server) fleetStream(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodHead {
		// Headers only: a HEAD must not hold the connection open as a stream.
		startSSE(w, s.cfg.Limits.SSEWriteTimeout)
		return
	}
	runs, cancel, err := s.cfg.Board.Feed().Subscribe()
	switch {
	case errors.Is(err, leaderboard.ErrFull):
		w.Header().Set("Retry-After", "30")
		writeError(w, http.StatusServiceUnavailable, "too_many_listeners", "The live feed is full. Try again shortly.", "")
		return
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, "shutting_down", "The server is shutting down.", "")
		return
	}
	defer cancel()

	sse := startSSE(w, s.cfg.Limits.SSEWriteTimeout)
	defer sse.close()
	if sse.send("retry: 5000\n: connected\n\n") != nil {
		return
	}
	ping := time.NewTicker(s.cfg.Limits.PingInterval)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case e, ok := <-runs:
			if !ok {
				// Dropped for falling behind, or the feed closed:
				// end the stream and let EventSource reconnect.
				return
			}
			if sse.event("run", e) != nil {
				return
			}
		case <-ping.C:
			if sse.send(": ping\n\n") != nil {
				return
			}
		}
	}
}
