package api

import (
	"fmt"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLimiterRefillsAndReportsWait(t *testing.T) {
	c := &fakeClock{t: time.Unix(0, 0)}
	l := NewLimiter(5.0/60, 3, c.Now) // one token every 12 s, burst 3
	for i := 0; i < 3; i++ {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("burst %d refused", i)
		}
	}
	ok, wait := l.Allow("a")
	if ok || wait != 12*time.Second {
		t.Fatalf("4th: ok=%v wait=%v", ok, wait)
	}
	c.Advance(6 * time.Second)
	if ok, wait := l.Allow("a"); ok || wait != 6*time.Second {
		t.Fatalf("after 6 s: ok=%v wait=%v", ok, wait)
	}
	c.Advance(6 * time.Second)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("after 12 s: refused")
	}
	// Refill never exceeds the burst.
	c.Advance(time.Hour)
	for i := 0; i < 3; i++ {
		l.Allow("a")
	}
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("burst exceeded after a long idle")
	}
}

func TestLimiterEvictsIdleBuckets(t *testing.T) {
	c := &fakeClock{t: time.Unix(0, 0)}
	l := NewLimiter(1, 2, c.Now)
	for i := 0; i < 100; i++ {
		l.Allow(fmt.Sprint("ip", i))
	}
	if l.Len() != 100 {
		t.Fatalf("len = %d", l.Len())
	}
	// After a sweep interval every bucket has refilled: all are evicted
	// except the one being used now.
	c.Advance(sweepEvery)
	l.Allow("fresh")
	if l.Len() != 1 {
		t.Errorf("after sweep len = %d, want 1", l.Len())
	}
	// A bucket still recovering is kept.
	l.Allow("busy")
	l.Allow("busy")
	c.Advance(sweepEvery)
	l.rate = 0.001 // "busy" is far from refilled
	l.Allow("other")
	if _, ok := l.buckets["busy"]; !ok {
		t.Error("a bucket still recovering was evicted")
	}
}

func TestLimiterBoundsKeys(t *testing.T) {
	c := &fakeClock{t: time.Unix(0, 0)}
	l := NewLimiter(0.0001, 1, c.Now)
	l.maxKeys = 10
	for i := 0; i < 50; i++ {
		c.Advance(time.Millisecond)
		if ok, _ := l.Allow(fmt.Sprint("ip", i)); !ok {
			t.Fatalf("new client %d refused", i)
		}
	}
	if l.Len() > 10 {
		t.Errorf("len = %d, want at most 10", l.Len())
	}
	if _, ok := l.buckets["ip49"]; !ok {
		t.Error("the newest client should be kept")
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		name   string
		remote string
		xff    []string
		trust  bool
		want   string
	}{
		{"ipv4 peer", "203.0.113.9:5555", nil, false, "203.0.113.9"},
		{"ipv6 peer grouped by /64", "[2001:db8:1:2:3:4:5:6]:443", nil, false, "2001:db8:1:2::/64"},
		{"same /64 shares a bucket", "[2001:db8:1:2:ffff::1]:443", nil, false, "2001:db8:1:2::/64"},
		{"v4-mapped v6", "[::ffff:198.51.100.4]:1", nil, false, "198.51.100.4"},
		{"forwarded ignored without trust", "10.0.0.1:1", []string{"198.51.100.7"}, false, "10.0.0.1"},
		{"trusted: rightmost entry", "10.0.0.1:1", []string{"6.6.6.6, 198.51.100.7"}, true, "198.51.100.7"},
		{"trusted: last header wins", "10.0.0.1:1", []string{"6.6.6.6", "198.51.100.8"}, true, "198.51.100.8"},
		{"trusted: junk skipped", "10.0.0.1:1", []string{"198.51.100.9, junk, "}, true, "198.51.100.9"},
		{"trusted: nothing usable", "10.0.0.1:1", []string{"junk"}, true, "10.0.0.1"},
		{"trusted: no header", "10.0.0.1:1", nil, true, "10.0.0.1"},
		{"unparsable peer", "pipe", nil, false, "pipe"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = tc.remote
			for _, v := range tc.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			if got := ClientIP(r, tc.trust); got != tc.want {
				t.Errorf("ClientIP = %q, want %q", got, tc.want)
			}
		})
	}
}
