package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

// contentTypes is an explicit table: the server must not depend on the
// host's /etc/mime.types (the container image has none), and Go's builtin
// table lacks .webm and .mp4.
var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".txt":         "text/plain; charset=utf-8",
	".md":          "text/markdown; charset=utf-8",
	".xml":         "application/xml",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".webp":        "image/webp",
	".avif":        "image/avif",
	".gif":         "image/gif",
	".ico":         "image/x-icon",
	".webm":        "video/webm",
	".mp4":         "video/mp4",
	".woff2":       "font/woff2",
	".woff":        "font/woff",
	".wasm":        "application/wasm",
}

// Cache policy: pages, data, scripts and styles revalidate every time (they
// change together and must stay in step); media under assets/ is large and
// rarely changes, so browsers may keep it for 30 days.
const (
	cacheRevalidate = "no-cache"
	cacheAssets     = "public, max-age=2592000"
)

// static serves the embedded site. "/" and any "dir/" serve index.html;
// a directory without its slash is redirected so relative URLs resolve.
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path // never under /api: route() answers those
	name := strings.TrimPrefix(path.Clean("/"+p), "/")
	if name == "" || strings.HasSuffix(p, "/") {
		name = path.Join(name, "index.html")
	}
	if !fs.ValidPath(name) {
		s.notFound(w, r)
		return
	}
	f, err := s.cfg.Site.Open(name)
	if err != nil {
		s.notFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		s.notFound(w, r)
		return
	}
	if info.IsDir() {
		if _, err := fs.Stat(s.cfg.Site, path.Join(name, "index.html")); err == nil {
			http.Redirect(w, r, path.Base(name)+"/", http.StatusMovedPermanently)
			return
		}
		s.notFound(w, r)
		return
	}
	s.serveFile(w, r, name, f, http.StatusOK)
}

// notFound serves the site's 404.html when it has one (the same file
// GitHub Pages would use), otherwise the JSON error.
func (s *Server) notFound(w http.ResponseWriter, r *http.Request) {
	if f, err := s.cfg.Site.Open("404.html"); err == nil {
		defer f.Close()
		if info, err := f.Stat(); err == nil && !info.IsDir() {
			s.serveFile(w, r, "404.html", f, http.StatusNotFound)
			return
		}
	}
	writeError(w, http.StatusNotFound, "not_found", "Not found.", "")
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, name string, f fs.File, status int) {
	h := w.Header()
	ct, ok := contentTypes[strings.ToLower(path.Ext(name))]
	if !ok {
		ct = "application/octet-stream"
	}
	h.Set("Content-Type", ct)
	if strings.HasPrefix(name, "assets/") {
		h.Set("Cache-Control", cacheAssets)
	} else {
		h.Set("Cache-Control", cacheRevalidate)
	}

	rs, ok := f.(io.ReadSeeker)
	if !ok {
		data, err := io.ReadAll(f)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "Could not read the file.", "")
			return
		}
		rs = bytes.NewReader(data)
	}
	if status != http.StatusOK {
		// Error pages are not cacheable resources and ignore ranges.
		h.Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		if r.Method != http.MethodHead {
			_, _ = io.Copy(w, rs)
		}
		return
	}
	// The embedded files carry no modification time, so an ETag is what
	// lets "no-cache" revalidate with a cheap 304 instead of a re-download.
	if tag, err := s.etag(name, rs); err == nil {
		h.Set("ETag", tag)
	}
	http.ServeContent(w, r, name, time.Time{}, rs)
}

func (s *Server) etag(name string, rs io.ReadSeeker) (string, error) {
	if v, ok := s.etags.Load(name); ok {
		return v.(string), nil
	}
	sum := sha256.New()
	if _, err := io.Copy(sum, rs); err != nil {
		return "", err
	}
	if _, err := rs.Seek(0, io.SeekStart); err != nil {
		return "", errors.Join(err, errors.New("api: cannot rewind "+name))
	}
	tag := `"` + base64.RawURLEncoding.EncodeToString(sum.Sum(nil)[:18]) + `"`
	s.etags.Store(name, tag)
	return tag, nil
}
