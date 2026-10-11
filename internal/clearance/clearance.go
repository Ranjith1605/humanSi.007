// Package clearance issues and checks launch-clearance tokens.
//
// A pilot who clears all six gates at readiness Level 3 or above gets a
// token that opens the SI console. The token is
//
//	base64url(payload) "." base64url(HMAC-SHA256(key, "humansi.clearance.v1." + base64url(payload)))
//
// where payload is JSON {"id": entry id, "cs": callsign, "exp": unix seconds}.
// The MAC covers the encoded payload exactly as transmitted, so there is no
// re-encoding ambiguity, and the version prefix keeps these MACs from being
// valid for any other use of the same key. Tokens are bearer credentials
// with a fixed lifetime; there is no server-side session to revoke.
package clearance

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// DefaultTTL is how long a clearance lasts.
const DefaultTTL = 24 * time.Hour

// maxTokenLen bounds the work done on hostile input before the MAC check.
const maxTokenLen = 1024

const domain = "humansi.clearance.v1."

var (
	// ErrMalformed covers anything that is not a well-formed token.
	ErrMalformed = errors.New("clearance: malformed token")
	// ErrBadSignature means the MAC does not match (tampered, or another key).
	ErrBadSignature = errors.New("clearance: bad signature")
	// ErrExpired means the token was valid but its time is up.
	ErrExpired = errors.New("clearance: expired")
)

var b64 = base64.RawURLEncoding

// Claims is what a token says.
type Claims struct {
	EntryID   string `json:"id"`
	Callsign  string `json:"cs"`
	ExpiresAt int64  `json:"exp"`
}

// Expiry returns the expiry as a time.
func (c Claims) Expiry() time.Time { return time.Unix(c.ExpiresAt, 0).UTC() }

// Signer issues and verifies tokens with one key.
type Signer struct {
	key []byte
	ttl time.Duration
	now func() time.Time
}

// New returns a signer for key. An empty key is an error: use RandomKey.
func New(key []byte, ttl time.Duration, now func() time.Time) (*Signer, error) {
	if len(key) == 0 {
		return nil, errors.New("clearance: empty key")
	}
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if now == nil {
		now = time.Now
	}
	return &Signer{key: append([]byte(nil), key...), ttl: ttl, now: now}, nil
}

// RandomKey returns 32 random bytes for a per-process key. Tokens signed
// with it stop working when the process restarts.
func RandomKey() ([]byte, error) {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	return k, nil
}

func (s *Signer) mac(encodedPayload string) []byte {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(domain))
	m.Write([]byte(encodedPayload))
	return m.Sum(nil)
}

// Issue signs a clearance for a run. Expiry is whole seconds, rounded down.
func (s *Signer) Issue(entryID, callsign string) (token string, expiresAt time.Time, err error) {
	exp := s.now().Add(s.ttl).Unix()
	payload, err := json.Marshal(Claims{EntryID: entryID, Callsign: callsign, ExpiresAt: exp})
	if err != nil {
		return "", time.Time{}, err
	}
	p := b64.EncodeToString(payload)
	return p + "." + b64.EncodeToString(s.mac(p)), time.Unix(exp, 0).UTC(), nil
}

// Verify checks the signature first (in constant time) and only then reads
// the payload, so nothing unauthenticated is ever parsed as claims.
func (s *Signer) Verify(token string) (Claims, error) {
	if token == "" || len(token) > maxTokenLen {
		return Claims{}, ErrMalformed
	}
	p, sig, ok := strings.Cut(token, ".")
	if !ok || p == "" || sig == "" || strings.Contains(sig, ".") {
		return Claims{}, ErrMalformed
	}
	got, err := b64.Strict().DecodeString(sig)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	if !hmac.Equal(got, s.mac(p)) {
		return Claims{}, ErrBadSignature
	}
	raw, err := b64.Strict().DecodeString(p)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	var c Claims
	if err := json.Unmarshal(raw, &c); err != nil || c.EntryID == "" || c.ExpiresAt == 0 {
		return Claims{}, ErrMalformed
	}
	if !s.now().Before(c.Expiry()) {
		return Claims{}, ErrExpired
	}
	return c, nil
}
