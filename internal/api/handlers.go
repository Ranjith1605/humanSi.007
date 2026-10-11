package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"

	"github.com/Ranjith1605/humanSi.007/internal/game"
	"github.com/Ranjith1605/humanSi.007/internal/leaderboard"
)

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, struct {
		Status    string `json:"status"`
		Version   string `json:"version"`
		UptimeSec int64  `json:"uptimeSec"`
		Copilot   bool   `json:"copilot"`
	}{"ok", s.cfg.Version, int64(s.now().Sub(s.started).Seconds()), s.cfg.Copilot != nil})
}

// rulebook returns the file exactly as written, not a re-encoding of it.
func (s *Server) rulebook(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(s.cfg.Rulebook.Raw)
	}
}

func (s *Server) leaderboard(w http.ResponseWriter, r *http.Request) {
	limit := 10
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 50 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be a whole number from 1 to 50.", "limit")
			return
		}
		limit = n
	}
	entries, total := s.cfg.Board.Top(limit)
	writeJSON(w, http.StatusOK, struct {
		Entries []leaderboard.Entry `json:"entries"`
		Total   int                 `json:"total"`
	}{entries, total})
}

type clearanceBody struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

// postRun accepts a finished (or abandoned) run, re-scores it, puts it on
// the board and the live feed, and issues launch clearance when the run
// satisfies the minimum rule.
func (s *Server) postRun(w http.ResponseWriter, r *http.Request) {
	if ok, wait := s.runLimiter.Allow(s.clientIP(r)); !ok {
		writeRateLimited(w, wait, "Too many runs from this address. Try again in %d s.")
		return
	}
	fields, ok := readJSONObject(w, r, s.cfg.Limits.MaxRunBody)
	if !ok {
		return
	}

	var raw string
	if err := json.Unmarshal(fields["callsign"], &raw); err != nil || jsonKind(fields["callsign"]) != '"' {
		writeError(w, http.StatusBadRequest, "invalid_callsign", "A callsign is 2–16 letters, digits, spaces, _ . or -, starting with a letter or digit.", "callsign")
		return
	}
	callsign := game.NormalizeCallsign(raw)
	if callsign == "" {
		writeError(w, http.StatusBadRequest, "invalid_callsign", "A callsign is 2–16 letters, digits, spaces, _ . or -, starting with a letter or digit.", "callsign")
		return
	}

	sectors, bad := game.ValidateRun(s.cfg.Rulebook, fields["sectors"])
	if bad != nil {
		writeError(w, http.StatusBadRequest, "invalid_run", bad.Message, bad.Field)
		return
	}
	res := game.ScoreRun(s.cfg.Rulebook, sectors)

	id, err := newID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Could not record the run.", "")
		return
	}
	entry := leaderboard.Entry{
		ID:             id,
		Callsign:       callsign,
		Score:          res.Score,
		Rank:           res.Rank,
		RankName:       res.RankName,
		SectorsCleared: res.SectorsCleared,
		Integrity:      res.Integrity,
		ReadinessLevel: res.ReadinessLevel,
		Cleared:        res.Cleared,
		CreatedAt:      leaderboard.FormatTime(s.now()),
	}
	placement, err := s.cfg.Board.Add(entry)
	if err != nil {
		// The run is on the board and the feed; only the disk copy failed.
		s.log.Error("leaderboard not persisted", "err", err.Error())
	}

	var clr *clearanceBody
	if res.Cleared {
		token, exp, err := s.cfg.Signer.Issue(entry.ID, entry.Callsign)
		if err != nil {
			s.log.Error("clearance not issued", "err", err.Error())
		} else {
			clr = &clearanceBody{Token: token, ExpiresAt: leaderboard.FormatTime(exp)}
		}
	}
	writeJSON(w, http.StatusCreated, struct {
		Entry     leaderboard.Entry `json:"entry"`
		Placement int               `json:"placement"`
		Clearance *clearanceBody    `json:"clearance"`
	}{entry, placement, clr})
}

// newID is 16 random hex characters.
func newID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// readJSONObject enforces the media type and the body limit and decodes a
// JSON object into its raw fields, keyed exactly (JSON.parse semantics:
// case-sensitive keys, the last duplicate wins). On failure it has already
// written the error response.
func readJSONObject(w http.ResponseWriter, r *http.Request, limit int64) (map[string]json.RawMessage, bool) {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Send the body as application/json.", "")
		return nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large", "The request body is too large.", "")
			return nil, false
		}
		writeError(w, http.StatusBadRequest, "invalid_json", "The request body could not be read.", "")
		return nil, false
	}
	var fields map[string]json.RawMessage
	if jsonKind(body) != '{' || json.Unmarshal(body, &fields) != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "The request body is not a JSON object.", "")
		return nil, false
	}
	return fields, true
}

// jsonKind is the first significant byte of a JSON value, 0 if empty.
func jsonKind(raw []byte) byte {
	for _, c := range raw {
		switch c {
		case ' ', '\t', '\r', '\n':
			continue
		}
		return c
	}
	return 0
}
