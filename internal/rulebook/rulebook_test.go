package rulebook_test

import (
	"encoding/json"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	humansi "github.com/Ranjith1605/humanSi.007"
	"github.com/Ranjith1605/humanSi.007/internal/rulebook"
)

func site(t *testing.T) fs.FS {
	t.Helper()
	sub, err := fs.Sub(humansi.Web, "web")
	if err != nil {
		t.Fatal(err)
	}
	return sub
}

func TestLoadEmbedded(t *testing.T) {
	rb, models, err := rulebook.Load(site(t))
	if err != nil {
		t.Fatalf("the shipped rule book must load: %v", err)
	}
	if len(rb.Sectors) != 6 {
		t.Errorf("sectors = %d, want 6", len(rb.Sectors))
	}
	if rb.Method.MinimumRule.Level < 1 {
		t.Errorf("minimum rule level = %d", rb.Method.MinimumRule.Level)
	}
	if !json.Valid(rb.Raw) || !json.Valid(models.Raw) {
		t.Error("raw bytes must be kept intact")
	}
	if len(models.Models) == 0 {
		t.Error("hangar is empty")
	}
}

func TestOllamaBases(t *testing.T) {
	m := &rulebook.Models{Models: []rulebook.Model{{Ollama: "qwen2.5"}, {Ollama: "phi4:14b"}}}
	got := m.OllamaBases()
	if !got["qwen2.5"] || !got["phi4"] || len(got) != 2 {
		t.Errorf("bases = %v", got)
	}
	for in, want := range map[string]string{"a": "a", "a:b": "a", "a:b:c": "a", "": ""} {
		if g := rulebook.BaseName(in); g != want {
			t.Errorf("BaseName(%q) = %q, want %q", in, g, want)
		}
	}
}

// mutate returns the shipped rule book with one JSON edit applied.
func mutate(t *testing.T, edit func(m map[string]any)) []byte {
	t.Helper()
	raw, err := fs.ReadFile(site(t), rulebook.RulebookPath)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	edit(m)
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRulebookRejectsBrokenFiles(t *testing.T) {
	sector0 := func(m map[string]any) map[string]any {
		return m["sectors"].([]any)[0].(map[string]any)
	}
	cases := []struct {
		name string
		raw  []byte
		want string
	}{
		{"not json", []byte("{"), "invalid JSON"},
		{"trailing data", []byte(`{} {}`), "trailing data"},
		{"wrong type", []byte(`{"scoring":{"core":"five"}}`), "invalid JSON"},
		{"fractional weight", []byte(`{"scoring":{"core":2.5}}`), "invalid JSON"},
		{"empty object", []byte(`{}`), "sectors is empty"},
		{"no sectors", mutate(t, func(m map[string]any) { m["sectors"] = []any{} }), "sectors is empty"},
		{"duplicate sector", mutate(t, func(m map[string]any) {
			s := m["sectors"].([]any)
			s[1] = s[0]
		}), "duplicated"},
		{"answer out of range", mutate(t, func(m map[string]any) {
			sector0(m)["gate"].([]any)[0].(map[string]any)["answer"] = 7
		}), "answer is not one of its options"},
		{"negative spawn", mutate(t, func(m map[string]any) {
			sector0(m)["spawn"].(map[string]any)["cores"] = -1
		}), "spawn.cores is negative"},
		{"no readiness levels", mutate(t, func(m map[string]any) {
			m["scoring"].(map[string]any)["readinessLevels"] = []any{}
		}), "readinessLevels is empty"},
		{"no ranks", mutate(t, func(m map[string]any) { m["ranks"] = []any{} }), "ranks is empty"},
		{"no disclaimer", mutate(t, func(m map[string]any) { m["disclaimer"] = " " }), "disclaimer is empty"},
		{"no minimum rule", mutate(t, func(m map[string]any) {
			m["method"].(map[string]any)["minimumRule"] = map[string]any{}
		}), "minimumRule.level"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := rulebook.ParseRulebook(tc.raw)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestModelsRejectsBrokenFiles(t *testing.T) {
	cases := []struct {
		name, raw, want string
	}{
		{"not json", `[`, "invalid JSON"},
		{"empty", `{"models":[]}`, "models is empty"},
		{"no tag", `{"models":[{"id":"a","name":"A"}]}`, "ollama is empty"},
		{"duplicate", `{"models":[{"id":"a","name":"A","ollama":"a"},{"id":"a","name":"A","ollama":"a"}]}`, "duplicated"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := rulebook.ParseModels([]byte(tc.raw))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestLoadMissingFiles(t *testing.T) {
	if _, _, err := rulebook.Load(fstest.MapFS{}); err == nil || !strings.Contains(err.Error(), "rule book") {
		t.Fatalf("missing rule book: err = %v", err)
	}
	raw, err := fs.ReadFile(site(t), rulebook.RulebookPath)
	if err != nil {
		t.Fatal(err)
	}
	only := fstest.MapFS{rulebook.RulebookPath: {Data: raw}}
	if _, _, err := rulebook.Load(only); err == nil || !strings.Contains(err.Error(), "model catalog") {
		t.Fatalf("missing models: err = %v", err)
	}
}
