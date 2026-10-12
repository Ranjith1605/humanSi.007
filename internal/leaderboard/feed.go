package leaderboard

import (
	"errors"
	"sync"
)

// Feed defaults: the SSE endpoint's documented cap, and how many runs a
// listener may fall behind before it is dropped.
const (
	DefaultMaxSubscribers = 200
	DefaultBuffer         = 16
)

var (
	// ErrFull means the feed already has its maximum number of listeners.
	ErrFull = errors.New("leaderboard: too many live listeners")
	// ErrClosed means the feed has shut down.
	ErrClosed = errors.New("leaderboard: feed closed")
)

// Feed fans every accepted run out to live listeners. Publishing never
// blocks: a listener whose buffer is full is dropped (its channel closed),
// because one stalled browser must not hold up a run submission or the
// other pilots' feeds. Dropped EventSource clients reconnect on their own.
type Feed struct {
	max, buf int

	mu     sync.Mutex
	subs   map[chan Entry]struct{}
	closed bool
}

// NewFeed makes a feed for at most maxSubs listeners, each with buf slots.
func NewFeed(maxSubs, buf int) *Feed {
	if maxSubs <= 0 {
		maxSubs = DefaultMaxSubscribers
	}
	if buf <= 0 {
		buf = DefaultBuffer
	}
	return &Feed{max: maxSubs, buf: buf, subs: make(map[chan Entry]struct{})}
}

// Subscribe registers a listener. The channel closes when the listener is
// dropped for being slow, when cancel is called, or when the feed closes.
func (f *Feed) Subscribe() (<-chan Entry, func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil, nil, ErrClosed
	}
	if len(f.subs) >= f.max {
		return nil, nil, ErrFull
	}
	ch := make(chan Entry, f.buf)
	f.subs[ch] = struct{}{}
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			if _, ok := f.subs[ch]; ok {
				delete(f.subs, ch)
				close(ch)
			}
		})
	}
	return ch, cancel, nil
}

// Publish delivers e to every listener that has room and drops the rest.
// It returns how many listeners were dropped.
func (f *Feed) Publish(e Entry) (dropped int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for ch := range f.subs {
		select {
		case ch <- e:
		default:
			delete(f.subs, ch)
			close(ch)
			dropped++
		}
	}
	return dropped
}

// Len is the number of live listeners.
func (f *Feed) Len() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.subs)
}

// Close ends every listener's stream and refuses new ones.
func (f *Feed) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return
	}
	f.closed = true
	for ch := range f.subs {
		delete(f.subs, ch)
		close(ch)
	}
}
