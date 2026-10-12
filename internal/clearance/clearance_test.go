package clearance

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newSigner(t *testing.T, key string, c *clock) *Signer {
	t.Helper()
	s, err := New([]byte(key), time.Hour, c.now)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestIssueAndVerify(t *testing.T) {
	c := &clock{time.Date(2026, 3, 4, 5, 6, 7, 800, time.UTC)}
	s := newSigner(t, "secret", c)
	tok, exp, err := s.Issue("0123456789abcdef", "Nova Pilot")
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 3, 4, 6, 6, 7, 0, time.UTC); !exp.Equal(want) {
		t.Errorf("expiresAt = %v, want %v", exp, want)
	}
	if strings.ContainsAny(tok, "+/=") || strings.Count(tok, ".") != 1 {
		t.Errorf("token is not two base64url segments: %q", tok)
	}
	got, err := s.Verify(tok)
	if err != nil {
		t.Fatal(err)
	}
	if got.EntryID != "0123456789abcdef" || got.Callsign != "Nova Pilot" || !got.Expiry().Equal(exp) {
		t.Errorf("claims = %+v", got)
	}
}

func TestExpiry(t *testing.T) {
	c := &clock{time.Unix(1_800_000_000, 0)}
	s := newSigner(t, "secret", c)
	tok, _, _ := s.Issue("id", "cs")
	c.t = c.t.Add(time.Hour - time.Second)
	if _, err := s.Verify(tok); err != nil {
		t.Fatalf("one second before expiry: %v", err)
	}
	c.t = c.t.Add(time.Second)
	if _, err := s.Verify(tok); !errors.Is(err, ErrExpired) {
		t.Fatalf("at expiry: err = %v, want ErrExpired", err)
	}
}

func TestTamperingAndForgery(t *testing.T) {
	c := &clock{time.Unix(1_800_000_000, 0)}
	s := newSigner(t, "secret", c)
	tok, _, _ := s.Issue("id-1", "Nova")
	p, sig, _ := strings.Cut(tok, ".")

	// A payload the attacker would like: a later expiry and another entry.
	forged, _ := json.Marshal(Claims{EntryID: "id-2", Callsign: "Nova", ExpiresAt: 4_000_000_000})
	forgedP := b64.EncodeToString(forged)
	other := newSigner(t, "other key", c)
	otherTok, _, _ := other.Issue("id-1", "Nova")

	flip := func(s string, i int) string {
		b := []byte(s)
		if b[i] == 'A' {
			b[i] = 'B'
		} else {
			b[i] = 'A'
		}
		return string(b)
	}

	cases := []struct {
		name string
		tok  string
		want error
	}{
		{"empty", "", ErrMalformed},
		{"no dot", p + sig, ErrMalformed},
		{"three parts", tok + ".x", ErrMalformed},
		{"empty payload", "." + sig, ErrMalformed},
		{"empty signature", p + ".", ErrMalformed},
		{"signature not base64url", p + ".***", ErrMalformed},
		{"padded signature", p + "." + sig + "=", ErrMalformed},
		{"too long", strings.Repeat("a", maxTokenLen+1), ErrMalformed},
		{"payload byte flipped", flip(p, 3) + "." + sig, ErrBadSignature},
		{"signature byte flipped", p + "." + flip(sig, 5), ErrBadSignature},
		{"signature truncated", p + "." + sig[:40], ErrBadSignature}, // 43 chars; 40 decode cleanly
		{"forged payload, old signature", forgedP + "." + sig, ErrBadSignature},
		{"signed with another key", otherTok, ErrBadSignature},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.Verify(tc.tok); !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestSignedButMeaninglessPayload(t *testing.T) {
	s := newSigner(t, "secret", &clock{time.Unix(1_800_000_000, 0)})
	for _, payload := range []string{`not json`, `{}`, `{"id":"x"}`, `[]`} {
		p := b64.EncodeToString([]byte(payload))
		tok := p + "." + b64.EncodeToString(s.mac(p))
		if _, err := s.Verify(tok); !errors.Is(err, ErrMalformed) {
			t.Errorf("payload %s: err = %v", payload, err)
		}
	}
}

func TestNewAndRandomKey(t *testing.T) {
	if _, err := New(nil, 0, nil); err == nil {
		t.Error("empty key accepted")
	}
	s, err := New([]byte("k"), 0, nil)
	if err != nil || s.ttl != DefaultTTL {
		t.Errorf("defaults: %v %v", err, s)
	}
	a, err1 := RandomKey()
	b, err2 := RandomKey()
	if err1 != nil || err2 != nil || len(a) != 32 || string(a) == string(b) {
		t.Errorf("random keys: %v %v", err1, err2)
	}
}
