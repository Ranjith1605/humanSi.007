package leaderboard

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func entry(id string, score int, at time.Time) Entry {
	return Entry{
		ID: id, Callsign: "Pilot " + id, Score: score, Rank: "shu", RankName: "SHU",
		SectorsCleared: 6, Integrity: 100, ReadinessLevel: 3, Cleared: true, CreatedAt: FormatTime(at),
	}
}

func open(t *testing.T, dir string, opt Options) *Store {
	t.Helper()
	if opt.Logger == nil {
		opt.Logger = quiet
	}
	s, err := Open(dir, opt)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func ids(es []Entry) string {
	var b []string
	for _, e := range es {
		b = append(b, e.ID)
	}
	return strings.Join(b, ",")
}

func TestOrderingAndPlacement(t *testing.T) {
	s := open(t, t.TempDir(), Options{})
	t0 := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	steps := []struct {
		e         Entry
		placement int
		order     string
	}{
		{entry("a", 100, t0), 1, "a"},
		{entry("b", 300, t0.Add(time.Second)), 1, "b,a"},
		{entry("c", 100, t0.Add(2*time.Second)), 3, "b,a,c"}, // ties go to the earlier run
		{entry("d", 200, t0.Add(3*time.Second)), 2, "b,d,a,c"},
		{entry("e", 0, t0.Add(4*time.Second)), 5, "b,d,a,c,e"},
	}
	for _, st := range steps {
		p, err := s.Add(st.e)
		if err != nil {
			t.Fatal(err)
		}
		if p != st.placement {
			t.Errorf("Add(%s) placement = %d, want %d", st.e.ID, p, st.placement)
		}
		got, total := s.Top(50)
		if ids(got) != st.order || total != len(got) {
			t.Errorf("after %s: order %s (total %d), want %s", st.e.ID, ids(got), total, st.order)
		}
	}
	top2, total := s.Top(2)
	if ids(top2) != "b,d" || total != 5 {
		t.Errorf("Top(2) = %s, %d", ids(top2), total)
	}
	if none, _ := s.Top(-1); len(none) != 0 {
		t.Errorf("Top(-1) = %v", none)
	}
}

func TestKeepsBestEntriesOnly(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{MaxEntries: 3})
	t0 := time.Unix(1_700_000_000, 0)
	for i, score := range []int{10, 50, 30, 40} {
		if _, err := s.Add(entry(fmt.Sprint("e", i), score, t0.Add(time.Duration(i)*time.Second))); err != nil {
			t.Fatal(err)
		}
	}
	got, total := s.Top(10)
	if ids(got) != "e1,e3,e2" || total != 3 {
		t.Fatalf("board = %s (%d)", ids(got), total)
	}
	// A run below the cut still gets a placement and goes out on the feed,
	// but does not touch the stored board.
	ch, cancel, err := s.Feed().Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	p, err := s.Add(entry("low", 1, t0.Add(time.Minute)))
	if err != nil || p != 4 {
		t.Fatalf("placement = %d, err = %v", p, err)
	}
	if e := <-ch; e.ID != "low" {
		t.Errorf("feed got %s", e.ID)
	}
	if got, _ := s.Top(10); ids(got) != "e1,e3,e2" {
		t.Errorf("board changed: %s", ids(got))
	}
}

func TestPersistAndReload(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	t0 := time.Date(2026, 5, 6, 7, 8, 9, 123_000_000, time.UTC)
	for i := 0; i < 5; i++ {
		if _, err := s.Add(entry(fmt.Sprint("p", i), i*10, t0.Add(time.Duration(i)*time.Millisecond))); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	var f fileFormat
	if err := json.Unmarshal(raw, &f); err != nil || f.Version != 1 || len(f.Entries) != 5 {
		t.Fatalf("file: %v, %+v", err, f)
	}
	if f.Entries[0].CreatedAt != "2026-05-06T07:08:09.127Z" {
		t.Errorf("createdAt = %q", f.Entries[0].CreatedAt)
	}
	// No temp files left behind.
	matches, _ := filepath.Glob(filepath.Join(dir, "*.tmp-*"))
	if len(matches) != 0 {
		t.Errorf("temp files left: %v", matches)
	}
	again := open(t, dir, Options{MaxEntries: 3})
	got, total := again.Top(10)
	if ids(got) != "p4,p3,p2" || total != 3 {
		t.Errorf("reloaded = %s (%d)", ids(got), total)
	}
}

func TestCorruptFileIsMovedAside(t *testing.T) {
	for name, content := range map[string]string{
		"garbage":       "{not json",
		"wrong version": `{"version":9,"entries":[]}`,
		"wrong shape":   `[1,2,3]`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, FileName)
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			now := time.Unix(1_234_567_890, 0)
			var logs strings.Builder
			s := open(t, dir, Options{Now: func() time.Time { return now }, Logger: slog.New(slog.NewTextHandler(&logs, nil))})
			if s.Len() != 0 {
				t.Errorf("board should start empty, has %d", s.Len())
			}
			aside := path + ".corrupt-1234567890"
			kept, err := os.ReadFile(aside)
			if err != nil || string(kept) != content {
				t.Fatalf("corrupt file not preserved: %v %q", err, kept)
			}
			if !strings.Contains(logs.String(), "moved aside") {
				t.Errorf("not logged: %s", logs.String())
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Errorf("original still in place: %v", err)
			}
		})
	}
}

func TestIncompleteEntriesSkipped(t *testing.T) {
	dir := t.TempDir()
	body := `{"version":1,"entries":[{"id":"x","callsign":"X1","score":5,"createdAt":"2026-01-01T00:00:00.000Z"},{"id":"","callsign":"nobody","score":99}]}`
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	s := open(t, dir, Options{})
	if got, _ := s.Top(10); ids(got) != "x" {
		t.Errorf("loaded %s", ids(got))
	}
}

func TestUnreadableFileIsAnError(t *testing.T) {
	dir := t.TempDir()
	// A directory where the file should be: reading fails with something
	// other than "not found", and the store must not paper over it.
	if err := os.Mkdir(filepath.Join(dir, FileName), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, Options{Logger: quiet}); err == nil {
		t.Fatal("want an error")
	}
}

func TestPersistFailureStillKeepsRun(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{})
	// Point the store at a directory that does not exist.
	s.path = filepath.Join(dir, "missing", FileName)
	p, err := s.Add(entry("z", 1, time.Now()))
	if err == nil {
		t.Fatal("want a persistence error")
	}
	if p != 1 || s.Len() != 1 {
		t.Errorf("run lost: placement %d, len %d", p, s.Len())
	}
}

func TestConcurrentAdds(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir, Options{MaxEntries: 50})
	t0 := time.Now()
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				if _, err := s.Add(entry(fmt.Sprintf("w%d-%d", w, i), w*100+i, t0)); err != nil {
					t.Error(err)
				}
				s.Top(5)
			}
		}()
	}
	wg.Wait()
	got, total := s.Top(100)
	if total != 50 {
		t.Fatalf("total = %d", total)
	}
	for i := 1; i < len(got); i++ {
		if less(got[i], got[i-1]) {
			t.Fatalf("out of order at %d", i)
		}
	}
	// The newest snapshot is the one on disk.
	again := open(t, dir, Options{MaxEntries: 50})
	reloaded, _ := again.Top(100)
	if ids(reloaded) != ids(got) {
		t.Errorf("disk and memory disagree:\n%s\n%s", ids(reloaded), ids(got))
	}
}

func TestFeedDropsSlowListeners(t *testing.T) {
	f := NewFeed(10, 2)
	fast, cancelFast, _ := f.Subscribe()
	slow, cancelSlow, _ := f.Subscribe()
	defer cancelFast()
	defer cancelSlow()
	for i := 0; i < 3; i++ {
		dropped := f.Publish(Entry{ID: fmt.Sprint(i)})
		<-fast
		if i < 2 && dropped != 0 {
			t.Fatalf("publish %d dropped %d", i, dropped)
		}
		if i == 2 && dropped != 1 {
			t.Fatalf("slow listener not dropped (dropped %d)", dropped)
		}
	}
	// The slow listener gets what was buffered, then a closed channel.
	n := 0
	for range slow {
		n++
	}
	if n != 2 {
		t.Errorf("slow listener received %d before close", n)
	}
	if f.Len() != 1 {
		t.Errorf("listeners = %d", f.Len())
	}
}

func TestFeedLimitsAndClose(t *testing.T) {
	f := NewFeed(2, 1)
	_, c1, err1 := f.Subscribe()
	ch2, _, err2 := f.Subscribe()
	if err1 != nil || err2 != nil {
		t.Fatal(err1, err2)
	}
	if _, _, err := f.Subscribe(); err != ErrFull {
		t.Fatalf("third subscribe err = %v", err)
	}
	c1()
	c1() // idempotent
	_, c3, err := f.Subscribe()
	if err != nil {
		t.Fatalf("slot not freed: %v", err)
	}
	f.Close()
	if _, ok := <-ch2; ok {
		t.Error("channel open after Close")
	}
	c3() // cancel after close is harmless
	if _, _, err := f.Subscribe(); err != ErrClosed {
		t.Errorf("subscribe after close err = %v", err)
	}
	f.Close()
	if f.Publish(Entry{}) != 0 {
		t.Error("publish after close")
	}
}
