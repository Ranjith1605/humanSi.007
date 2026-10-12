package api

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Ranjith1605/humanSi.007/internal/clearance"
	"github.com/Ranjith1605/humanSi.007/internal/copilot"
)

const wantCSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; media-src 'self'; img-src 'self' data:; connect-src 'self'"

func checkSecurityHeaders(t *testing.T, what string, h http.Header) {
	t.Helper()
	want := map[string]string{
		"Content-Security-Policy": wantCSP,
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "strict-origin-when-cross-origin",
		"X-Frame-Options":         "DENY",
	}
	for k, v := range want {
		if got := h.Get(k); got != v {
			t.Errorf("%s: %s = %q, want %q", what, k, got, v)
		}
	}
}

func checkError(t *testing.T, r response, status int, code string) map[string]any {
	t.Helper()
	if r.status != status {
		t.Fatalf("status = %d, want %d; body %s", r.status, status, r.body)
	}
	if ct := r.header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("error Content-Type = %q", ct)
	}
	m := r.json(t)
	if m["error"] != code {
		t.Fatalf("error = %v, want %s; body %s", m["error"], code, r.body)
	}
	if msg, _ := m["message"].(string); msg == "" {
		t.Errorf("error without a message: %s", r.body)
	}
	return m
}

func TestHealth(t *testing.T) {
	h := newHarness(t)
	h.clock.Advance(90 * time.Second)
	r := h.get("/api/health")
	if r.status != 200 {
		t.Fatalf("status %d", r.status)
	}
	m := r.json(t)
	if m["status"] != "ok" || m["version"] != "0.1.0" || m["uptimeSec"] != float64(90) || m["copilot"] != false {
		t.Errorf("health = %s", r.body)
	}
	if len(m) != 4 {
		t.Errorf("health has extra fields: %s", r.body)
	}
	checkSecurityHeaders(t, "health", r.header)

	cp, _ := copilot.New("http://127.0.0.1:1", copilot.Options{})
	h2 := newHarness(t, func(c *Config) { c.Copilot = cp })
	if h2.get("/api/health").json(t)["copilot"] != true {
		t.Error("copilot should be true when an Ollama URL is configured")
	}
}

func TestRulebookIsTheFileVerbatim(t *testing.T) {
	h := newHarness(t)
	r := h.get("/api/rulebook")
	if r.status != 200 || string(r.body) != string(h.rb.Raw) {
		t.Fatalf("status %d, body differs from the file", r.status)
	}
	if r.header.Get("Content-Type") != "application/json; charset=utf-8" || r.header.Get("Cache-Control") != "no-cache" {
		t.Errorf("headers %v", r.header)
	}
	head := h.do(http.MethodHead, "/api/rulebook", "", nil)
	if head.status != 200 || len(head.body) != 0 {
		t.Errorf("HEAD: %d, %d bytes", head.status, len(head.body))
	}
}

func TestLeaderboard(t *testing.T) {
	h := newHarness(t)
	r := h.get("/api/leaderboard")
	if r.status != 200 || strings.TrimSpace(string(r.body)) != `{"entries":[],"total":0}` {
		t.Fatalf("empty board: %d %s", r.status, r.body)
	}
	sectors := fixtureSectors(t, "minimal clearing run")
	for i := 0; i < 12; i++ {
		h.clock.Advance(time.Minute) // stay inside the rate limit
		if p := h.postJSON("/api/runs", runBody(fmt.Sprintf("Pilot %02d", i), sectors)); p.status != 201 {
			t.Fatalf("post %d: %d %s", i, p.status, p.body)
		}
	}
	for _, tc := range []struct {
		query string
		n     int
	}{{"", 10}, {"?limit=1", 1}, {"?limit=50", 12}, {"?limit=12", 12}} {
		var body struct {
			Entries []map[string]any `json:"entries"`
			Total   int              `json:"total"`
		}
		r := h.get("/api/leaderboard" + tc.query)
		if err := json.Unmarshal(r.body, &body); err != nil || r.status != 200 {
			t.Fatalf("%s: %d %s", tc.query, r.status, r.body)
		}
		if len(body.Entries) != tc.n || body.Total != 12 {
			t.Errorf("%s: %d entries, total %d", tc.query, len(body.Entries), body.Total)
		}
		// Equal scores: the earlier run ranks first.
		if body.Entries[0]["callsign"] != "Pilot 00" {
			t.Errorf("%s: first = %v", tc.query, body.Entries[0]["callsign"])
		}
	}
	for _, bad := range []string{"0", "51", "-1", "ten", "1.5", ""} {
		if bad == "" {
			continue
		}
		m := checkError(t, h.get("/api/leaderboard?limit="+bad), 400, "invalid_limit")
		if m["field"] != "limit" {
			t.Errorf("limit=%s: field %v", bad, m["field"])
		}
	}
}

func TestPostRunCleared(t *testing.T) {
	h := newHarness(t)
	// A client-side score is ignored: the server computes its own.
	body := `{"callsign":"  Nova   Pilot ","score":999999,"rank":"ri","sectors":` + fixtureSectors(t, "perfect run") + `}`
	r := h.postJSON("/api/runs", body)
	if r.status != 201 {
		t.Fatalf("status %d: %s", r.status, r.body)
	}
	checkSecurityHeaders(t, "post run", r.header)
	var got struct {
		Entry struct {
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
		} `json:"entry"`
		Placement int `json:"placement"`
		Clearance *struct {
			Token     string `json:"token"`
			ExpiresAt string `json:"expiresAt"`
		} `json:"clearance"`
	}
	if err := json.Unmarshal(r.body, &got); err != nil {
		t.Fatal(err)
	}
	e := got.Entry
	var perfect *fixtureRun
	for _, f := range fixtureRuns(t) {
		if strings.HasPrefix(f.Name, "perfect run") {
			f := f
			perfect = &f
		}
	}
	want := perfect.Expect
	if e.Callsign != "Nova Pilot" || e.Score != want.Score || e.Rank != want.Rank || e.RankName != want.RankName ||
		e.SectorsCleared != want.SectorsCleared || e.Integrity != want.Integrity ||
		e.ReadinessLevel != want.ReadinessLevel || e.Cleared != true {
		t.Errorf("entry = %+v, want %+v", e, *want)
	}
	if len(e.ID) != 16 || strings.Trim(e.ID, "0123456789abcdef") != "" {
		t.Errorf("id = %q, want 16 hex characters", e.ID)
	}
	if e.CreatedAt != "2026-10-10T12:00:00.000Z" {
		t.Errorf("createdAt = %q", e.CreatedAt)
	}
	if got.Placement != 1 {
		t.Errorf("placement = %d", got.Placement)
	}
	if got.Clearance == nil {
		t.Fatal("a cleared run must earn clearance")
	}
	if got.Clearance.ExpiresAt != "2026-10-11T12:00:00.000Z" {
		t.Errorf("expiresAt = %q, want 24 h later", got.Clearance.ExpiresAt)
	}
	claims, err := h.signer.Verify(got.Clearance.Token)
	if err != nil || claims.EntryID != e.ID || claims.Callsign != "Nova Pilot" {
		t.Errorf("token claims %+v, err %v", claims, err)
	}
	// The entry keys are exactly the documented ones.
	var raw map[string]map[string]any
	json.Unmarshal(r.body, &raw)
	keys := []string{}
	for k := range raw["entry"] {
		keys = append(keys, k)
	}
	if len(keys) != 10 {
		t.Errorf("entry keys = %v", keys)
	}
}

func TestPostRunUnclearedGetsNoClearance(t *testing.T) {
	h := newHarness(t)
	for _, name := range []string{"below the minimum rule", "partial run ending uncleared"} {
		h.clock.Advance(time.Minute)
		r := h.postJSON("/api/runs", runBody("Nova", fixtureSectors(t, name)))
		if r.status != 201 {
			t.Fatalf("%s: %d %s", name, r.status, r.body)
		}
		m := r.json(t)
		if m["clearance"] != nil {
			t.Errorf("%s: clearance = %v, want null", name, m["clearance"])
		}
		if _, ok := m["clearance"]; !ok {
			t.Errorf("%s: clearance key missing", name)
		}
		if m["entry"].(map[string]any)["cleared"] != false {
			t.Errorf("%s: cleared should be false", name)
		}
	}
}

// Every fixture case through the real endpoint: the server's verdict on a
// run is exactly scoring.js's.
func TestPostRunMatchesFixture(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Limits.RunsBurst = 1000 })
	for _, c := range fixtureRuns(t) {
		t.Run(c.Name, func(t *testing.T) {
			r := h.postJSON("/api/runs", runBody("Fixture", string(c.Sectors)))
			if c.Error != nil {
				m := checkError(t, r, 400, "invalid_run")
				if m["field"] != c.Error.Field || m["message"] != c.Error.Message {
					t.Fatalf("got %s, want %+v", r.body, *c.Error)
				}
				return
			}
			if r.status != 201 {
				t.Fatalf("status %d: %s", r.status, r.body)
			}
			e := r.json(t)["entry"].(map[string]any)
			if e["score"] != float64(c.Expect.Score) || e["integrity"] != float64(c.Expect.Integrity) ||
				e["rank"] != c.Expect.Rank || e["readinessLevel"] != float64(c.Expect.ReadinessLevel) ||
				e["sectorsCleared"] != float64(c.Expect.SectorsCleared) || e["cleared"] != c.Expect.Cleared {
				t.Fatalf("entry %v, want %+v", e, *c.Expect)
			}
			if hasClr := r.json(t)["clearance"] != nil; hasClr != c.Expect.Cleared {
				t.Fatalf("clearance present = %v, cleared = %v", hasClr, c.Expect.Cleared)
			}
		})
	}
}

func TestPostRunErrors(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Limits.RunsBurst = 1000 })
	valid := fixtureSectors(t, "minimal clearing run")
	cases := []struct {
		name    string
		ctype   string
		body    string
		status  int
		code    string
		field   string
		message string
	}{
		{"not json", "application/json", `{"callsign":`, 400, "invalid_json", "", ""},
		{"json array", "application/json", `[]`, 400, "invalid_json", "", ""},
		{"json null", "application/json", `null`, 400, "invalid_json", "", ""},
		{"trailing data", "application/json", `{} {}`, 400, "invalid_json", "", ""},
		{"empty body", "application/json", ``, 400, "invalid_json", "", ""},
		{"text/plain", "text/plain", runBody("Nova", valid), 415, "unsupported_media_type", "", ""},
		{"no content type", "", runBody("Nova", valid), 415, "unsupported_media_type", "", ""},
		{"json with charset is fine", "application/json; charset=utf-8", runBody("Nova", valid), 201, "", "", ""},
		{"too large", "application/json", `{"callsign":"Nova","pad":"` + strings.Repeat("x", 17<<10) + `"}`, 413, "too_large", "", ""},
		{"callsign missing", "application/json", `{"sectors":` + valid + `}`, 400, "invalid_callsign", "callsign", ""},
		{"callsign a number", "application/json", `{"callsign":12345,"sectors":` + valid + `}`, 400, "invalid_callsign", "callsign", ""},
		{"callsign too short", "application/json", runBody("N", valid), 400, "invalid_callsign", "callsign", ""},
		{"callsign too long", "application/json", runBody("Nova Pilot Seventeen", valid), 400, "invalid_callsign", "callsign", ""},
		{"callsign bad character", "application/json", runBody("Nova<script>", valid), 400, "invalid_callsign", "callsign", ""},
		{"callsign key is case-sensitive", "application/json", `{"CALLSIGN":"Nova","sectors":` + valid + `}`, 400, "invalid_callsign", "callsign", ""},
		{"sectors missing", "application/json", `{"callsign":"Nova"}`, 400, "invalid_run", "sectors", "a run needs at least one sector"},
		{"bad run", "application/json", runBody("Nova", `[{"id":"triage-belt"}]`), 400, "invalid_run", "sectors[0].id", "expected sector purpose-rift"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hd := map[string]string{}
			if tc.ctype != "" {
				hd["Content-Type"] = tc.ctype
			}
			r := h.do(http.MethodPost, "/api/runs", tc.body, hd)
			checkSecurityHeaders(t, tc.name, r.header)
			if tc.code == "" {
				if r.status != tc.status {
					t.Fatalf("status %d: %s", r.status, r.body)
				}
				return
			}
			m := checkError(t, r, tc.status, tc.code)
			if tc.field != "" && m["field"] != tc.field {
				t.Errorf("field = %v, want %s", m["field"], tc.field)
			}
			if tc.message != "" && m["message"] != tc.message {
				t.Errorf("message = %v, want %s", m["message"], tc.message)
			}
		})
	}
}

func TestRunRateLimit(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.TrustProxy = true })
	body := runBody("Nova", fixtureSectors(t, "minimal clearing run"))
	post := func(ip string) response {
		return h.postJSON("/api/runs", body, "X-Forwarded-For", ip)
	}
	for i := 0; i < 3; i++ {
		if r := post("203.0.113.7"); r.status != 201 {
			t.Fatalf("burst request %d: %d", i, r.status)
		}
	}
	r := post("203.0.113.7")
	m := checkError(t, r, 429, "rate_limited")
	if m["retryAfterSec"] != float64(12) || r.header.Get("Retry-After") != "12" {
		t.Errorf("retry after: body %v, header %q (5 per minute refills one every 12 s)", m["retryAfterSec"], r.header.Get("Retry-After"))
	}
	checkSecurityHeaders(t, "429", r.header)
	// Invalid requests also spend tokens: the limit protects the parser too.
	if r := h.postJSON("/api/runs", "{", "X-Forwarded-For", "203.0.113.7"); r.status != 429 {
		t.Errorf("garbage while limited: %d", r.status)
	}
	// Another client is unaffected.
	if r := post("198.51.100.1"); r.status != 201 {
		t.Errorf("other client: %d", r.status)
	}
	h.clock.Advance(11 * time.Second)
	if r := post("203.0.113.7"); r.status != 429 {
		t.Errorf("after 11 s: %d", r.status)
	}
	h.clock.Advance(time.Second)
	if r := post("203.0.113.7"); r.status != 201 {
		t.Errorf("after 12 s: %d", r.status)
	}
}

func TestRateLimitIgnoresForwardedForWithoutTrustProxy(t *testing.T) {
	h := newHarness(t)
	body := runBody("Nova", fixtureSectors(t, "minimal clearing run"))
	statuses := []int{}
	for i := 0; i < 4; i++ {
		// A client rotating X-Forwarded-For must not get a fresh bucket.
		r := h.postJSON("/api/runs", body, "X-Forwarded-For", fmt.Sprintf("10.0.0.%d", i))
		statuses = append(statuses, r.status)
	}
	if fmt.Sprint(statuses) != "[201 201 201 429]" {
		t.Errorf("statuses = %v", statuses)
	}
}

func TestUnknownRoutesAndMethods(t *testing.T) {
	h := newHarness(t)
	for _, tc := range []struct {
		method, path string
		status       int
		code         string
		allow        string
	}{
		{"GET", "/api/nope", 404, "not_found", ""},
		{"POST", "/api/nope", 404, "not_found", ""},
		{"GET", "/api", 404, "not_found", ""},
		{"POST", "/api/health", 405, "method_not_allowed", "GET, HEAD"},
		{"DELETE", "/api/runs", 405, "method_not_allowed", "POST"},
		{"GET", "/api/runs", 405, "method_not_allowed", "POST"},
		{"PUT", "/index.html", 405, "method_not_allowed", "GET, HEAD"},
		{"GET", "/missing.html", 404, "not_found", ""},
		{"GET", "/assets/video/unused/", 404, "not_found", ""},
	} {
		r := h.do(tc.method, tc.path, "", nil)
		checkError(t, r, tc.status, tc.code)
		checkSecurityHeaders(t, tc.method+" "+tc.path, r.header)
		if tc.allow != "" && r.header.Get("Allow") != tc.allow {
			t.Errorf("%s %s: Allow = %q, want %q", tc.method, tc.path, r.header.Get("Allow"), tc.allow)
		}
	}
}

func TestStaticFiles(t *testing.T) {
	h := newHarness(t)
	for _, tc := range []struct {
		path, ctype, cache, body string
	}{
		{"/", "text/html; charset=utf-8", "no-cache", "landing"},
		{"/index.html", "text/html; charset=utf-8", "no-cache", "landing"},
		{"/play.html", "text/html; charset=utf-8", "no-cache", "play"},
		{"/guide/", "text/html; charset=utf-8", "no-cache", "guide"},
		{"/css/site.css", "text/css; charset=utf-8", "no-cache", "color"},
		{"/js/app.js", "text/javascript; charset=utf-8", "no-cache", "x = 1"},
		{"/js/mod.mjs", "text/javascript; charset=utf-8", "no-cache", "y = 2"},
		{"/data/rulebook.json", "application/json; charset=utf-8", "no-cache", "schemaVersion"},
		{"/assets/video/loop.webm", "video/webm", "public, max-age=2592000", ""},
		{"/assets/img/poster.webp", "image/webp", "public, max-age=2592000", "WEBP"},
		{"/blob.bin", "application/octet-stream", "no-cache", ""},
	} {
		r := h.get(tc.path)
		if r.status != 200 {
			t.Errorf("%s: status %d", tc.path, r.status)
			continue
		}
		if r.header.Get("Content-Type") != tc.ctype || r.header.Get("Cache-Control") != tc.cache {
			t.Errorf("%s: type %q cache %q", tc.path, r.header.Get("Content-Type"), r.header.Get("Cache-Control"))
		}
		if !strings.Contains(string(r.body), tc.body) {
			t.Errorf("%s: body %q", tc.path, r.body)
		}
		if r.header.Get("ETag") == "" {
			t.Errorf("%s: no ETag", tc.path)
		}
		checkSecurityHeaders(t, tc.path, r.header)
	}

	// Revalidation with the ETag answers 304.
	first := h.get("/play.html")
	again := h.do("GET", "/play.html", "", map[string]string{"If-None-Match": first.header.Get("ETag")})
	if again.status != http.StatusNotModified || len(again.body) != 0 {
		t.Errorf("revalidation: %d, %d bytes", again.status, len(again.body))
	}
	// Video seeks with byte ranges.
	part := h.do("GET", "/assets/video/loop.webm", "", map[string]string{"Range": "bytes=0-3"})
	if part.status != http.StatusPartialContent || len(part.body) != 4 {
		t.Errorf("range: %d, %d bytes", part.status, len(part.body))
	}
	// HEAD has headers and no body.
	head := h.do("HEAD", "/", "", nil)
	if head.status != 200 || len(head.body) != 0 || head.header.Get("Content-Type") == "" {
		t.Errorf("HEAD /: %d %d", head.status, len(head.body))
	}
}

func TestStaticRedirectsAndTraversal(t *testing.T) {
	h := newHarness(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(h.ts.URL + "/guide")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMovedPermanently || res.Header.Get("Location") != "/guide/" {
		t.Errorf("/guide: %d -> %q", res.StatusCode, res.Header.Get("Location"))
	}
	// Raw request paths that try to climb out of the site.
	for _, p := range []string{"/../go.mod", "/%2e%2e/go.mod", "/css/../../embed.go", "/..%2fembed.go"} {
		req := httptest.NewRequest("GET", "http://x"+p, nil)
		w := httptest.NewRecorder()
		h.srv.ServeHTTP(w, req)
		if w.Code == 200 {
			t.Errorf("%s served a file", p)
		}
	}
}

func TestStaticServesCustom404Page(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		site := testSite(t)
		site["404.html"] = &fstestFile404
		c.Site = site
	})
	r := h.get("/nowhere")
	if r.status != 404 || !strings.Contains(string(r.body), "lost in space") || !strings.HasPrefix(r.header.Get("Content-Type"), "text/html") {
		t.Errorf("custom 404: %d %q %q", r.status, r.header.Get("Content-Type"), r.body)
	}
	// API paths still answer JSON.
	checkError(t, h.get("/api/nowhere"), 404, "not_found")
}

func TestEmbeddedSiteServes(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Site = embeddedSite(t) })
	for _, p := range []string{"/play.html", "/js/scoring.js", "/js/api.js", "/data/models.json", "/css/tokens.css"} {
		if r := h.get(p); r.status != 200 {
			t.Errorf("%s: %d", p, r.status)
		}
	}
	// The landing page is another builder's file; when it exists it is "/".
	if _, err := fs.Stat(embeddedSite(t), "index.html"); err == nil {
		if r := h.get("/"); r.status != 200 || !strings.HasPrefix(r.header.Get("Content-Type"), "text/html") {
			t.Errorf("/: %d", r.status)
		}
	}
	// web/api/health is the static-host marker ({"status":"solo"}); on the
	// fleet server the real route must answer instead, or every browser
	// would think it is in solo mode.
	if _, err := fs.Stat(embeddedSite(t), "api/health"); err != nil {
		t.Errorf("web/api/health marker missing: %v", err)
	}
	r := h.get("/api/health")
	if m := r.json(t); r.status != 200 || m["status"] != "ok" {
		t.Errorf("/api/health with the marker embedded: %d %s", r.status, r.body)
	}
}

func TestPanicRecovery(t *testing.T) {
	h := newHarness(t)
	boom := h.srv.observe(securityHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})))
	w := httptest.NewRecorder()
	boom.ServeHTTP(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != 500 || !strings.Contains(w.Body.String(), `"error":"internal"`) {
		t.Errorf("panic answered %d %s", w.Code, w.Body)
	}
	checkSecurityHeaders(t, "panic", w.Header())
	if !strings.Contains(h.logs.String(), "panic serving request") {
		t.Error("panic not logged")
	}

	abort := h.srv.observe(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }))
	defer func() {
		if v := recover(); v != http.ErrAbortHandler {
			t.Errorf("ErrAbortHandler must propagate, got %v", v)
		}
	}()
	abort.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil))
}

func TestAccessLogHasNoQueryOrAddress(t *testing.T) {
	h := newHarness(t)
	h.do("GET", "/api/leaderboard?limit=5&secret=abc", "", map[string]string{"X-Forwarded-For": "192.0.2.99"})
	logs := h.logs.String()
	if !strings.Contains(logs, "path=/api/leaderboard") || !strings.Contains(logs, "status=200") {
		t.Errorf("request not logged: %s", logs)
	}
	if strings.Contains(logs, "secret=abc") || strings.Contains(logs, "127.0.0.1") || strings.Contains(logs, "192.0.2.99") {
		t.Errorf("log leaks query or address: %s", logs)
	}
}

func TestExpiredClearanceHelper(t *testing.T) {
	// Sanity for the console tests: the harness signer follows the fake clock.
	h := newHarness(t)
	tok, _, _ := h.signer.Issue("e", "Nova")
	h.clock.Advance(clearance.DefaultTTL)
	if _, err := h.signer.Verify(tok); err == nil {
		t.Fatal("token should have expired")
	}
}

// The route table and the mux must agree, or a documented endpoint would
// fall through to the static site.
func TestRouteTableMatchesMux(t *testing.T) {
	h := newHarness(t)
	for path, allow := range apiRoutes {
		for _, m := range strings.Split(allow, ", ") {
			_, pattern := h.srv.mux.Handler(httptest.NewRequest(m, path, nil))
			if pattern == "" || pattern == "GET /" {
				t.Errorf("%s %s is routed to %q", m, path, pattern)
			}
		}
	}
}

func TestHeadOnFleetStreamReturns(t *testing.T) {
	h := newHarness(t)
	done := make(chan response, 1)
	go func() { done <- h.do("HEAD", "/api/fleet/stream", "", nil) }()
	select {
	case r := <-done:
		if r.status != 200 || r.header.Get("Content-Type") != "text/event-stream; charset=utf-8" {
			t.Errorf("HEAD stream: %d %v", r.status, r.header)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("HEAD on the stream did not return")
	}
	if h.board.Feed().Len() != 0 {
		t.Error("HEAD subscribed to the feed")
	}
}
