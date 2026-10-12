// Package game validates and scores runs. It is a line-for-line mirror of
// web/js/scoring.js, which is the specification: the browser predicts a
// score with scoring.js, the server recomputes it here, and both are held to
// the shared fixture testdata/score-cases.json so they cannot drift apart.
//
// Validation works on the raw JSON a client sent, not on Go structs, because
// scoring.js judges values with JavaScript semantics: 5.0 and 1e1 are
// integers, "5" and null are not, a missing field is undefined, an array
// passes `typeof r === 'object'`. Decoding into typed structs first would
// either reject runs the browser accepts or accept runs it rejects.
package game

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/Ranjith1605/humanSi.007/internal/rulebook"
)

// Counters lists the per-sector tallies in scoring.js order (COUNTERS).
var Counters = []string{"cores", "chainLinks", "assists", "harmonized", "scans", "reviews", "shortcuts"}

// SectorResult is a validated sector of a run.
type SectorResult struct {
	ID         string `json:"id"`
	Cleared    bool   `json:"cleared"`
	Cores      int    `json:"cores"`
	ChainLinks int    `json:"chainLinks"`
	Assists    int    `json:"assists"`
	Harmonized int    `json:"harmonized"`
	Scans      int    `json:"scans"`
	Reviews    int    `json:"reviews"`
	Shortcuts  int    `json:"shortcuts"`
	Verdicts   []int  `json:"verdicts"`
	TimeMs     int    `json:"timeMs"`
}

func (r *SectorResult) counter(k string) *int {
	switch k {
	case "cores":
		return &r.Cores
	case "chainLinks":
		return &r.ChainLinks
	case "assists":
		return &r.Assists
	case "harmonized":
		return &r.Harmonized
	case "scans":
		return &r.Scans
	case "reviews":
		return &r.Reviews
	case "shortcuts":
		return &r.Shortcuts
	}
	panic("game: unknown counter " + k)
}

// Invalid describes the first problem validateRun finds: the same field and
// message scoring.js returns.
type Invalid struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (e *Invalid) Error() string { return e.Field + ": " + e.Message }

// Caps mirrors sectorCaps: the upper bound of each counter in a sector.
func Caps(sec rulebook.Sector) map[string]int {
	s := sec.Spawn
	pods := s.HumanPods + s.SIPods
	chain := 0
	if pods > 0 {
		chain = pods - 1
	}
	return map[string]int{
		"cores":      s.Cores,
		"chainLinks": chain,
		"assists":    s.Stranded,
		"harmonized": s.Discord,
		"scans":      s.Anomalies,
		"reviews":    s.Satellites,
		"shortcuts":  s.Shortcuts,
	}
}

// ValidateRun mirrors validateRun(rulebook, sectors). sectors is the raw
// JSON value of the run's "sectors" field (nil when the field is absent).
// It returns the typed sectors when valid, or the first problem found.
func ValidateRun(rb *rulebook.Rulebook, sectors json.RawMessage) ([]SectorResult, *Invalid) {
	rules := rb.Scoring
	list, isArray := jsArray(sectors)
	if !isArray || len(list) == 0 {
		return nil, &Invalid{"sectors", "a run needs at least one sector"}
	}
	if len(list) > len(rb.Sectors) {
		return nil, &Invalid{"sectors", "more sectors than the rule book defines"}
	}
	out := make([]SectorResult, len(list))
	for i, raw := range list {
		def := rb.Sectors[i]
		at := fmt.Sprintf("sectors[%d]", i)
		// `!r || typeof r !== 'object'`: null and primitives fail here;
		// arrays are objects in JS and fail on the id check below instead.
		kind := jsTypeOf(raw)
		if kind != "object" && kind != "array" {
			return nil, &Invalid{at, "must be an object"}
		}
		fields := jsObject(raw) // empty for arrays: every property is undefined
		res := &out[i]

		// Sectors are flown in order, so a run is always a prefix of the route.
		id, ok := jsString(fields["id"])
		if !ok || id != def.ID {
			return nil, &Invalid{at + ".id", "expected sector " + def.ID}
		}
		res.ID = id

		cleared, ok := jsBool(fields["cleared"])
		if !ok {
			return nil, &Invalid{at + ".cleared", "must be true or false"}
		}
		res.Cleared = cleared
		// Only the last sector of a run may be uncleared: you can't fly past a gate you never reached.
		if !cleared && i != len(list)-1 {
			return nil, &Invalid{at + ".cleared", "only the final sector of a run may be uncleared"}
		}

		caps := Caps(def)
		for _, k := range Counters {
			v, ok := jsNumber(fields[k])
			if !ok || !isInteger(v) || v < 0 {
				return nil, &Invalid{at + "." + k, "must be a non-negative integer"}
			}
			if v > float64(caps[k]) {
				return nil, &Invalid{at + "." + k, fmt.Sprintf("exceeds the %d this sector holds", caps[k])}
			}
			*res.counter(k) = int(v)
		}

		verdicts, ok := jsArray(fields["verdicts"])
		if !ok || len(verdicts) != len(def.Gate) {
			return nil, &Invalid{at + ".verdicts", fmt.Sprintf("expected %d verdicts", len(def.Gate))}
		}
		res.Verdicts = make([]int, len(verdicts))
		for q, rawA := range verdicts {
			vq := fmt.Sprintf("%s.verdicts[%d]", at, q)
			a, ok := jsNumber(rawA)
			if !ok || !isInteger(a) || a < -1 || a >= float64(len(def.Gate[q].Options)) {
				return nil, &Invalid{vq, "not an option of this scenario"}
			}
			// The gate sits at the end of the sector: an uncleared sector has no verdicts,
			// and a cleared one has a verdict for every scenario.
			if !cleared && a != -1 {
				return nil, &Invalid{vq, "an uncleared sector cannot have verdicts"}
			}
			if cleared && a == -1 {
				return nil, &Invalid{vq, "a cleared gate needs a verdict for every scenario"}
			}
			res.Verdicts[q] = int(a)
		}

		t, ok := jsNumber(fields["timeMs"])
		if !ok || !isInteger(t) || t < 0 || t > float64(rules.MaxSectorTimeMs) {
			return nil, &Invalid{at + ".timeMs", "implausible sector time"}
		}
		if cleared && t < float64(rules.MinSectorTimeMs) {
			return nil, &Invalid{at + ".timeMs", "cleared faster than the sector can be flown"}
		}
		res.TimeMs = int(t)
	}
	return out, nil
}

// CorrectVerdicts mirrors correctVerdicts(def, r).
func CorrectVerdicts(def rulebook.Sector, r SectorResult) int {
	n := 0
	for q, a := range r.Verdicts {
		if q < len(def.Gate) && a == def.Gate[q].Answer {
			n++
		}
	}
	return n
}

// ScoreSector mirrors scoreSector. It assumes the run passed ValidateRun.
func ScoreSector(rb *rulebook.Rulebook, def rulebook.Sector, r SectorResult) int {
	p := rb.Scoring
	clear := 0
	if r.Cleared {
		clear = p.SectorClear
	}
	return r.Cores*p.Core +
		r.ChainLinks*p.ChainLink +
		r.Assists*p.Assist +
		r.Harmonized*p.Harmonize +
		r.Scans*p.Scan +
		r.Reviews*p.Review +
		r.Shortcuts*(p.ShortcutGain-p.ShortcutPenalty) +
		CorrectVerdicts(def, r)*p.CorrectVerdict +
		clear
}

// IntegrityOf mirrors integrityOf: one fixed step down per shortcut, floored at zero.
func IntegrityOf(rb *rulebook.Rulebook, sectors []SectorResult) int {
	taken := 0
	for _, r := range sectors {
		taken += r.Shortcuts
	}
	return max(0, rb.Scoring.IntegrityStart-taken*rb.Scoring.IntegrityPerShortcut)
}

// ReadinessLevel mirrors readinessLevel.
func ReadinessLevel(rb *rulebook.Rulebook, correct int) int {
	levels := rb.Scoring.ReadinessLevels
	level := levels[0].Level
	for _, l := range levels {
		if correct >= l.MinCorrect {
			level = l.Level
		}
	}
	return level
}

// RankFor mirrors rankFor: the last rank whose thresholds are both met.
func RankFor(rb *rulebook.Rulebook, score, integrity int) rulebook.Rank {
	best := rb.Ranks[0]
	for _, r := range rb.Ranks {
		if score >= r.MinScore && integrity >= r.MinIntegrity {
			best = r
		}
	}
	return best
}

// Result is scoreRun's return value.
type Result struct {
	Score           int    `json:"score"`
	PerSector       []int  `json:"perSector"`
	Integrity       int    `json:"integrity"`
	Rank            string `json:"rank"`
	RankName        string `json:"rankName"`
	SectorsCleared  int    `json:"sectorsCleared"`
	CorrectVerdicts int    `json:"correctVerdicts"`
	ReadinessLevel  int    `json:"readinessLevel"`
	Cleared         bool   `json:"cleared"`
}

// ScoreRun mirrors scoreRun for a validated run. The total is floored at
// zero, and Cleared is the minimum rule made playable: every gate flown and
// readiness at or above method.minimumRule.level.
func ScoreRun(rb *rulebook.Rulebook, sectors []SectorResult) Result {
	per := make([]int, len(sectors))
	total, cleared, correct := 0, 0, 0
	for i, r := range sectors {
		per[i] = ScoreSector(rb, rb.Sectors[i], r)
		total += per[i]
		if r.Cleared {
			cleared++
		}
		correct += CorrectVerdicts(rb.Sectors[i], r)
	}
	score := max(0, total)
	integrity := IntegrityOf(rb, sectors)
	rank := RankFor(rb, score, integrity)
	readiness := ReadinessLevel(rb, correct)
	return Result{
		Score:           score,
		PerSector:       per,
		Integrity:       integrity,
		Rank:            rank.ID,
		RankName:        rank.Name,
		SectorsCleared:  cleared,
		CorrectVerdicts: correct,
		ReadinessLevel:  readiness,
		Cleared:         cleared == len(rb.Sectors) && readiness >= rb.Method.MinimumRule.Level,
	}
}

// CallsignPattern is CALLSIGN_PATTERN from scoring.js (RE2 accepts it as is).
var CallsignPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _.-]{1,15}$`)

// NormalizeCallsign mirrors normalizeCallsign for a string: JavaScript's
// trim(), then every run of \s collapsed to one space, then the pattern.
// It returns "" when the result is not a valid callsign.
func NormalizeCallsign(raw string) string {
	c := strings.TrimFunc(raw, isJSSpace)
	var b strings.Builder
	inSpace := false
	for _, r := range c {
		if isJSSpace(r) {
			if !inSpace {
				b.WriteByte(' ')
			}
			inSpace = true
			continue
		}
		inSpace = false
		b.WriteRune(r)
	}
	c = b.String()
	if !CallsignPattern.MatchString(c) {
		return ""
	}
	return c
}

// isJSSpace is JavaScript's \s and String.prototype.trim set: WhiteSpace
// (TAB, VT, FF, SP, NBSP, ZWNBSP and Unicode Zs) plus LineTerminator (LF,
// CR, LS, PS). It differs from unicode.IsSpace on U+0085 (not JS space)
// and U+FEFF (JS space).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// --- JavaScript views of raw JSON values ----------------------------------

// jsTypeOf names a raw JSON value's JS type: "undefined" (absent), "null",
// "boolean", "number", "string", "array" or "object".
func jsTypeOf(raw json.RawMessage) string {
	b := bytes.TrimLeft(raw, " \t\r\n")
	if len(b) == 0 {
		return "undefined"
	}
	switch b[0] {
	case 'n':
		return "null"
	case 't', 'f':
		return "boolean"
	case '"':
		return "string"
	case '[':
		return "array"
	case '{':
		return "object"
	}
	return "number"
}

func jsArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	if jsTypeOf(raw) != "array" {
		return nil, false
	}
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, false
	}
	return list, true
}

// jsObject returns an object's own properties; duplicate keys keep the last
// value, as JSON.parse does. Anything else has no properties.
func jsObject(raw json.RawMessage) map[string]json.RawMessage {
	if jsTypeOf(raw) != "object" {
		return nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m
}

func jsString(raw json.RawMessage) (string, bool) {
	if jsTypeOf(raw) != "string" {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

func jsBool(raw json.RawMessage) (bool, bool) {
	if jsTypeOf(raw) != "boolean" {
		return false, false
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		return false, false
	}
	return v, true
}

// jsNumber parses a JSON number the way JSON.parse does: round to the
// nearest double, and overflow becomes ±Infinity (which is not an integer).
func jsNumber(raw json.RawMessage) (float64, bool) {
	if jsTypeOf(raw) != "number" {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(bytes.TrimSpace(raw)), 64)
	if err != nil && !math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// isInteger is Number.isInteger: finite and without a fractional part.
func isInteger(f float64) bool {
	return !math.IsInf(f, 0) && !math.IsNaN(f) && f == math.Trunc(f)
}
