package api

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// Limiter is a set of token buckets keyed by client address.
//
// Eviction is exact rather than approximate: a bucket that has refilled to
// its burst is indistinguishable from a brand-new one, so deleting it
// changes nothing for that client. Sweeps run at most once a minute, inside
// Allow, so there is no background goroutine to stop.
type Limiter struct {
	rate    float64 // tokens per second
	burst   float64
	now     func() time.Time
	maxKeys int

	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

const (
	sweepEvery     = time.Minute
	defaultMaxKeys = 50_000
)

// NewLimiter allows burst requests at once and perSecond on average.
func NewLimiter(perSecond float64, burst int, now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{
		rate:    perSecond,
		burst:   float64(burst),
		now:     now,
		maxKeys: defaultMaxKeys,
		buckets: map[string]*bucket{},
	}
}

// Allow takes a token for key. When none is left it reports how long until
// one is.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSweep) >= sweepEvery || len(l.buckets) >= l.maxKeys {
		l.sweep(now)
	}
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(l.burst, b.tokens+elapsed*l.rate)
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := time.Duration((1 - b.tokens) / l.rate * float64(time.Second))
	return false, wait
}

func (l *Limiter) full(b *bucket, now time.Time) bool {
	return b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst
}

func (l *Limiter) sweep(now time.Time) {
	l.lastSweep = now
	for k, b := range l.buckets {
		if l.full(b, now) {
			delete(l.buckets, k)
		}
	}
	// Under a flood of distinct addresses, drop the least recently seen
	// buckets rather than grow without bound (or lock everyone out).
	for len(l.buckets) >= l.maxKeys {
		var oldestKey string
		var oldest time.Time
		for k, b := range l.buckets {
			if oldestKey == "" || b.last.Before(oldest) {
				oldestKey, oldest = k, b.last
			}
		}
		delete(l.buckets, oldestKey)
	}
}

// Len is the number of buckets currently held.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// ClientIP is the rate-limit key for a request: the peer address, or with
// trustProxy the right-most valid X-Forwarded-For address, which is the one
// the nearest (trusted) proxy appended; anything to its left is whatever
// the client chose to send. IPv6 clients are grouped by /64, the block a
// single subscriber usually controls.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		values := r.Header.Values("X-Forwarded-For")
		for i := len(values) - 1; i >= 0; i-- {
			parts := strings.Split(values[i], ",")
			for j := len(parts) - 1; j >= 0; j-- {
				if ip, err := netip.ParseAddr(strings.TrimSpace(parts[j])); err == nil {
					return addrKey(ip)
				}
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		return addrKey(ip)
	}
	return host
}

func addrKey(ip netip.Addr) string {
	ip = ip.WithZone("").Unmap()
	if ip.Is6() {
		if p, err := ip.Prefix(64); err == nil {
			return p.String()
		}
	}
	return ip.String()
}
