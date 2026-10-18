package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/png"
	"io/fs"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

// The installable app (docs/CITY.md, "Install and offline"): browsers only
// accept a manifest served as application/manifest+json, and the service
// worker must revalidate on every check or a version bump never arrives.

func TestStaticServesManifestAndWorker(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		site := testSite(t)
		site["manifest.webmanifest"] = &fstest.MapFile{Data: []byte(`{"name":"HumanSI Synergy"}`)}
		site["sw.js"] = &fstest.MapFile{Data: []byte("const VERSION = '1';")}
		site["assets/icons/icon-192.png"] = &fstest.MapFile{Data: []byte("\x89PNG\r\n\x1a\n")}
		c.Site = site
	})
	for _, tc := range []struct{ path, ctype, cache string }{
		{"/manifest.webmanifest", "application/manifest+json", "no-cache"},
		{"/sw.js", "text/javascript; charset=utf-8", "no-cache"},
		{"/assets/icons/icon-192.png", "image/png", "public, max-age=2592000"},
	} {
		r := h.get(tc.path)
		if r.status != 200 {
			t.Errorf("%s: status %d", tc.path, r.status)
			continue
		}
		if got := r.header.Get("Content-Type"); got != tc.ctype {
			t.Errorf("%s: Content-Type %q, want %q", tc.path, got, tc.ctype)
		}
		if got := r.header.Get("Cache-Control"); got != tc.cache {
			t.Errorf("%s: Cache-Control %q, want %q", tc.path, got, tc.cache)
		}
		checkSecurityHeaders(t, tc.path, r.header)
	}
}

// TestEmbeddedManifest checks the real manifest the binary ships: it parses,
// carries what the install prompt needs, and every icon and shortcut it names
// is served, with the stated type and, for PNGs, the stated pixel size.
func TestEmbeddedManifest(t *testing.T) {
	site := embeddedSite(t)
	if _, err := fs.Stat(site, "manifest.webmanifest"); err != nil {
		t.Skip("web/manifest.webmanifest not present yet")
	}
	h := newHarness(t, func(c *Config) { c.Site = site })
	r := h.get("/manifest.webmanifest")
	if r.status != 200 || r.header.Get("Content-Type") != "application/manifest+json" {
		t.Fatalf("manifest: %d %q", r.status, r.header.Get("Content-Type"))
	}
	type icon struct{ Src, Sizes, Type, Purpose string }
	var m struct {
		ID, Name, Display, Scope string
		ShortName                string `json:"short_name"`
		StartURL                 string `json:"start_url"`
		Background               string `json:"background_color"`
		Theme                    string `json:"theme_color"`
		Icons                    []icon
		Shortcuts                []struct {
			Name, URL string
			Icons     []icon
		}
	}
	if err := json.Unmarshal(r.body, &m); err != nil {
		t.Fatalf("manifest is not JSON: %v", err)
	}
	if m.ID == "" || m.Name != "HumanSI Synergy" || m.ShortName != "HumanSI" || m.Display != "standalone" ||
		m.StartURL != "./index.html" || m.Scope != "./" || m.Background == "" || m.Theme == "" {
		t.Errorf("manifest fields: %+v", m)
	}

	page := func(u string) string { return "/" + strings.TrimPrefix(u, "./") }
	if got := h.get(page(m.StartURL)); got.status != 200 {
		t.Errorf("start_url %s: %d", m.StartURL, got.status)
	}
	icons := append([]icon(nil), m.Icons...)
	for _, s := range m.Shortcuts {
		if got := h.get(page(s.URL)); got.status != 200 {
			t.Errorf("shortcut %q -> %s: %d", s.Name, s.URL, got.status)
		}
		icons = append(icons, s.Icons...)
	}
	var big, maskable bool
	for _, ic := range icons {
		got := h.get("/" + ic.Src)
		if got.status != 200 || got.header.Get("Content-Type") != ic.Type {
			t.Errorf("icon %s: %d %q, want %q", ic.Src, got.status, got.header.Get("Content-Type"), ic.Type)
			continue
		}
		if ic.Type != "image/png" {
			continue
		}
		cfg, err := png.DecodeConfig(bytes.NewReader(got.body))
		if err != nil {
			t.Errorf("icon %s: %v", ic.Src, err)
			continue
		}
		if want := fmt.Sprintf("%dx%d", cfg.Width, cfg.Height); want != ic.Sizes {
			t.Errorf("icon %s is %s, manifest says %s", ic.Src, want, ic.Sizes)
		}
		big = big || cfg.Width >= 512
		maskable = maskable || strings.Contains(ic.Purpose, "maskable")
	}
	if !big || !maskable {
		t.Errorf("install needs a 512 px icon (%v) and a maskable one (%v)", big, maskable)
	}
}

// TestServiceWorkerShellIsServed reads the precache list out of web/sw.js:
// a file the install cannot fetch is a page that will not open offline.
func TestServiceWorkerShellIsServed(t *testing.T) {
	site := embeddedSite(t)
	src, err := fs.ReadFile(site, "sw.js")
	if err != nil {
		t.Skip("web/sw.js not present yet")
	}
	var paths []string
	for _, list := range regexp.MustCompile(`(?s)const (?:PAGES|SHELL) = \[(.*?)\];`).FindAllSubmatch(src, -1) {
		for _, m := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(list[1], -1) {
			paths = append(paths, string(m[1]))
		}
	}
	if len(paths) < 10 {
		t.Fatalf("found only %d precache entries in sw.js; did the list's shape change?", len(paths))
	}
	h := newHarness(t, func(c *Config) { c.Site = site })
	for _, p := range paths {
		if strings.HasPrefix(p, "assets/video/") || strings.HasPrefix(p, "api/") {
			t.Errorf("%s must never be precached", p)
		}
		if r := h.get("/" + p); r.status != 200 {
			t.Errorf("precached %s: %d", p, r.status)
		}
	}
}
