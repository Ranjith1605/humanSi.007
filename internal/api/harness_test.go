package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	humansi "github.com/Ranjith1605/humanSi.007"
	"github.com/Ranjith1605/humanSi.007/internal/clearance"
	"github.com/Ranjith1605/humanSi.007/internal/leaderboard"
	"github.com/Ranjith1605/humanSi.007/internal/rulebook"
)

// fakeClock drives rate limits, createdAt, uptime and clearance expiry.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// syncBuffer collects logs written from server goroutines.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type harness struct {
	t      *testing.T
	srv    *Server
	ts     *httptest.Server
	clock  *fakeClock
	board  *leaderboard.Store
	signer *clearance.Signer
	rb     *rulebook.Rulebook
	models *rulebook.Models
	logs   *syncBuffer
	dir    string
}

func embeddedSite(t *testing.T) fs.FS {
	t.Helper()
	sub, err := fs.Sub(humansi.Web, "web")
	if err != nil {
		t.Fatal(err)
	}
	return sub
}

// testSite is a small site with the real data files, so static tests do not
// depend on pages other builders are still writing.
func testSite(t *testing.T) fstest.MapFS {
	t.Helper()
	real := embeddedSite(t)
	read := func(name string) []byte {
		b, err := fs.ReadFile(real, name)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	return fstest.MapFS{
		"index.html":                  {Data: []byte("<!doctype html><title>landing</title>")},
		"play.html":                   {Data: []byte("<!doctype html><title>play</title>")},
		"css/site.css":                {Data: []byte("body{color:#fff}")},
		"js/app.js":                   {Data: []byte("export const x = 1;")},
		"js/mod.mjs":                  {Data: []byte("export const y = 2;")},
		"assets/video/loop.webm":      {Data: bytes.Repeat([]byte{0x1a, 0x45, 0xdf, 0xa3}, 64)},
		"assets/img/poster.webp":      {Data: []byte("RIFF....WEBP")},
		"guide/index.html":            {Data: []byte("<!doctype html><title>guide</title>")},
		"blob.bin":                    {Data: []byte{0, 1, 2}},
		rulebook.RulebookPath:         {Data: read(rulebook.RulebookPath)},
		rulebook.ModelsPath:           {Data: read(rulebook.ModelsPath)},
		"data/nested/.keep":           {Data: nil},
		"assets/video/unused/.ignore": {Data: nil},
	}
}

func newHarness(t *testing.T, mutate ...func(*Config)) *harness {
	t.Helper()
	site := testSite(t)
	rb, models, err := rulebook.Load(site)
	if err != nil {
		t.Fatal(err)
	}
	clock := &fakeClock{t: time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)}
	logs := &syncBuffer{}
	log := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	dir := t.TempDir()
	board, err := leaderboard.Open(dir, leaderboard.Options{Logger: log, Now: clock.Now})
	if err != nil {
		t.Fatal(err)
	}
	signer, err := clearance.New([]byte("test-secret-test-secret-test-sec"), clearance.DefaultTTL, clock.Now)
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		Site:     site,
		Rulebook: rb,
		Models:   models,
		Board:    board,
		Signer:   signer,
		Logger:   log,
		Version:  "0.1.0",
		Now:      clock.Now,
	}
	for _, m := range mutate {
		m(&cfg)
	}
	srv := New(cfg)
	ts := httptest.NewServer(srv)
	t.Cleanup(func() {
		srv.BeginShutdown()
		ts.Close()
	})
	return &harness{t: t, srv: srv, ts: ts, clock: clock, board: board, signer: signer, rb: rb, models: models, logs: logs, dir: dir}
}

type response struct {
	status int
	header http.Header
	body   []byte
}

func (r response) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("body is not a JSON object (%d): %s", r.status, r.body)
	}
	return m
}

func (h *harness) do(method, path string, body string, headers map[string]string) response {
	h.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, h.ts.URL+path, rd)
	if err != nil {
		h.t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := h.ts.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return response{res.StatusCode, res.Header, b}
}

func (h *harness) get(path string) response { return h.do(http.MethodGet, path, "", nil) }

func (h *harness) postJSON(path, body string, headers ...string) response {
	hd := map[string]string{"Content-Type": "application/json"}
	for i := 0; i+1 < len(headers); i += 2 {
		hd[headers[i]] = headers[i+1]
	}
	return h.do(http.MethodPost, path, body, hd)
}

// --- the shared fixture ------------------------------------------------------

type fixtureRun struct {
	Name    string          `json:"name"`
	Sectors json.RawMessage `json:"sectors"`
	Expect  *struct {
		Score          int    `json:"score"`
		Integrity      int    `json:"integrity"`
		Rank           string `json:"rank"`
		RankName       string `json:"rankName"`
		SectorsCleared int    `json:"sectorsCleared"`
		ReadinessLevel int    `json:"readinessLevel"`
		Cleared        bool   `json:"cleared"`
	} `json:"expect"`
	Error *struct {
		Field   string `json:"field"`
		Message string `json:"message"`
	} `json:"error"`
}

func fixtureRuns(t *testing.T) []fixtureRun {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "score-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Runs []fixtureRun `json:"runs"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f.Runs
}

// fixtureSectors returns the sectors of the named fixture run.
func fixtureSectors(t *testing.T, prefix string) string {
	t.Helper()
	for _, r := range fixtureRuns(t) {
		if strings.HasPrefix(r.Name, prefix) {
			return string(r.Sectors)
		}
	}
	t.Fatalf("no fixture run %q", prefix)
	return ""
}

func runBody(callsign, sectors string) string {
	cs, _ := json.Marshal(callsign)
	return `{"callsign":` + string(cs) + `,"sectors":` + sectors + `}`
}

// --- server-sent events --------------------------------------------------------

type sseEvent struct {
	name    string
	data    string
	comment string
}

// sseReader reads event blocks from a stream on a goroutine, so tests can
// wait for one with a timeout.
type sseReader struct {
	events chan sseEvent
	done   chan struct{}
}

func readSSE(body io.Reader) *sseReader {
	r := &sseReader{events: make(chan sseEvent, 64), done: make(chan struct{})}
	go func() {
		defer close(r.done)
		br := bufio.NewReader(body)
		var ev sseEvent
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\n")
			switch {
			case line == "":
				r.events <- ev
				ev = sseEvent{}
			case strings.HasPrefix(line, ":"):
				ev.comment += strings.TrimSpace(line[1:])
			case strings.HasPrefix(line, "event:"):
				ev.name = strings.TrimSpace(line[6:])
			case strings.HasPrefix(line, "data:"):
				ev.data += strings.TrimSpace(line[5:])
			}
		}
	}()
	return r
}

// next waits for the next block that has an event name (or, with comments,
// any block).
func (r *sseReader) next(t *testing.T, wantComment bool) sseEvent {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev := <-r.events:
			if ev.name != "" || (wantComment && ev.comment != "") {
				return ev
			}
		case <-r.done:
			select {
			case ev := <-r.events:
				if ev.name != "" || (wantComment && ev.comment != "") {
					return ev
				}
				continue
			default:
			}
			t.Fatal("stream ended")
		case <-timeout:
			t.Fatal("timed out waiting for an event")
		}
	}
}

func (r *sseReader) waitEnd(t *testing.T) {
	t.Helper()
	select {
	case <-r.done:
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not end")
	}
}

// eventually polls cond for up to 3 s.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

var fstestFile404 = fstest.MapFile{Data: []byte("<!doctype html><title>lost in space</title>")}
