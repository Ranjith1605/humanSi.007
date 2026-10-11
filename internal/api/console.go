package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Ranjith1605/humanSi.007/internal/clearance"
	"github.com/Ranjith1605/humanSi.007/internal/copilot"
)

// Message limits from the architecture.
const (
	maxMessages    = 12
	maxMessageLen  = 2000 // characters (code points)
	maxUpstreamMsg = 200  // how much of an Ollama error to pass on
)

// copilotStatus reports which hangar models the console can run right now.
// reason is null when available, else not_configured, unreachable or
// no_hangar_model.
func (s *Server) copilotStatus(w http.ResponseWriter, r *http.Request) {
	type status struct {
		Available bool     `json:"available"`
		Models    []string `json:"models"`
		Reason    *string  `json:"reason"`
	}
	reason := func(r string) *string { return &r }
	if s.cfg.Copilot == nil {
		writeJSON(w, http.StatusOK, status{false, []string{}, reason("not_configured")})
		return
	}
	installed, err := s.cfg.Copilot.Installed(r.Context())
	if err != nil {
		s.log.Warn("copilot status: Ollama not reachable", "err", err.Error())
		writeJSON(w, http.StatusOK, status{false, []string{}, reason("unreachable")})
		return
	}
	allowed := copilot.Allowed(s.cfg.Models, installed)
	if len(allowed) == 0 {
		writeJSON(w, http.StatusOK, status{false, allowed, reason("no_hangar_model")})
		return
	}
	writeJSON(w, http.StatusOK, status{true, allowed, nil})
}

// copilotChat relays one question to the local model and streams the
// answer back as server-sent events. Order of checks: rate limit, clearance
// (401), console configured (503), body, messages (400), model (400),
// one stream per clearance (429).
func (s *Server) copilotChat(w http.ResponseWriter, r *http.Request) {
	if ok, wait := s.copilotLimiter.Allow(s.clientIP(r)); !ok {
		writeRateLimited(w, wait, "Too many console requests from this address. Try again in %d s.")
		return
	}
	claims, err := s.cfg.Signer.Verify(bearerToken(r))
	if err != nil {
		msg := "Clear the Six Gates on the fleet server to open the console."
		if errors.Is(err, clearance.ErrExpired) {
			msg = "Your launch clearance has expired. Fly the Six Gates again to renew it."
		}
		writeError(w, http.StatusUnauthorized, "no_clearance", msg, "")
		return
	}
	if s.cfg.Copilot == nil {
		writeError(w, http.StatusServiceUnavailable, "copilot_offline", "No open-source model is connected to this server.", "")
		return
	}
	fields, ok := readJSONObject(w, r, s.cfg.Limits.MaxCopilotBody)
	if !ok {
		return
	}
	var model string
	if err := json.Unmarshal(fields["model"], &model); err != nil || jsonKind(fields["model"]) != '"' || model == "" {
		writeError(w, http.StatusBadRequest, "unknown_model", "Pick a model from the hangar that is installed on this server.", "model")
		return
	}
	msgs, problem := parseMessages(fields["messages"])
	if problem != "" {
		writeError(w, http.StatusBadRequest, "invalid_messages", problem, "messages")
		return
	}
	installed, err := s.cfg.Copilot.Installed(r.Context())
	if err != nil {
		s.log.Warn("copilot: Ollama not reachable", "err", err.Error())
		writeError(w, http.StatusServiceUnavailable, "copilot_offline", "The model server is not reachable right now.", "")
		return
	}
	if !contains(copilot.Allowed(s.cfg.Models, installed), model) {
		writeError(w, http.StatusBadRequest, "unknown_model", "Pick a model from the hangar that is installed on this server.", "model")
		return
	}
	if !s.acquireStream(claims.EntryID) {
		writeError(w, http.StatusTooManyRequests, "busy", "One console answer at a time per clearance. Stop the current one first.", "")
		return
	}
	defer s.releaseStream(claims.EntryID)

	// The answer stops when the pilot stops it (request context), when the
	// server shuts down, or at the client's stream timeout.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stopOnShutdown := context.AfterFunc(s.ctx, cancel)
	defer stopOnShutdown()

	start := time.Now()
	outcome, tokens := "done", 0
	defer func() {
		// Model, duration and size only: never the messages or the answer.
		s.log.Info("copilot", "model", model, "durationMs", time.Since(start).Milliseconds(),
			"tokens", tokens, "outcome", outcome)
	}()

	stream, err := s.cfg.Copilot.Chat(ctx, model, s.prompt, msgs)
	if err != nil {
		outcome = s.classify(r, err)
		var ue *copilot.UpstreamError
		switch {
		case outcome == "stopped":
			// The client is gone; there is nobody to answer.
		case outcome == "shutdown":
			writeError(w, http.StatusServiceUnavailable, "shutting_down", "The server is shutting down.", "")
		case outcome == "timeout":
			writeError(w, http.StatusGatewayTimeout, "timeout", "The model did not start answering in time.", "")
		case errors.As(err, &ue):
			writeError(w, http.StatusBadGateway, "model_error", "The model server refused: "+clip(ue.Message), "")
		default:
			writeError(w, http.StatusServiceUnavailable, "copilot_offline", "The model server is not reachable right now.", "")
		}
		return
	}
	defer stream.Close()

	sse := startSSE(w, s.cfg.Limits.SSEWriteTimeout)
	defer sse.close()
	for {
		text, err := stream.Next()
		tokens = stream.Tokens()
		if err == nil {
			if sse.event("token", struct {
				T string `json:"t"`
			}{text}) != nil {
				outcome = "stopped" // the client went away mid-answer
				return
			}
			continue
		}
		if errors.Is(err, io.EOF) {
			_ = sse.event("done", struct{}{})
			return
		}
		outcome = s.classify(r, err)
		var se *copilot.StreamError
		switch {
		case outcome == "stopped":
			return
		case outcome == "shutdown":
			_ = sse.event("error", apiError{Error: "shutting_down", Message: "The server is shutting down."})
		case outcome == "timeout":
			_ = sse.event("error", apiError{Error: "timeout", Message: "The answer took too long and was cut off."})
		case errors.As(err, &se):
			_ = sse.event("error", apiError{Error: "model_error", Message: "The model stopped with an error: " + clip(se.Message)})
		default:
			_ = sse.event("error", apiError{Error: "model_error", Message: "The model's answer broke off."})
		}
		return
	}
}

// classify names why a stream ended early, for the response and the log.
func (s *Server) classify(r *http.Request, err error) string {
	switch {
	case s.ctx.Err() != nil:
		return "shutdown"
	case r.Context().Err() != nil:
		return "stopped"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	return "model_error"
}

func (s *Server) acquireStream(id string) bool {
	s.streamsMu.Lock()
	defer s.streamsMu.Unlock()
	if s.streams[id] {
		return false
	}
	s.streams[id] = true
	return true
}

func (s *Server) releaseStream(id string) {
	s.streamsMu.Lock()
	defer s.streamsMu.Unlock()
	delete(s.streams, id)
}

func bearerToken(r *http.Request) string {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

// parseMessages checks 1–12 messages, each a user or assistant turn of
// 1–2000 characters that is not only whitespace, ending with the user.
// Only role and content are kept; anything else a client adds is dropped.
func parseMessages(raw json.RawMessage) ([]copilot.Message, string) {
	var items []map[string]json.RawMessage
	if jsonKind(raw) != '[' || json.Unmarshal(raw, &items) != nil {
		return nil, "messages must be a list of {role, content} objects."
	}
	if len(items) < 1 || len(items) > maxMessages {
		return nil, fmt.Sprintf("Send between 1 and %d messages.", maxMessages)
	}
	out := make([]copilot.Message, len(items))
	for i, it := range items {
		var role, content string
		if jsonKind(it["role"]) != '"' || json.Unmarshal(it["role"], &role) != nil || (role != "user" && role != "assistant") {
			return nil, fmt.Sprintf("Message %d needs the role user or assistant.", i+1)
		}
		if jsonKind(it["content"]) != '"' || json.Unmarshal(it["content"], &content) != nil {
			return nil, fmt.Sprintf("Message %d needs text content.", i+1)
		}
		if n := utf8.RuneCountInString(content); n < 1 || n > maxMessageLen || strings.TrimSpace(content) == "" {
			return nil, fmt.Sprintf("Message %d must be 1 to %d characters.", i+1, maxMessageLen)
		}
		out[i] = copilot.Message{Role: role, Content: content}
	}
	if out[len(out)-1].Role != "user" {
		return nil, "The last message must be the pilot's."
	}
	return out, ""
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func clip(s string) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) <= maxUpstreamMsg {
		return s
	}
	r := []rune(s)
	return string(r[:maxUpstreamMsg]) + "…"
}
