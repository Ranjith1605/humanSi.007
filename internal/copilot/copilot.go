// Package copilot talks to a local Ollama server for the SI console.
//
// It lists installed models (GET /api/tags) and streams chat answers
// (POST /api/chat with stream:true, newline-delimited JSON). Every call is
// bound to a context: when the pilot presses Stop, the browser aborts, the
// server's request context ends, and the upstream request to Ollama is
// cancelled with it, so generation really stops instead of running on
// unseen. That is the "human override" the hangar promises.
package copilot

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Ranjith1605/humanSi.007/internal/rulebook"
)

// Defaults from the architecture: a short budget for listing models, a
// long one for a whole streamed answer.
const (
	DefaultTagsTimeout   = 5 * time.Second
	DefaultStreamTimeout = 120 * time.Second
	DefaultTagsCacheTTL  = 10 * time.Second
)

// maxLine bounds one NDJSON line from Ollama; maxTagsBody bounds /api/tags.
const (
	maxLine     = 1 << 20
	maxTagsBody = 4 << 20
)

// Message is one chat turn.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Options configure New. Zero values pick the defaults.
type Options struct {
	TagsTimeout   time.Duration
	StreamTimeout time.Duration
	// TagsCacheTTL is how long a successful model listing is reused.
	// Negative disables the cache.
	TagsCacheTTL time.Duration
	HTTPClient   *http.Client
	Now          func() time.Time
}

// Client is an Ollama client. It is safe for concurrent use.
type Client struct {
	base *url.URL
	hc   *http.Client
	opt  Options

	mu       sync.Mutex
	cached   []string
	cachedAt time.Time
}

// New returns a client for an Ollama base URL such as http://localhost:11434.
func New(baseURL string, opt Options) (*Client, error) {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("copilot: %q is not an http(s) URL", baseURL)
	}
	if u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, fmt.Errorf("copilot: %q must be a plain base URL", baseURL)
	}
	if opt.TagsTimeout <= 0 {
		opt.TagsTimeout = DefaultTagsTimeout
	}
	if opt.StreamTimeout <= 0 {
		opt.StreamTimeout = DefaultStreamTimeout
	}
	if opt.TagsCacheTTL == 0 {
		opt.TagsCacheTTL = DefaultTagsCacheTTL
	}
	if opt.HTTPClient == nil {
		// No client-wide timeout: each call carries its own deadline, and a
		// streamed answer legitimately takes longer than a listing.
		opt.HTTPClient = &http.Client{}
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	return &Client{base: u, hc: opt.HTTPClient, opt: opt}, nil
}

// BaseURL is the configured Ollama address.
func (c *Client) BaseURL() string { return c.base.String() }

func (c *Client) endpoint(p string) string {
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + p
	return u.String()
}

// ErrUnreachable wraps failures to reach Ollama at all.
var ErrUnreachable = errors.New("copilot: Ollama unreachable")

// UpstreamError is a non-200 answer from Ollama.
type UpstreamError struct {
	Status  int
	Message string
}

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("copilot: Ollama answered %d: %s", e.Status, e.Message)
}

func upstreamError(res *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	var e struct {
		Error string `json:"error"`
	}
	msg := strings.TrimSpace(string(body))
	if json.Unmarshal(body, &e) == nil && e.Error != "" {
		msg = e.Error
	}
	return &UpstreamError{Status: res.StatusCode, Message: msg}
}

// Tags lists every model installed on the Ollama server (full tags such as
// "qwen2.5:0.5b"), asking the server each time.
func (c *Client) Tags(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, c.opt.TagsTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("/api/tags"), nil)
	if err != nil {
		return nil, err
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, upstreamError(res)
	}
	var body struct {
		Models []struct {
			Name  string `json:"name"`
			Model string `json:"model"`
		} `json:"models"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxTagsBody)).Decode(&body); err != nil {
		return nil, fmt.Errorf("copilot: unreadable model list: %w", err)
	}
	seen := map[string]bool{}
	var tags []string
	for _, m := range body.Models {
		name := m.Name
		if name == "" {
			name = m.Model
		}
		if name != "" && !seen[name] {
			seen[name] = true
			tags = append(tags, name)
		}
	}
	sort.Strings(tags)
	return tags, nil
}

// Installed is Tags with a short cache, so the status endpoint and every
// console request do not each cost a round trip.
func (c *Client) Installed(ctx context.Context) ([]string, error) {
	if c.opt.TagsCacheTTL > 0 {
		c.mu.Lock()
		if c.cached != nil && c.opt.Now().Sub(c.cachedAt) < c.opt.TagsCacheTTL {
			tags := append([]string(nil), c.cached...)
			c.mu.Unlock()
			return tags, nil
		}
		c.mu.Unlock()
	}
	tags, err := c.Tags(ctx)
	if err != nil {
		return nil, err
	}
	if tags == nil {
		tags = []string{}
	}
	if c.opt.TagsCacheTTL > 0 {
		c.mu.Lock()
		c.cached, c.cachedAt = append([]string(nil), tags...), c.opt.Now()
		c.mu.Unlock()
	}
	return tags, nil
}

// Allowed filters installed tags down to hangar models: a tag qualifies when
// the name before its ":" matches the base name of a hangar model's tag.
func Allowed(models *rulebook.Models, installed []string) []string {
	bases := models.OllamaBases()
	out := []string{}
	for _, tag := range installed {
		if bases[rulebook.BaseName(tag)] {
			out = append(out, tag)
		}
	}
	sort.Strings(out)
	return out
}

// Stream is one answer being generated. Read it with Next; always Close it.
type Stream struct {
	body   io.ReadCloser
	sc     *bufio.Scanner
	cancel context.CancelFunc
	ctx    context.Context

	chunks    int
	evalCount int
	done      bool
}

// StreamError is an error Ollama reported in the middle of an answer.
type StreamError struct{ Message string }

func (e *StreamError) Error() string { return "copilot: model error: " + e.Message }

// ErrIncomplete means the stream ended without Ollama's done marker.
var ErrIncomplete = errors.New("copilot: answer ended before the model finished")

// Chat starts a streamed answer. system is prepended as a system message.
// It returns once Ollama has accepted the request (status 200); an error
// here means nothing was streamed yet. The stream ends at the stream
// timeout or when ctx is cancelled, whichever is first.
func (c *Client) Chat(ctx context.Context, model, system string, messages []Message) (*Stream, error) {
	all := make([]Message, 0, len(messages)+1)
	if system != "" {
		all = append(all, Message{Role: "system", Content: system})
	}
	all = append(all, messages...)
	payload, err := json.Marshal(struct {
		Model    string    `json:"model"`
		Messages []Message `json:"messages"`
		Stream   bool      `json:"stream"`
	}{model, all, true})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, c.opt.StreamTimeout)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint("/api/chat"), bytes.NewReader(payload))
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.hc.Do(req)
	if err != nil {
		// Read the context's state before cancelling it ourselves.
		ctxErr := ctx.Err()
		cancel()
		if ctxErr != nil {
			return nil, ctxErr
		}
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	if res.StatusCode != http.StatusOK {
		defer cancel()
		defer res.Body.Close()
		return nil, upstreamError(res)
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 64<<10), maxLine)
	return &Stream{body: res.Body, sc: sc, cancel: cancel, ctx: ctx}, nil
}

// Next returns the next piece of text. It returns io.EOF after the model's
// done marker, a *StreamError if Ollama reported one, the context's error
// if the stream was cancelled or timed out, or ErrIncomplete.
func (s *Stream) Next() (string, error) {
	if s.done {
		return "", io.EOF
	}
	for s.sc.Scan() {
		line := bytes.TrimSpace(s.sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var chunk struct {
			Message *struct {
				Content string `json:"content"`
			} `json:"message"`
			Done      bool   `json:"done"`
			Error     string `json:"error"`
			EvalCount int    `json:"eval_count"`
		}
		if err := json.Unmarshal(line, &chunk); err != nil {
			return "", fmt.Errorf("copilot: unreadable stream line: %w", err)
		}
		if chunk.Error != "" {
			return "", &StreamError{Message: chunk.Error}
		}
		text := ""
		if chunk.Message != nil {
			text = chunk.Message.Content
		}
		if chunk.Done {
			s.done = true
			s.evalCount = chunk.EvalCount
			if text != "" {
				s.chunks++
				return text, nil
			}
			return "", io.EOF
		}
		if text == "" {
			continue
		}
		s.chunks++
		return text, nil
	}
	if err := s.ctx.Err(); err != nil {
		return "", err
	}
	if err := s.sc.Err(); err != nil {
		return "", fmt.Errorf("copilot: stream read: %w", err)
	}
	return "", ErrIncomplete
}

// Tokens is the model's own token count when it reported one, otherwise
// the number of text chunks streamed so far.
func (s *Stream) Tokens() int {
	if s.evalCount > 0 {
		return s.evalCount
	}
	return s.chunks
}

// Close releases the upstream request; closing early cancels generation.
func (s *Stream) Close() error {
	s.cancel()
	return s.body.Close()
}
