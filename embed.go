// Package humansi holds the files the fleet server ships inside its binary.
//
// The whole web/ directory is embedded, so one static binary serves the
// landing page, the game, the hangar and the Rule Book with nothing beside it
// on disk. The "all:" prefix keeps files whose names start with "." or "_"
// (embed skips those by default), so what the binary serves is exactly what
// GitHub Pages serves from the same directory.
package humansi

import "embed"

// Web is the repository's web/ directory. Use fs.Sub(Web, "web") to get a
// file system rooted at the site.
//
//go:embed all:web
var Web embed.FS
