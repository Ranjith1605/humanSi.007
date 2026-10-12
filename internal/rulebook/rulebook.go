// Package rulebook loads the Rule Book (data/rulebook.json) and the Model
// Hangar catalog (data/models.json) from the site's file system and checks
// that they hold together before the server starts.
//
// The JSON files are the single source of every rule and every line of text.
// This package only gives the server a typed view of the parts it computes
// with (scoring, ranks, sectors, the minimum rule, the hangar's Ollama tags)
// and keeps the original bytes so GET /api/rulebook can return the file
// exactly as written. Unknown fields are allowed: the front end may read
// fields the server never needs.
package rulebook

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strings"
)

// Paths inside the site file system (the embedded web/ directory).
const (
	RulebookPath = "data/rulebook.json"
	ModelsPath   = "data/models.json"
)

// Rulebook is the typed part of rulebook.json. Raw holds the file as read.
type Rulebook struct {
	Raw []byte `json:"-"`

	SchemaVersion int      `json:"schemaVersion"`
	Title         string   `json:"title"`
	Subtitle      string   `json:"subtitle"`
	Ship          string   `json:"ship"`
	Disclaimer    string   `json:"disclaimer"`
	Charter       Charter  `json:"charter"`
	Method        Method   `json:"method"`
	Scoring       Scoring  `json:"scoring"`
	Ranks         []Rank   `json:"ranks"`
	Sectors       []Sector `json:"sectors"`
}

type Charter struct {
	Mission Statement `json:"mission"`
	Vision  Statement `json:"vision"`
	Oath    Statement `json:"oath"`
	Values  []Value   `json:"values"`
}

type Statement struct {
	Headline string `json:"headline"`
	Body     string `json:"body"`
}

type Value struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Summary  string    `json:"summary"`
	Articles []Article `json:"articles"`
}

type Article struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Text  string `json:"text"`
}

type Method struct {
	Name        string          `json:"name"`
	Summary     string          `json:"summary"`
	Verdicts    []Verdict       `json:"verdicts"`
	MinimumRule MinimumRule     `json:"minimumRule"`
	Integrity   []IntegrityRule `json:"integrity"`
	Modules     []Module        `json:"modules"`
}

type Verdict struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Meaning string `json:"meaning"`
}

type MinimumRule struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
}

type IntegrityRule struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Text  string `json:"text"`
}

type Module struct {
	ID       string   `json:"id"`
	Gate     string   `json:"gate"`
	Name     string   `json:"name"`
	Question string   `json:"question"`
	Anchor   string   `json:"anchor"`
	Articles []string `json:"articles"`
}

// Scoring mirrors rulebook.scoring; every weight is an integer.
type Scoring struct {
	Core                 int              `json:"core"`
	ChainLink            int              `json:"chainLink"`
	Assist               int              `json:"assist"`
	Harmonize            int              `json:"harmonize"`
	Scan                 int              `json:"scan"`
	Review               int              `json:"review"`
	ShortcutGain         int              `json:"shortcutGain"`
	ShortcutPenalty      int              `json:"shortcutPenalty"`
	CorrectVerdict       int              `json:"correctVerdict"`
	SectorClear          int              `json:"sectorClear"`
	IntegrityStart       int              `json:"integrityStart"`
	IntegrityPerShortcut int              `json:"integrityPerShortcut"`
	MinSectorTimeMs      int              `json:"minSectorTimeMs"`
	MaxSectorTimeMs      int              `json:"maxSectorTimeMs"`
	ReadinessLevels      []ReadinessLevel `json:"readinessLevels"`
}

type ReadinessLevel struct {
	Level      int `json:"level"`
	MinCorrect int `json:"minCorrect"`
}

type Rank struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	MinScore     int    `json:"minScore"`
	MinIntegrity int    `json:"minIntegrity"`
}

type Sector struct {
	ID       string     `json:"id"`
	ModuleID string     `json:"moduleId"`
	Name     string     `json:"name"`
	Mechanic string     `json:"mechanic"`
	Spawn    Spawn      `json:"spawn"`
	Gate     []Scenario `json:"gate"`
}

type Spawn struct {
	Cores      int `json:"cores"`
	HumanPods  int `json:"humanPods"`
	SIPods     int `json:"siPods"`
	Stranded   int `json:"stranded"`
	Discord    int `json:"discord"`
	Anomalies  int `json:"anomalies"`
	Satellites int `json:"satellites"`
	Shortcuts  int `json:"shortcuts"`
	Drift      int `json:"drift"`
}

type Scenario struct {
	Scenario string   `json:"scenario"`
	Options  []string `json:"options"`
	Answer   int      `json:"answer"`
	Cites    []string `json:"cites"`
	Explain  string   `json:"explain"`
}

// Models is the typed part of models.json.
type Models struct {
	Raw []byte `json:"-"`

	SchemaVersion int     `json:"schemaVersion"`
	Title         string  `json:"title"`
	Models        []Model `json:"models"`
}

type Model struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Publisher string `json:"publisher"`
	Openness  string `json:"openness"`
	Ollama    string `json:"ollama"`
}

// Load reads and validates both files from fsys (the site root).
func Load(fsys fs.FS) (*Rulebook, *Models, error) {
	rb, err := LoadRulebook(fsys)
	if err != nil {
		return nil, nil, err
	}
	m, err := LoadModels(fsys)
	if err != nil {
		return nil, nil, err
	}
	return rb, m, nil
}

// LoadRulebook reads data/rulebook.json from fsys and validates it.
func LoadRulebook(fsys fs.FS) (*Rulebook, error) {
	raw, err := fs.ReadFile(fsys, RulebookPath)
	if err != nil {
		return nil, fmt.Errorf("rule book: %w", err)
	}
	return ParseRulebook(raw)
}

// ParseRulebook decodes and validates rule book bytes.
func ParseRulebook(raw []byte) (*Rulebook, error) {
	var rb Rulebook
	if err := decodeOne(raw, &rb); err != nil {
		return nil, fmt.Errorf("rule book %s: %w", RulebookPath, err)
	}
	rb.Raw = raw
	if err := rb.validate(); err != nil {
		return nil, fmt.Errorf("rule book %s: %w", RulebookPath, err)
	}
	return &rb, nil
}

// LoadModels reads data/models.json from fsys and validates it.
func LoadModels(fsys fs.FS) (*Models, error) {
	raw, err := fs.ReadFile(fsys, ModelsPath)
	if err != nil {
		return nil, fmt.Errorf("model catalog: %w", err)
	}
	return ParseModels(raw)
}

// ParseModels decodes and validates model catalog bytes.
func ParseModels(raw []byte) (*Models, error) {
	var m Models
	if err := decodeOne(raw, &m); err != nil {
		return nil, fmt.Errorf("model catalog %s: %w", ModelsPath, err)
	}
	m.Raw = raw
	if err := m.validate(); err != nil {
		return nil, fmt.Errorf("model catalog %s: %w", ModelsPath, err)
	}
	return &m, nil
}

// decodeOne decodes one JSON value and rejects trailing data. Unknown
// fields are fine; a wrong type (a fractional weight, say) is not.
func decodeOne(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if dec.More() {
		return errors.New("invalid JSON: trailing data after the top-level value")
	}
	return nil
}

func (rb *Rulebook) validate() error {
	var errs []error
	bad := func(format string, args ...any) { errs = append(errs, fmt.Errorf(format, args...)) }

	if strings.TrimSpace(rb.Disclaimer) == "" {
		bad("disclaimer is empty")
	}
	if strings.TrimSpace(rb.Charter.Mission.Headline) == "" {
		bad("charter.mission.headline is empty")
	}
	if len(rb.Charter.Values) == 0 {
		bad("charter.values is empty")
	}

	s := rb.Scoring
	for name, v := range map[string]int{
		"core": s.Core, "chainLink": s.ChainLink, "assist": s.Assist, "harmonize": s.Harmonize,
		"scan": s.Scan, "review": s.Review, "shortcutGain": s.ShortcutGain,
		"shortcutPenalty": s.ShortcutPenalty, "correctVerdict": s.CorrectVerdict,
		"sectorClear": s.SectorClear, "integrityStart": s.IntegrityStart,
		"integrityPerShortcut": s.IntegrityPerShortcut, "minSectorTimeMs": s.MinSectorTimeMs,
	} {
		if v < 0 {
			bad("scoring.%s is negative", name)
		}
	}
	if s.MaxSectorTimeMs <= s.MinSectorTimeMs {
		bad("scoring.maxSectorTimeMs must exceed minSectorTimeMs")
	}
	if len(s.ReadinessLevels) == 0 {
		bad("scoring.readinessLevels is empty")
	}
	for i := 1; i < len(s.ReadinessLevels); i++ {
		prev, cur := s.ReadinessLevels[i-1], s.ReadinessLevels[i]
		if cur.Level <= prev.Level || cur.MinCorrect < prev.MinCorrect {
			bad("scoring.readinessLevels must ascend (entry %d)", i)
		}
	}

	if len(rb.Ranks) == 0 {
		bad("ranks is empty")
	}
	for i, r := range rb.Ranks {
		if r.ID == "" || r.Name == "" {
			bad("ranks[%d] needs an id and a name", i)
		}
	}

	if rb.Method.MinimumRule.Level <= 0 {
		bad("method.minimumRule.level must be positive")
	}
	if len(rb.Method.Modules) == 0 {
		bad("method.modules is empty")
	}
	for i, m := range rb.Method.Modules {
		if m.ID == "" || m.Gate == "" || m.Question == "" {
			bad("method.modules[%d] needs an id, a gate and a question", i)
		}
	}

	if len(rb.Sectors) == 0 {
		bad("sectors is empty")
	}
	seen := map[string]bool{}
	for i, sec := range rb.Sectors {
		at := fmt.Sprintf("sectors[%d]", i)
		if sec.ID == "" {
			bad("%s.id is empty", at)
		} else if seen[sec.ID] {
			bad("%s.id %q is duplicated", at, sec.ID)
		}
		seen[sec.ID] = true
		sp := sec.Spawn
		for name, v := range map[string]int{
			"cores": sp.Cores, "humanPods": sp.HumanPods, "siPods": sp.SIPods, "stranded": sp.Stranded,
			"discord": sp.Discord, "anomalies": sp.Anomalies, "satellites": sp.Satellites,
			"shortcuts": sp.Shortcuts, "drift": sp.Drift,
		} {
			if v < 0 {
				bad("%s.spawn.%s is negative", at, name)
			}
		}
		if len(sec.Gate) == 0 {
			bad("%s.gate is empty", at)
		}
		for q, sc := range sec.Gate {
			if len(sc.Options) == 0 {
				bad("%s.gate[%d].options is empty", at, q)
			}
			if sc.Answer < 0 || sc.Answer >= len(sc.Options) {
				bad("%s.gate[%d].answer is not one of its options", at, q)
			}
		}
	}
	return errors.Join(errs...)
}

func (m *Models) validate() error {
	var errs []error
	if len(m.Models) == 0 {
		errs = append(errs, errors.New("models is empty"))
	}
	seen := map[string]bool{}
	for i, mod := range m.Models {
		if mod.ID == "" || mod.Name == "" {
			errs = append(errs, fmt.Errorf("models[%d] needs an id and a name", i))
		}
		if mod.Ollama == "" {
			errs = append(errs, fmt.Errorf("models[%d].ollama is empty", i))
		}
		if seen[mod.ID] {
			errs = append(errs, fmt.Errorf("models[%d].id %q is duplicated", i, mod.ID))
		}
		seen[mod.ID] = true
	}
	return errors.Join(errs...)
}

// OllamaBases returns the hangar's Ollama tags reduced to the name before
// any ":" (so "qwen2.5" and "qwen2.5:0.5b" share the base "qwen2.5").
func (m *Models) OllamaBases() map[string]bool {
	out := make(map[string]bool, len(m.Models))
	for _, mod := range m.Models {
		out[BaseName(mod.Ollama)] = true
	}
	return out
}

// BaseName is an Ollama tag without its ":variant" suffix.
func BaseName(tag string) string {
	if i := strings.IndexByte(tag, ':'); i >= 0 {
		return tag[:i]
	}
	return tag
}
