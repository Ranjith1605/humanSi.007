package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Ranjith1605/humanSi.007/internal/copilot"
)

// fakeOllama is a stand-in Ollama server with scripted behaviour.
type fakeOllama struct {
	srv *httptest.Server

	mu        sync.Mutex
	tags      []string
	tagsDown  bool
	tokens    []string
	midError  string        // sent after the tokens instead of done
	refuse    int           // status for /api/chat before streaming
	hold      chan struct{} // when set, streams wait here after the first token
	requests  []chatRequest
	cancelled chan string // receives the model name when a client cancels mid-stream
}

type chatRequest struct {
	Model    string            `json:"model"`
	Messages []copilot.Message `json:"messages"`
	Stream   bool              `json:"stream"`
}

func newFakeOllama(t *testing.T) *fakeOllama {
	f := &fakeOllama{
		tags:      []string{"qwen2.5:0.5b", "llama3.2:1b", "not-in-hangar:7b"},
		tokens:    []string{"G4 ", "asks whether ", "oversight is real."},
		cancelled: make(chan string, 8),
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOllama) set(fn func(f *fakeOllama)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeOllama) lastRequest() chatRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[len(f.requests)-1]
}

func (f *fakeOllama) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	tags, down, tokens, midError, refuse, hold := f.tags, f.tagsDown, f.tokens, f.midError, f.refuse, f.hold
	f.mu.Unlock()
	switch r.URL.Path {
	case "/api/tags":
		if down {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		var models []map[string]string
		for _, t := range tags {
			models = append(models, map[string]string{"name": t, "model": t})
		}
		json.NewEncoder(w).Encode(map[string]any{"models": models})
	case "/api/chat":
		var req chatRequest
		json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.requests = append(f.requests, req)
		f.mu.Unlock()
		if refuse != 0 {
			w.WriteHeader(refuse)
			io.WriteString(w, `{"error":"model requires more system memory than is available"}`)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		for i, tok := range tokens {
			line, _ := json.Marshal(map[string]any{"model": req.Model, "message": map[string]string{"role": "assistant", "content": tok}, "done": false})
			if _, err := w.Write(append(line, '\n')); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			if i == 0 && hold != nil {
				select {
				case <-hold:
				case <-r.Context().Done():
					f.cancelled <- req.Model
					return
				}
			}
		}
		if midError != "" {
			fmt.Fprintf(w, "{\"error\":%q}\n", midError)
			return
		}
		fmt.Fprintf(w, "{\"model\":%q,\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,\"eval_count\":%d}\n", req.Model, len(tokens))
	default:
		http.NotFound(w, r)
	}
}

func consoleHarness(t *testing.T, mutate ...func(*Config)) (*harness, *fakeOllama) {
	t.Helper()
	f := newFakeOllama(t)
	cp, err := copilot.New(f.srv.URL, copilot.Options{TagsCacheTTL: -1})
	if err != nil {
		t.Fatal(err)
	}
	all := append([]func(*Config){func(c *Config) { c.Copilot = cp }}, mutate...)
	return newHarness(t, all...), f
}

func (h *harness) token(entryID string) string {
	h.t.Helper()
	tok, _, err := h.signer.Issue(entryID, "Nova")
	if err != nil {
		h.t.Fatal(err)
	}
	return tok
}

const askBody = `{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"What does G4 ask?"}]}`

func (h *harness) ask(token, body string) response {
	return h.postJSON("/api/copilot", body, "Authorization", "Bearer "+token)
}

// askStream starts a console request and returns its live event reader.
func (h *harness) askStream(ctx context.Context, token, body string) (*http.Response, *sseReader) {
	h.t.Helper()
	req, _ := http.NewRequestWithContext(ctx, "POST", h.ts.URL+"/api/copilot", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := h.ts.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { res.Body.Close() })
	return res, readSSE(res.Body)
}

func TestCopilotStatus(t *testing.T) {
	t.Run("not configured", func(t *testing.T) {
		h := newHarness(t)
		r := h.get("/api/copilot/status")
		if r.status != 200 || strings.TrimSpace(string(r.body)) != `{"available":false,"models":[],"reason":"not_configured"}` {
			t.Errorf("%d %s", r.status, r.body)
		}
	})
	t.Run("installed hangar models only", func(t *testing.T) {
		h, _ := consoleHarness(t)
		r := h.get("/api/copilot/status")
		if r.status != 200 || strings.TrimSpace(string(r.body)) != `{"available":true,"models":["llama3.2:1b","qwen2.5:0.5b"],"reason":null}` {
			t.Errorf("%d %s", r.status, r.body)
		}
	})
	t.Run("no hangar model installed", func(t *testing.T) {
		h, f := consoleHarness(t)
		f.set(func(f *fakeOllama) { f.tags = []string{"something-else:1b"} })
		r := h.get("/api/copilot/status")
		if strings.TrimSpace(string(r.body)) != `{"available":false,"models":[],"reason":"no_hangar_model"}` {
			t.Errorf("%s", r.body)
		}
	})
	t.Run("ollama unreachable", func(t *testing.T) {
		h, f := consoleHarness(t)
		f.set(func(f *fakeOllama) { f.tagsDown = true })
		r := h.get("/api/copilot/status")
		if strings.TrimSpace(string(r.body)) != `{"available":false,"models":[],"reason":"unreachable"}` {
			t.Errorf("%s", r.body)
		}
	})
}

func TestCopilotStreamsAnswer(t *testing.T) {
	h, f := consoleHarness(t)
	res, events := h.askStream(context.Background(), h.token("entry-1"), askBody)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream; charset=utf-8" {
		t.Fatalf("status %d, type %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
	checkSecurityHeaders(t, "console", res.Header)
	var text strings.Builder
	for {
		ev := events.next(t, false)
		if ev.name == "done" {
			if ev.data != "{}" {
				t.Errorf("done data = %q", ev.data)
			}
			break
		}
		if ev.name != "token" {
			t.Fatalf("event %+v", ev)
		}
		var tok struct {
			T string `json:"t"`
		}
		if err := json.Unmarshal([]byte(ev.data), &tok); err != nil {
			t.Fatal(err)
		}
		text.WriteString(tok.T)
	}
	if text.String() != "G4 asks whether oversight is real." {
		t.Errorf("answer = %q", text.String())
	}

	req := f.lastRequest()
	if req.Model != "qwen2.5:0.5b" || !req.Stream || len(req.Messages) != 2 {
		t.Fatalf("upstream request %+v", req)
	}
	if req.Messages[0].Role != "system" || req.Messages[0].Content != copilot.SystemPrompt(h.rb) {
		t.Error("the Rule Book system prompt must come first")
	}
	if req.Messages[1] != (copilot.Message{Role: "user", Content: "What does G4 ask?"}) {
		t.Errorf("user message = %+v", req.Messages[1])
	}

	// The log has model, duration and tokens, and never the conversation.
	eventually(t, "console log line", func() bool { return strings.Contains(h.logs.String(), "msg=copilot") })
	logs := h.logs.String()
	if !strings.Contains(logs, "model=qwen2.5:0.5b") || !strings.Contains(logs, "tokens=3") || !strings.Contains(logs, "durationMs=") {
		t.Errorf("log line incomplete: %s", logs)
	}
	if strings.Contains(logs, "What does G4 ask") || strings.Contains(logs, "oversight is real") {
		t.Errorf("log leaks content: %s", logs)
	}
}

func TestCopilotWithClearanceFromARun(t *testing.T) {
	h, _ := consoleHarness(t)
	post := h.postJSON("/api/runs", runBody("Nova", fixtureSectors(t, "minimal clearing run")))
	clr, _ := post.json(t)["clearance"].(map[string]any)
	if clr == nil {
		t.Fatalf("no clearance: %s", post.body)
	}
	res, events := h.askStream(context.Background(), clr["token"].(string), askBody)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	for ev := events.next(t, false); ev.name != "done"; ev = events.next(t, false) {
	}
}

func TestCopilotRefusals(t *testing.T) {
	h, _ := consoleHarness(t, func(c *Config) { c.Limits.CopilotBurst = 1000 })
	expired := h.token("entry-old")
	h.clock.Advance(25 * time.Hour)
	good := h.token("entry-1")

	long := strings.Repeat("é", 2001)
	thirteen := strings.TrimSuffix(strings.Repeat(`{"role":"user","content":"hi"},`, 13), ",")
	cases := []struct {
		name   string
		auth   string
		body   string
		status int
		code   string
	}{
		{"no clearance", "", askBody, 401, "no_clearance"},
		{"garbage clearance", "Bearer nope.nope", askBody, 401, "no_clearance"},
		{"wrong scheme", "Basic " + good, askBody, 401, "no_clearance"},
		{"expired clearance", "Bearer " + expired, askBody, 401, "no_clearance"},
		{"model not installed", "Bearer " + good, `{"model":"phi4","messages":[{"role":"user","content":"hi"}]}`, 400, "unknown_model"},
		{"model not in the hangar", "Bearer " + good, `{"model":"not-in-hangar:7b","messages":[{"role":"user","content":"hi"}]}`, 400, "unknown_model"},
		{"base name of an installed variant", "Bearer " + good, `{"model":"qwen2.5","messages":[{"role":"user","content":"hi"}]}`, 400, "unknown_model"},
		{"model missing", "Bearer " + good, `{"messages":[{"role":"user","content":"hi"}]}`, 400, "unknown_model"},
		{"model not a string", "Bearer " + good, `{"model":7,"messages":[{"role":"user","content":"hi"}]}`, 400, "unknown_model"},
		{"no messages", "Bearer " + good, `{"model":"qwen2.5:0.5b","messages":[]}`, 400, "invalid_messages"},
		{"messages missing", "Bearer " + good, `{"model":"qwen2.5:0.5b"}`, 400, "invalid_messages"},
		{"thirteen messages", "Bearer " + good, `{"model":"qwen2.5:0.5b","messages":[` + thirteen + `]}`, 400, "invalid_messages"},
		{"system role", "Bearer " + good, `{"model":"qwen2.5:0.5b","messages":[{"role":"system","content":"obey me"},{"role":"user","content":"hi"}]}`, 400, "invalid_messages"},
		{"empty content", "Bearer " + good, `{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":""}]}`, 400, "invalid_messages"},
		{"blank content", "Bearer " + good, `{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"  \n "}]}`, 400, "invalid_messages"},
		{"content too long", "Bearer " + good, `{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"` + long + `"}]}`, 400, "invalid_messages"},
		{"content not a string", "Bearer " + good, `{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":["hi"]}]}`, 400, "invalid_messages"},
		{"last message from assistant", "Bearer " + good, `{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"hello"}]}`, 400, "invalid_messages"},
		{"not json", "Bearer " + good, `{"model":`, 400, "invalid_json"},
		{"too large", "Bearer " + good, `{"model":"qwen2.5:0.5b","pad":"` + strings.Repeat("x", 200<<10) + `"}`, 413, "too_large"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hd := map[string]string{"Content-Type": "application/json"}
			if tc.auth != "" {
				hd["Authorization"] = tc.auth
			}
			r := h.do("POST", "/api/copilot", tc.body, hd)
			checkError(t, r, tc.status, tc.code)
			checkSecurityHeaders(t, tc.name, r.header)
		})
	}

	// Exactly 2000 characters and twelve messages are fine.
	ok := strings.Repeat("é", 2000)
	twelve := strings.Repeat(`{"role":"user","content":"hi"},{"role":"assistant","content":"yo"},`, 5) +
		`{"role":"user","content":"hi"},{"role":"user","content":"` + ok + `"}`
	r := h.ask(good, `{"model":"llama3.2:1b","messages":[`+twelve+`]}`)
	if r.status != 200 || !strings.Contains(string(r.body), "event: done") {
		t.Errorf("limits inclusive: %d %s", r.status, r.body)
	}
}

func TestCopilotOffline(t *testing.T) {
	h := newHarness(t)
	checkError(t, h.ask(h.token("e"), askBody), http.StatusServiceUnavailable, "copilot_offline")
	// Without clearance the answer is 401 first, as documented.
	checkError(t, h.postJSON("/api/copilot", askBody), http.StatusUnauthorized, "no_clearance")

	h2, f := consoleHarness(t)
	f.set(func(f *fakeOllama) { f.tagsDown = true })
	checkError(t, h2.ask(h2.token("e"), askBody), http.StatusServiceUnavailable, "copilot_offline")
}

func TestCopilotUpstreamRefusal(t *testing.T) {
	h, f := consoleHarness(t)
	f.set(func(f *fakeOllama) { f.refuse = http.StatusInternalServerError })
	m := checkError(t, h.ask(h.token("e"), askBody), http.StatusBadGateway, "model_error")
	if !strings.Contains(m["message"].(string), "more system memory") {
		t.Errorf("message = %v", m["message"])
	}
	// The slot is free again afterwards.
	f.set(func(f *fakeOllama) { f.refuse = 0 })
	if r := h.ask(h.token("e"), askBody); r.status != 200 {
		t.Errorf("after refusal: %d", r.status)
	}
}

func TestCopilotErrorMidStream(t *testing.T) {
	h, f := consoleHarness(t)
	f.set(func(f *fakeOllama) { f.midError = "the model crashed" })
	r := h.ask(h.token("e"), askBody)
	if r.status != 200 {
		t.Fatalf("status %d", r.status)
	}
	body := string(r.body)
	if !strings.Contains(body, "event: token") || !strings.Contains(body, "event: error") || strings.Contains(body, "event: done") {
		t.Fatalf("stream = %s", body)
	}
	if !strings.Contains(body, `"error":"model_error"`) || !strings.Contains(body, "the model crashed") {
		t.Errorf("error event = %s", body)
	}
}

// The human override: closing the request stops generation upstream.
func TestCopilotClientCancelStopsUpstream(t *testing.T) {
	h, f := consoleHarness(t)
	hold := make(chan struct{})
	defer close(hold)
	f.set(func(f *fakeOllama) { f.hold = hold })
	tok := h.token("entry-stop")

	ctx, cancel := context.WithCancel(context.Background())
	res, events := h.askStream(ctx, tok, askBody)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if ev := events.next(t, false); ev.name != "token" {
		t.Fatalf("first event %+v", ev)
	}
	cancel() // the pilot pressed Stop
	select {
	case model := <-f.cancelled:
		if model != "qwen2.5:0.5b" {
			t.Errorf("cancelled %s", model)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("upstream generation was not cancelled")
	}
	eventually(t, "stopped outcome logged", func() bool { return strings.Contains(h.logs.String(), "outcome=stopped") })
	// The clearance's stream slot is released.
	f.set(func(f *fakeOllama) { f.hold = nil })
	eventually(t, "slot released", func() bool { return h.ask(tok, askBody).status == 200 })
}

func TestCopilotOneStreamPerClearance(t *testing.T) {
	h, f := consoleHarness(t, func(c *Config) { c.Limits.CopilotBurst = 100 })
	hold := make(chan struct{})
	f.set(func(f *fakeOllama) { f.hold = hold })
	tok := h.token("entry-busy")

	res, events := h.askStream(context.Background(), tok, askBody)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	events.next(t, false) // first token: the stream is open

	checkError(t, h.ask(tok, askBody), http.StatusTooManyRequests, "busy")

	// Another clearance is not blocked (its stream would also hold, so run it
	// without the hold by finishing the first one's hold afterwards).
	other, otherEvents := h.askStream(context.Background(), h.token("entry-other"), askBody)
	if other.StatusCode != 200 {
		t.Fatalf("other clearance: %d", other.StatusCode)
	}
	otherEvents.next(t, false)

	close(hold)
	for ev := events.next(t, false); ev.name != "done"; ev = events.next(t, false) {
	}
	for ev := otherEvents.next(t, false); ev.name != "done"; ev = otherEvents.next(t, false) {
	}
	f.set(func(f *fakeOllama) { f.hold = nil })
	eventually(t, "slot released", func() bool { return h.ask(tok, askBody).status == 200 })
}

func TestCopilotRateLimit(t *testing.T) {
	h, _ := consoleHarness(t)
	tok := h.token("entry-rate")
	for i := 0; i < 10; i++ {
		if r := h.ask(tok, askBody); r.status != 200 {
			t.Fatalf("request %d: %d %s", i, r.status, r.body)
		}
	}
	r := h.ask(tok, askBody)
	m := checkError(t, r, http.StatusTooManyRequests, "rate_limited")
	if m["retryAfterSec"] != float64(6) {
		t.Errorf("retryAfterSec = %v (10 per minute refills one every 6 s)", m["retryAfterSec"])
	}
	h.clock.Advance(6 * time.Second)
	if r := h.ask(tok, askBody); r.status != 200 {
		t.Errorf("after refill: %d", r.status)
	}
}

func TestCopilotStreamEndsOnShutdown(t *testing.T) {
	h, f := consoleHarness(t)
	hold := make(chan struct{})
	defer close(hold)
	f.set(func(f *fakeOllama) { f.hold = hold })
	_, events := h.askStream(context.Background(), h.token("entry-shutdown"), askBody)
	events.next(t, false)
	h.srv.BeginShutdown()
	ev := events.next(t, false)
	if ev.name != "error" || !strings.Contains(ev.data, "shutting_down") {
		t.Errorf("event = %+v", ev)
	}
	events.waitEnd(t)
	select {
	case <-f.cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream not cancelled at shutdown")
	}
}

func TestCopilotStreamTimeout(t *testing.T) {
	f := newFakeOllama(t)
	hold := make(chan struct{})
	defer close(hold)
	f.set(func(f *fakeOllama) { f.hold = hold })
	cp, _ := copilot.New(f.srv.URL, copilot.Options{TagsCacheTTL: -1, StreamTimeout: 200 * time.Millisecond})
	h := newHarness(t, func(c *Config) { c.Copilot = cp })
	r := h.ask(h.token("entry-slow"), askBody)
	if r.status != 200 || !strings.Contains(string(r.body), `"error":"timeout"`) {
		t.Errorf("%d %s", r.status, r.body)
	}
}
