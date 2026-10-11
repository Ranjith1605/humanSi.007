// Package leaderboard keeps the fleet board: the best runs, in memory,
// persisted to one JSON file, with a live feed of every accepted run.
//
// Persistence is write-temp-then-rename, so a crash mid-write leaves either
// the old board or the new one, never half of each. A file that does not
// parse is moved aside as leaderboard.json.corrupt-<unix> and reported, never
// silently replaced: a board somebody played for is evidence, and R2 of the
// Rule Book ("show the evidence and its limit") applies to us too.
package leaderboard

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// FileName is the board's file inside the data directory.
const FileName = "leaderboard.json"

// DefaultMaxEntries is how many runs the board keeps.
const DefaultMaxEntries = 500

// TimeLayout is RFC 3339 in UTC with fixed milliseconds, the same shape as
// JavaScript's toISOString(), so createdAt strings sort as times in both the
// server and the browser (api.js breaks score ties with localeCompare).
const TimeLayout = "2006-01-02T15:04:05.000Z"

// Entry is one run on the board, as the API documents it.
type Entry struct {
	ID             string `json:"id"`
	Callsign       string `json:"callsign"`
	Score          int    `json:"score"`
	Rank           string `json:"rank"`
	RankName       string `json:"rankName"`
	SectorsCleared int    `json:"sectorsCleared"`
	Integrity      int    `json:"integrity"`
	ReadinessLevel int    `json:"readinessLevel"`
	Cleared        bool   `json:"cleared"`
	CreatedAt      string `json:"createdAt"`
}

// FormatTime renders t for Entry.CreatedAt.
func FormatTime(t time.Time) string { return t.UTC().Format(TimeLayout) }

// less orders entries best first: higher score, then earlier run, then id.
func less(a, b Entry) bool {
	if a.Score != b.Score {
		return a.Score > b.Score
	}
	if a.CreatedAt != b.CreatedAt {
		return a.CreatedAt < b.CreatedAt
	}
	return a.ID < b.ID
}

type fileFormat struct {
	Version int     `json:"version"`
	Entries []Entry `json:"entries"`
}

// Store is the board. All methods are safe for concurrent use.
type Store struct {
	path string
	max  int
	log  *slog.Logger
	now  func() time.Time
	feed *Feed

	mu      sync.RWMutex
	entries []Entry
	version uint64 // bumped on every change

	persistMu sync.Mutex
	written   uint64 // newest version on disk
}

// Options configure Open. Zero values pick the defaults.
type Options struct {
	MaxEntries int
	Logger     *slog.Logger
	Now        func() time.Time
	Feed       *Feed
}

// Open loads (or starts) the board in dir, creating dir if needed. A
// corrupt board file is quarantined and the board starts empty; any other
// read error is returned, because carrying on would overwrite real data.
func Open(dir string, opt Options) (*Store, error) {
	if opt.MaxEntries <= 0 {
		opt.MaxEntries = DefaultMaxEntries
	}
	if opt.Logger == nil {
		opt.Logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Feed == nil {
		opt.Feed = NewFeed(DefaultMaxSubscribers, DefaultBuffer)
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("leaderboard: create data dir: %w", err)
	}
	s := &Store{
		path: filepath.Join(dir, FileName),
		max:  opt.MaxEntries,
		log:  opt.Logger,
		now:  opt.Now,
		feed: opt.Feed,
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("leaderboard: read %s: %w", s.path, err)
	}
	var f fileFormat
	if err := json.Unmarshal(raw, &f); err != nil || f.Version != 1 {
		if err == nil {
			err = fmt.Errorf("unsupported version %d", f.Version)
		}
		aside := fmt.Sprintf("%s.corrupt-%d", s.path, s.now().Unix())
		if rerr := os.Rename(s.path, aside); rerr != nil {
			return fmt.Errorf("leaderboard: %s is unreadable (%v) and could not be moved aside: %w", s.path, err, rerr)
		}
		s.log.Error("leaderboard file unreadable; moved aside, starting with an empty board",
			"file", s.path, "movedTo", aside, "err", err.Error())
		return nil
	}
	kept := f.Entries[:0]
	for _, e := range f.Entries {
		if e.ID != "" && e.Callsign != "" && e.CreatedAt != "" {
			kept = append(kept, e)
		}
	}
	if dropped := len(f.Entries) - len(kept); dropped > 0 {
		s.log.Warn("leaderboard file had incomplete entries; skipped them", "file", s.path, "skipped", dropped)
	}
	sort.SliceStable(kept, func(i, j int) bool { return less(kept[i], kept[j]) })
	if len(kept) > s.max {
		kept = kept[:s.max]
	}
	s.entries = kept
	s.log.Info("leaderboard loaded", "file", s.path, "entries", len(kept))
	return nil
}

// Feed returns the board's live feed.
func (s *Store) Feed() *Feed { return s.feed }

// Add records an accepted run, publishes it on the feed and persists the
// board. placement is the run's 1-based position among the board's entries
// (it can exceed the board's size when the run did not make the cut). A
// persistence error is returned after the run is already on the in-memory
// board and the feed: the caller should log it, not reject the run.
func (s *Store) Add(e Entry) (placement int, err error) {
	s.mu.Lock()
	i := sort.Search(len(s.entries), func(i int) bool { return less(e, s.entries[i]) })
	placement = i + 1
	changed := false
	if i < s.max {
		s.entries = append(s.entries, Entry{})
		copy(s.entries[i+1:], s.entries[i:])
		s.entries[i] = e
		if len(s.entries) > s.max {
			s.entries = s.entries[:s.max]
		}
		s.version++
		changed = true
	}
	version := s.version
	snapshot := append([]Entry(nil), s.entries...)
	s.mu.Unlock()

	s.feed.Publish(e)
	if !changed {
		return placement, nil
	}
	return placement, s.persist(version, snapshot)
}

// persist writes the snapshot unless a newer one is already on disk, so
// concurrent Adds never let an older board overwrite a newer one.
func (s *Store) persist(version uint64, entries []Entry) error {
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	if version <= s.written {
		return nil
	}
	data, err := json.MarshalIndent(fileFormat{Version: 1, Entries: entries}, "", " ")
	if err != nil {
		return fmt.Errorf("leaderboard: encode: %w", err)
	}
	if err := writeAtomic(s.path, data); err != nil {
		return fmt.Errorf("leaderboard: persist: %w", err)
	}
	s.written = version
	return nil
}

func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = tmp.Close()
			_ = os.Remove(name)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(name, 0o640); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	ok = true
	// Make the rename itself durable. Some file systems refuse to sync a
	// directory; the data is already in place, so that is not an error.
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// Top returns up to limit best entries and the board's size.
func (s *Store) Top(limit int) (entries []Entry, total int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := min(max(limit, 0), len(s.entries))
	return append([]Entry{}, s.entries[:n]...), len(s.entries)
}

// Len is the number of entries on the board.
func (s *Store) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.entries)
}

// Path is the board file's location.
func (s *Store) Path() string { return s.path }
