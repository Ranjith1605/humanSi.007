package copilot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	humansi "github.com/Ranjith1605/humanSi.007"
	"github.com/Ranjith1605/humanSi.007/internal/rulebook"
)

func loadBook(t *testing.T) (*rulebook.Rulebook, *rulebook.Models) {
	t.Helper()
	sub, err := fs.Sub(humansi.Web, "web")
	if err != nil {
		t.Fatal(err)
	}
	rb, models, err := rulebook.Load(sub)
	if err != nil {
		t.Fatal(err)
	}
	return rb, models
}

func newClient(t *testing.T, url string, opt Options) *Client {
	t.Helper()
	c, err := New(url, opt)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestNewValidatesURL(t *testing.T) {
	for _, bad := range []string{"", "localhost:11434", "ftp://x", "http://", "http://u:p@h", "http://h?x=1", "::"} {
		if _, err := New(bad, Options{}); err == nil {
			t.Errorf("New(%q) accepted", bad)
		}
	}
	c := newClient(t, " http://h:1/ollama/ ", Options{})
	if got := c.endpoint("/api/tags"); got != "http://h:1/ollama/api/tags" {
		t.Errorf("endpoint = %q", got)
	}
}

func TestTags(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/tags" {
			http.Error(w, "wrong endpoint", http.StatusNotFound)
			return
		}
		io.WriteString(w, `{"models":[{"name":"qwen2.5:0.5b","size":1},{"model":"phi4:latest"},{"name":"qwen2.5:0.5b"},{"name":""},{"name":"llama3.2:1b"}]}`)
	}))
	defer srv.Close()
	tags, err := newClient(t, srv.URL, Options{}).Tags(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(tags, ","); got != "llama3.2:1b,phi4:latest,qwen2.5:0.5b" {
		t.Errorf("tags = %s", got)
	}
}

func TestTagsFailures(t *testing.T) {
	t.Run("status", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, `{"error":"boom"}`)
		}))
		defer srv.Close()
		_, err := newClient(t, srv.URL, Options{}).Tags(context.Background())
		var ue *UpstreamError
		if !errors.As(err, &ue) || ue.Status != 500 || ue.Message != "boom" {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("garbage", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "<html>") }))
		defer srv.Close()
		if _, err := newClient(t, srv.URL, Options{}).Tags(context.Background()); err == nil {
			t.Fatal("want an error")
		}
	})
	t.Run("unreachable", func(t *testing.T) {
		srv := httptest.NewServer(http.NotFoundHandler())
		url := srv.URL
		srv.Close()
		if _, err := newClient(t, url, Options{}).Tags(context.Background()); !errors.Is(err, ErrUnreachable) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		release := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}))
		defer srv.Close()
		defer close(release)
		start := time.Now()
		_, err := newClient(t, srv.URL, Options{TagsTimeout: 50 * time.Millisecond}).Tags(context.Background())
		if !errors.Is(err, ErrUnreachable) || time.Since(start) > 2*time.Second {
			t.Fatalf("err = %v after %v", err, time.Since(start))
		}
	})
}

func TestInstalledCaches(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		fmt.Fprintf(w, `{"models":[{"name":"m%d:1b"}]}`, n)
	}))
	defer srv.Close()
	now := time.Unix(1000, 0)
	c := newClient(t, srv.URL, Options{TagsCacheTTL: 10 * time.Second, Now: func() time.Time { return now }})
	a, _ := c.Installed(context.Background())
	now = now.Add(9 * time.Second)
	b, _ := c.Installed(context.Background())
	now = now.Add(2 * time.Second)
	d, _ := c.Installed(context.Background())
	if a[0] != "m1:1b" || b[0] != "m1:1b" || d[0] != "m2:1b" || calls.Load() != 2 {
		t.Errorf("a=%v b=%v d=%v calls=%d", a, b, d, calls.Load())
	}
	nocache := newClient(t, srv.URL, Options{TagsCacheTTL: -1})
	nocache.Installed(context.Background())
	nocache.Installed(context.Background())
	if calls.Load() != 4 {
		t.Errorf("cache not disabled: calls=%d", calls.Load())
	}
}

func TestAllowed(t *testing.T) {
	_, models := loadBook(t)
	got := Allowed(models, []string{"qwen2.5:0.5b", "qwen2.5-coder:7b", "llama3.2:latest", "nothangar:1b", "phi4"})
	if strings.Join(got, ",") != "llama3.2:latest,phi4,qwen2.5:0.5b" {
		t.Errorf("allowed = %v", got)
	}
	if got := Allowed(models, nil); got == nil || len(got) != 0 {
		t.Errorf("empty = %#v", got)
	}
}

// fakeChat is an Ollama /api/chat that streams the given lines.
type fakeChat struct {
	lines     []string
	gap       time.Duration
	status    int
	got       atomic.Value // the decoded request
	cancelled chan struct{}
}

func (f *fakeChat) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
		Stream   bool      `json:"stream"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	f.got.Store(req)
	if f.status != 0 {
		w.WriteHeader(f.status)
		io.WriteString(w, `{"error":"model \"x\" not found, try pulling it first"}`)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	for _, l := range f.lines {
		select {
		case <-r.Context().Done():
			if f.cancelled != nil {
				close(f.cancelled)
			}
			return
		case <-time.After(f.gap):
		}
		io.WriteString(w, l+"\n")
		w.(http.Flusher).Flush()
	}
	if f.cancelled != nil {
		// Hold the stream open until the client goes away.
		select {
		case <-r.Context().Done():
			close(f.cancelled)
		case <-time.After(5 * time.Second):
		}
	}
}

func tok(s string) string {
	b, _ := json.Marshal(map[string]any{"model": "m", "message": map[string]string{"role": "assistant", "content": s}, "done": false})
	return string(b)
}

const doneLine = `{"model":"m","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","eval_count":42}`

func drain(s *Stream) (string, error) {
	var b strings.Builder
	for {
		t, err := s.Next()
		if err != nil {
			return b.String(), err
		}
		b.WriteString(t)
	}
}

func TestChatStreams(t *testing.T) {
	f := &fakeChat{lines: []string{tok("Gate "), "", tok(""), tok("G4"), tok(" asks."), doneLine}}
	srv := httptest.NewServer(f)
	defer srv.Close()
	c := newClient(t, srv.URL, Options{})
	s, err := c.Chat(context.Background(), "qwen2.5:0.5b", "SYSTEM", []Message{{"user", "hi"}, {"assistant", "hello"}, {"user", "G4?"}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	text, err := drain(s)
	if err != io.EOF || text != "Gate G4 asks." {
		t.Fatalf("text %q err %v", text, err)
	}
	if s.Tokens() != 42 {
		t.Errorf("tokens = %d, want the model's eval_count", s.Tokens())
	}
	if _, err := s.Next(); err != io.EOF {
		t.Errorf("Next after done = %v", err)
	}
	req := f.got.Load().(struct {
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
		Stream   bool      `json:"stream"`
	})
	if req.Model != "qwen2.5:0.5b" || !req.Stream || len(req.Messages) != 4 ||
		req.Messages[0] != (Message{"system", "SYSTEM"}) || req.Messages[3] != (Message{"user", "G4?"}) {
		t.Errorf("upstream request = %+v", req)
	}
}

func TestChatTokenCountFallsBackToChunks(t *testing.T) {
	srv := httptest.NewServer(&fakeChat{lines: []string{tok("a"), tok("b"), `{"done":true}`}})
	defer srv.Close()
	s, err := newClient(t, srv.URL, Options{}).Chat(context.Background(), "m", "", []Message{{"user", "x"}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	drain(s)
	if s.Tokens() != 2 {
		t.Errorf("tokens = %d", s.Tokens())
	}
}

func TestChatErrors(t *testing.T) {
	cases := []struct {
		name  string
		f     *fakeChat
		check func(t *testing.T, text string, err error)
	}{
		{"error mid-stream", &fakeChat{lines: []string{tok("partial "), `{"error":"out of memory"}`}}, func(t *testing.T, text string, err error) {
			var se *StreamError
			if !errors.As(err, &se) || se.Message != "out of memory" || text != "partial " {
				t.Fatalf("text %q err %v", text, err)
			}
		}},
		{"ends without done", &fakeChat{lines: []string{tok("cut")}}, func(t *testing.T, text string, err error) {
			if !errors.Is(err, ErrIncomplete) {
				t.Fatalf("err = %v", err)
			}
		}},
		{"garbage line", &fakeChat{lines: []string{tok("a"), "{nope"}}, func(t *testing.T, text string, err error) {
			if err == nil || err == io.EOF || !strings.Contains(err.Error(), "unreadable") {
				t.Fatalf("err = %v", err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.f)
			defer srv.Close()
			s, err := newClient(t, srv.URL, Options{}).Chat(context.Background(), "m", "", []Message{{"user", "x"}})
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			text, err := drain(s)
			tc.check(t, text, err)
		})
	}
}

func TestChatUpstreamRefusal(t *testing.T) {
	srv := httptest.NewServer(&fakeChat{status: http.StatusNotFound})
	defer srv.Close()
	_, err := newClient(t, srv.URL, Options{}).Chat(context.Background(), "x", "", []Message{{"user", "x"}})
	var ue *UpstreamError
	if !errors.As(err, &ue) || ue.Status != 404 || !strings.Contains(ue.Message, "not found") {
		t.Fatalf("err = %v", err)
	}
}

func TestChatCancelStopsUpstream(t *testing.T) {
	f := &fakeChat{lines: []string{tok("one "), tok("two ")}, cancelled: make(chan struct{})}
	srv := httptest.NewServer(f)
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	s, err := newClient(t, srv.URL, Options{}).Chat(ctx, "m", "", []Message{{"user", "x"}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if first, err := s.Next(); err != nil || first != "one " {
		t.Fatalf("first = %q, %v", first, err)
	}
	cancel() // the pilot pressed Stop
	select {
	case <-f.cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream request was not cancelled")
	}
	if _, err := drain(s); !errors.Is(err, context.Canceled) {
		t.Errorf("err after cancel = %v", err)
	}
}

func TestChatStreamTimeout(t *testing.T) {
	f := &fakeChat{lines: []string{tok("slow")}, cancelled: make(chan struct{})}
	srv := httptest.NewServer(f)
	defer srv.Close()
	s, err := newClient(t, srv.URL, Options{StreamTimeout: 150 * time.Millisecond}).Chat(context.Background(), "m", "", []Message{{"user", "x"}})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := drain(s); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	select {
	case <-f.cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream not cancelled at the timeout")
	}
}

func TestChatUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	if _, err := newClient(t, url, Options{}).Chat(context.Background(), "m", "", nil); !errors.Is(err, ErrUnreachable) {
		t.Fatalf("err = %v", err)
	}
}

func TestSystemPromptComesFromTheRuleBook(t *testing.T) {
	rb, _ := loadBook(t)
	p := SystemPrompt(rb)
	must := []string{rb.Charter.Mission.Headline, rb.Method.MinimumRule.Text, rb.Disclaimer, rb.Ship,
		"orientation, not legal advice", "say so plainly", "concise", "cite"}
	for _, v := range rb.Charter.Values {
		must = append(must, v.Name)
		for _, a := range v.Articles {
			must = append(must, a.ID+" "+a.Title)
		}
	}
	for _, m := range rb.Method.Modules {
		must = append(must, m.Gate, m.ID, m.Question)
	}
	for _, r := range rb.Method.Integrity {
		must = append(must, r.ID+" "+r.Title)
	}
	for _, v := range rb.Method.Verdicts {
		must = append(must, v.Label)
	}
	for _, s := range must {
		if !strings.Contains(p, s) {
			t.Errorf("prompt is missing %q", s)
		}
	}
	// Compact: the full article texts and the game's scenarios stay out.
	if strings.Contains(p, rb.Charter.Values[0].Articles[0].Text) || strings.Contains(p, rb.Sectors[0].Gate[0].Scenario) {
		t.Error("prompt should not carry full article text or scenarios")
	}
	if len(p) > 6000 {
		t.Errorf("prompt is %d bytes; keep it compact", len(p))
	}
	if regexp.MustCompile(`\b20[2-9]\d\b`).MatchString(p) {
		t.Error("prompt must not contain law application years")
	}
}
