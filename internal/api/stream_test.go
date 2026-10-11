package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Ranjith1605/humanSi.007/internal/leaderboard"
)

func openStream(t *testing.T, h *harness) (*http.Response, *sseReader) {
	t.Helper()
	req, _ := http.NewRequest("GET", h.ts.URL+"/api/fleet/stream", nil)
	res, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res, readSSE(res.Body)
}

func TestFleetStreamDeliversRuns(t *testing.T) {
	h := newHarness(t)
	res, events := openStream(t, h)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" ||
		res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("stream: %d %v", res.StatusCode, res.Header)
	}
	checkSecurityHeaders(t, "stream", res.Header)
	if first := events.next(t, true); first.comment != "connected" {
		t.Fatalf("first block = %+v", first)
	}
	eventually(t, "subscriber registered", func() bool { return h.board.Feed().Len() == 1 })

	post := h.postJSON("/api/runs", runBody("Feed Pilot", fixtureSectors(t, "minimal clearing run")))
	if post.status != 201 {
		t.Fatalf("post: %d %s", post.status, post.body)
	}
	posted := post.json(t)["entry"].(map[string]any)

	ev := events.next(t, false)
	if ev.name != "run" {
		t.Fatalf("event = %+v", ev)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(ev.data), &got); err != nil {
		t.Fatal(err)
	}
	for k, v := range posted {
		if got[k] != v {
			t.Errorf("streamed %s = %v, posted %v", k, got[k], v)
		}
	}

	// A rejected run is not broadcast.
	h.postJSON("/api/runs", runBody("Feed Pilot", `[]`))
	h.clock.Advance(time.Minute)
	h.postJSON("/api/runs", runBody("Second", fixtureSectors(t, "minimal clearing run")))
	if ev := events.next(t, false); !strings.Contains(ev.data, `"callsign":"Second"`) {
		t.Errorf("next event = %+v", ev)
	}
}

func TestFleetStreamPings(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Limits.PingInterval = 20 * time.Millisecond })
	_, events := openStream(t, h)
	events.next(t, true) // connected
	if ev := events.next(t, true); ev.comment != "ping" {
		t.Errorf("block = %+v, want a ping", ev)
	}
}

func TestFleetStreamCapacity(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		board, err := leaderboard.Open(t.TempDir(), leaderboard.Options{Feed: leaderboard.NewFeed(1, 4), Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
		if err != nil {
			t.Fatal(err)
		}
		c.Board = board
	})
	_, events := openStream(t, h)
	events.next(t, true)
	r := h.get("/api/fleet/stream")
	checkError(t, r, http.StatusServiceUnavailable, "too_many_listeners")
	if r.header.Get("Retry-After") == "" {
		t.Error("no Retry-After on a full feed")
	}
}

func TestFleetStreamClientDisconnectFreesSlot(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", h.ts.URL+"/api/fleet/stream", nil)
	res, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	readSSE(res.Body).next(t, true)
	eventually(t, "subscribed", func() bool { return h.board.Feed().Len() == 1 })
	cancel()
	res.Body.Close()
	eventually(t, "unsubscribed", func() bool { return h.board.Feed().Len() == 0 })
}

// Shutdown must not hang on open feeds: BeginShutdown ends them, then
// http.Server.Shutdown drains.
func TestFleetStreamEndsOnShutdown(t *testing.T) {
	h := newHarness(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h.srv}
	go srv.Serve(ln)

	res, err := http.Get("http://" + ln.Addr().String() + "/api/fleet/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	events := readSSE(res.Body)
	events.next(t, true)

	start := time.Now()
	h.srv.BeginShutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("shutdown took %v", d)
	}
	events.waitEnd(t)
	// New listeners are refused once shutdown has begun.
	checkError(t, h.get("/api/fleet/stream"), http.StatusServiceUnavailable, "shutting_down")
}
