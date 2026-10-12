package game_test

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	humansi "github.com/Ranjith1605/humanSi.007"
	"github.com/Ranjith1605/humanSi.007/internal/game"
	"github.com/Ranjith1605/humanSi.007/internal/rulebook"
)

func loadRulebook(t *testing.T) *rulebook.Rulebook {
	t.Helper()
	sub, err := fs.Sub(humansi.Web, "web")
	if err != nil {
		t.Fatal(err)
	}
	rb, err := rulebook.LoadRulebook(sub)
	if err != nil {
		t.Fatal(err)
	}
	return rb
}

// fixture is testdata/score-cases.json. Sectors stay raw so the Go side reads
// exactly the text the JavaScript side parsed (1e1, -0, 1e400 and all).
type fixture struct {
	Scenarios int `json:"scenarios"`
	Runs      []struct {
		Name    string          `json:"name"`
		Sectors json.RawMessage `json:"sectors"`
		Expect  *game.Result    `json:"expect"`
		Error   *game.Invalid   `json:"error"`
	} `json:"runs"`
	Callsigns []struct {
		Raw    string  `json:"raw"`
		Expect *string `json:"expect"`
	} `json:"callsigns"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "score-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Runs) < 16 {
		t.Fatalf("fixture has %d runs, want at least 16", len(f.Runs))
	}
	return f
}

func TestScoreCasesMatchScoringJS(t *testing.T) {
	rb := loadRulebook(t)
	f := loadFixture(t)
	total := 0
	for _, s := range rb.Sectors {
		total += len(s.Gate)
	}
	if f.Scenarios != total {
		t.Fatalf("fixture was generated for %d scenarios, rule book has %d: regenerate it", f.Scenarios, total)
	}
	for _, c := range f.Runs {
		t.Run(c.Name, func(t *testing.T) {
			if (c.Expect == nil) == (c.Error == nil) {
				t.Fatal("a case needs exactly one of expect or error")
			}
			sectors, bad := game.ValidateRun(rb, c.Sectors)
			if c.Error != nil {
				if bad == nil {
					t.Fatalf("validated, want error %+v", *c.Error)
				}
				if *bad != *c.Error {
					t.Fatalf("error = %+v, want %+v", *bad, *c.Error)
				}
				return
			}
			if bad != nil {
				t.Fatalf("unexpected error %+v", *bad)
			}
			got := game.ScoreRun(rb, sectors)
			if !reflect.DeepEqual(got, *c.Expect) {
				t.Fatalf("result\n got  %+v\n want %+v", got, *c.Expect)
			}
		})
	}
}

func TestCallsignsMatchScoringJS(t *testing.T) {
	for _, c := range loadFixture(t).Callsigns {
		want := ""
		if c.Expect != nil {
			want = *c.Expect
		}
		if got := game.NormalizeCallsign(c.Raw); got != want {
			t.Errorf("NormalizeCallsign(%q) = %q, want %q", c.Raw, got, want)
		}
	}
}

func TestValidateRunAbsentSectors(t *testing.T) {
	rb := loadRulebook(t)
	for _, raw := range []json.RawMessage{nil, json.RawMessage(``), json.RawMessage(`  `), json.RawMessage(`"x"`), json.RawMessage(`7`)} {
		_, bad := game.ValidateRun(rb, raw)
		if bad == nil || bad.Field != "sectors" {
			t.Errorf("ValidateRun(%q) = %+v, want a sectors error", raw, bad)
		}
	}
}

func TestCapsMatchSpawn(t *testing.T) {
	rb := loadRulebook(t)
	for _, s := range rb.Sectors {
		caps := game.Caps(s)
		pods := s.Spawn.HumanPods + s.Spawn.SIPods
		wantChain := 0
		if pods > 0 {
			wantChain = pods - 1
		}
		if caps["chainLinks"] != wantChain || caps["cores"] != s.Spawn.Cores || caps["shortcuts"] != s.Spawn.Shortcuts {
			t.Errorf("%s caps = %v", s.ID, caps)
		}
		if len(caps) != len(game.Counters) {
			t.Errorf("%s: %d caps for %d counters", s.ID, len(caps), len(game.Counters))
		}
	}
}

func TestRankAndReadinessTables(t *testing.T) {
	rb := loadRulebook(t)
	if got := game.RankFor(rb, 0, 0).ID; got != rb.Ranks[0].ID {
		t.Errorf("lowest rank = %s", got)
	}
	top := rb.Ranks[len(rb.Ranks)-1]
	if got := game.RankFor(rb, top.MinScore, top.MinIntegrity).ID; got != top.ID {
		t.Errorf("top rank at its thresholds = %s, want %s", got, top.ID)
	}
	if got := game.RankFor(rb, top.MinScore, top.MinIntegrity-1).ID; got == top.ID {
		t.Error("top rank must need its integrity too")
	}
	levels := rb.Scoring.ReadinessLevels
	for _, l := range levels {
		if got := game.ReadinessLevel(rb, l.MinCorrect); got != l.Level {
			t.Errorf("ReadinessLevel(%d) = %d, want %d", l.MinCorrect, got, l.Level)
		}
	}
	if got := game.ReadinessLevel(rb, 0); got != levels[0].Level {
		t.Errorf("ReadinessLevel(0) = %d", got)
	}
}

func TestInvalidError(t *testing.T) {
	e := &game.Invalid{Field: "sectors[0].id", Message: "expected sector x"}
	if e.Error() != "sectors[0].id: expected sector x" {
		t.Errorf("Error() = %q", e.Error())
	}
}
