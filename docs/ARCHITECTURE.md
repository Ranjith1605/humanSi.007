# HumanSI Synergy: Architecture

HumanSI Synergy is a minimal, cinematic space game that teaches a Rule Book.
The Rule Book has two parts:

- **The Charter** (`charter`): the HumanSI mission, five core values with three
  articles each, the vision and the oath. This part says *why* humans and SI work together.
- **The Six Gates** (`method`): an operating method. Before an SI system touches
  a real decision it passes six gates (M1–M6 / G1–G6), each with one hard question
  and a verdict: **pass, revise or stop**. It also covers Shu-Ha-Ri, the eight crew
  roles (RACI), the minimum rule ("no use case enters live deployment below
  readiness Level 3") and the integrity rules. This part says *how*.

The game flies six sectors, one per gate. Each sector's flight mechanic acts out
its module, and at the gate the pilot gives verdicts on two real-world-style
scenarios. Clearing all six gates at readiness Level 3 or above earns
**launch clearance**, which unlocks the **Model Hangar**: a catalog of open-source
and open-weight AI models. On the fleet server it also unlocks the **SI console**,
a chat with a local open-source model (via Ollama) that is grounded in the Rule
Book and practises what it preaches: labelled as SI, a human stop button, logged.

## Content rules (non-negotiable)

- **Source material.** The method comes from the author's private playbook, and
  only the parts that playbook itself marks as publishable are used: the six
  modules, gate questions, artefact list, Shu-Ha-Ri, crew roles, minimum rule and
  evidence discipline. **Never add** pricing, offers, market or segment analysis,
  go-to-market plans, partner terms, survey figures, client names, personal or
  residence details, or the playbook's title.
- **Disclaimer.** `rulebook.disclaimer` ("orientation, not legal advice; does not
  license or certify anyone") must appear on the landing page, at the start of the
  game and in the hangar.
- **No hard-coded law dates.** Name articles (Art. 4, 5, 13–14, 26, 27, 50,
  Annex III, Annex XI) but never application dates.
- **No fabricated data.** No invented pilots, scores, counters, user numbers or
  "live" labels on anything not live. An empty board says it is empty. Solo mode
  says scores stay on this device. The console says "no model connected" when none is.
- **Single sources.** All text comes from `web/data/rulebook.json` and
  `web/data/models.json`; scoring and validation rules from `web/js/scoring.js`;
  server access from `web/js/api.js`. Do not duplicate their text or logic.

## Two ways to run, one front end

| Mode | How it runs | Board | Clearance | SI console |
|------|-------------|-------|-----------|------------|
| **fleet** | `go run ./cmd/humansi` serves `web/` plus the API | shared, server-scored, live SSE feed | server-signed token (HMAC, 24 h) | yes, if `HUMANSI_OLLAMA_URL` points at Ollama |
| **solo** | `web/` as static files (GitHub Pages, `python3 -m http.server -d web`) | this browser only | a local record that unlocks the hangar view | no; the hangar shows how to connect one |

`web/js/api.js` probes `api/health` once and picks the mode. All front-end URLs
are relative so the site works at `/` (Go server) and at `/humanSi.007/web/` (Pages).
A root `index.html` redirects Pages visitors from `/humanSi.007/` to `web/`, and a
root `.nojekyll` stops Jekyll from processing the site.

## Repository layout

```
go.mod                     module github.com/Ranjith1605/humanSi.007 (go 1.22, standard library only)
embed.go                   package humansi: //go:embed all:web → var Web embed.FS
cmd/humansi/main.go        flags/env, wiring, graceful shutdown
internal/rulebook/         load + validate rulebook.json and models.json from the embedded FS
internal/game/             run validation + scoring, a mirror of web/js/scoring.js
internal/leaderboard/      in-memory store, atomic JSON persistence, pub/sub
internal/clearance/        HMAC launch-clearance tokens
internal/copilot/          Ollama client (tags + streaming chat), system prompt from the Rule Book
internal/api/              handlers, middleware (security headers, rate limits, body limits, logging), SSE
testdata/score-cases.json  shared scoring fixture (Go + JS)
index.html  .nojekyll      Pages redirect into web/
web/
  index.html               landing: cinematic hero, Charter, Six Gates, Shu-Ha-Ri, crew, fleet board
  play.html                the game
  hangar.html              Model Hangar + SI console
  data/rulebook.json  data/models.json
  css/tokens.css  css/landing.css  css/game.css  css/hangar.css
  js/api.js  js/scoring.js  js/scoring.test.mjs  js/landing.js  js/hangar.js  js/game/*.js
  assets/img/  assets/video/
scripts/build-media.sh     regenerates every image/video variant from the original image
docs/ARCHITECTURE.md
```

## HTTP API (fleet mode)

JSON throughout. Errors are `{"error":"<code>","message":"…","field":"…"?}`.

| Method | Path | Response |
|--------|------|----------|
| GET  | `/api/health` | `200 {"status":"ok","version":string,"uptimeSec":int,"copilot":bool}`. `copilot` is true when an Ollama URL is configured |
| GET  | `/api/rulebook` | `200` the rule book exactly as in `web/data/rulebook.json` |
| GET  | `/api/leaderboard?limit=N` | `200 {"entries":[Entry…],"total":int}`; `limit` 1–50, default 10 |
| POST | `/api/runs` | body `{"callsign","sectors":[SectorResult…]}` → `201 {"entry":Entry,"placement":int,"clearance":{"token","expiresAt"}|null}` |
| GET  | `/api/fleet/stream` | SSE: `event: run` / `data: Entry` per accepted run; `: ping` every 25 s |
| GET  | `/api/copilot/status` | `200 {"available":bool,"models":[tag…],"reason":string|null}`. `models` = hangar `ollama` tags actually installed on the Ollama server (matched on the name before `:`; installed full tags such as `qwen2.5:0.5b` are returned) |
| POST | `/api/copilot` | `Authorization: Bearer <clearance>`; body `{"model":tag,"messages":[{"role":"user"|"assistant","content":string}…]}` → `200 text/event-stream`: `event: token` `data: {"t":"…"}` …, then `event: done` `data: {}`; or `event: error` `data: {"error","message"}` |
| GET  | anything else | static files from embedded `web/` (`/` → `index.html`) |

`SectorResult`, validation and scoring are defined by `web/js/scoring.js`. The
server ignores any client-side score and computes `score`, `integrity`, `rank`,
`sectorsCleared`, `readinessLevel` and `cleared` itself.

`Entry` = `{"id","callsign","score","rank","rankName","sectorsCleared","integrity","readinessLevel","cleared","createdAt"}`
(`createdAt` is RFC 3339 UTC; `id` is 16 random hex characters).

POST `/api/runs` errors: `400 invalid_json`, `400 invalid_callsign` (rule:
`CALLSIGN_PATTERN` after trimming and collapsing whitespace), `400 invalid_run`
(with `field`/`message` from validation), `413 too_large` (body > 16 KiB),
`415 unsupported_media_type`, `429 rate_limited` (with `retryAfterSec`).

Clearance is issued only when `cleared` is true (all sectors cleared and
readiness ≥ `method.minimumRule.level`). The token is `base64url(payload).base64url(hmac)`,
where the payload holds the entry id, callsign and expiry. It is signed with
`HUMANSI_SECRET`, or with a random per-process key if that is unset (tokens then
die on restart, which the README says).

POST `/api/copilot` rules: valid, unexpired clearance (else `401 no_clearance`);
the console configured (else `503 copilot_offline`); `model` must be a hangar model
installed on the Ollama server (else `400 unknown_model`); 1–12 messages, each
1–2000 characters, the last from `user` (else `400 invalid_messages`); 10 requests
per minute per IP and 1 concurrent stream per token (`429`). The server prepends
a system prompt built from the Rule Book: answer as the ISV Synergy's SI console,
ground answers in the Charter and the Six Gates and cite gate and article ids,
say "orientation, not legal advice" when law comes up, admit when unsure, and be
concise. It streams from Ollama `POST /api/chat` with `stream: true`. A client
disconnect cancels the upstream request (the human override really stops
generation). Logs record model, duration and token count, never message content.

Server behaviour:
- Flags with env fallbacks: `-addr`/`HUMANSI_ADDR` (`:8080`), `-data`/`HUMANSI_DATA_DIR`
  (`./data`), `-trust-proxy`/`HUMANSI_TRUST_PROXY` (use `X-Forwarded-For` only when
  set), `-ollama`/`HUMANSI_OLLAMA_URL` (empty means console off), `HUMANSI_SECRET`.
- Board persisted to `<data>/leaderboard.json` by write-temp-then-rename; best 500
  entries kept; loaded on start. A corrupt file is renamed to
  `leaderboard.json.corrupt-<unix>` and logged, never silently discarded.
- `POST /api/runs`: token bucket per client IP, 5 per minute, burst 3; idle buckets evicted.
- SSE: at most 200 subscribers (503 beyond); slow subscribers are dropped rather
  than blocking; streams end on shutdown.
- Security headers on every response: a CSP of `default-src 'self'`, Google Fonts
  allowed (`style-src 'self' https://fonts.googleapis.com`,
  `font-src https://fonts.gstatic.com`), `media-src 'self'`, `img-src 'self' data:`,
  `connect-src 'self'`; plus `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`.
  No inline scripts anywhere in `web/` (the CSP forbids them).
- `log/slog` structured logs; graceful shutdown on SIGINT/SIGTERM.
- Caching: `no-cache` for html/json/js/css; long max-age for `assets/`.

## Media

Generated by `scripts/build-media.sh` from `web/assets/img/crew-briefing-original.jpg`
(896×1200): the crew in the ship's briefing room, the captain under the skylight
with a holographic halo, holding the ship's penguin navigator, the crew of many
roles gathered around the table.

| File | What |
|------|------|
| `assets/img/crew-briefing.webp`, `.jpg` | full image, web-optimised |
| `assets/img/briefing-poster-16x9.webp`, `.jpg` | 1280×720 landscape crop |
| `assets/img/briefing-poster-9x16.webp`, `.jpg` | 720×1280 portrait crop |
| `assets/video/briefing-16x9.webm` (VP9), `.mp4` (H.264) | 1280×720, ~14 s seamless loop, no audio: slow cinematic move from the skylight down to the table, breathing skylight, subtle grain and vignette |
| `assets/video/briefing-9x16.webm`, `.mp4` | 720×1280 portrait version |
| `assets/img/comms-captain.webp` | 256×256 crop of the captain |
| `assets/img/comms-navigator.webp` | 256×256 crop of the penguin |

`<video autoplay muted loop playsinline poster=…>`, choosing 16×9 or 9×16 by
orientation. With `prefers-reduced-motion: reduce`, show the poster only.

## Design direction: minimal and cinematic

Few elements, lots of space, strong type (Orbitron display, Space Grotesk body),
the briefing video as the emotional anchor, glass panels with thin cyan edges,
one accent per gate (the module's `color`). No clutter, no emoji, no fake HUD numbers.
Motion is slow and purposeful. Everything works at 360 px wide with a 16 px gutter
and no horizontal scroll.

## The game (`play.html`)

Characters from the image: **the Captain** (`comms-captain`) and **Nova, the
ship's penguin navigator** (`comms-navigator`). One of them briefs each sector
over comms.

Flow: title (disclaimer, callsign, mode badge) → for each of the six sectors:
briefing (gate number, module name, gate question, mechanic how-to, one comms
line) → flight (~35–45 s) → **gate**: two scenarios. Each is answered PASS /
REVISE / STOP (keys 1/2/3) and immediately explained, with the cited module and
articles shown → next sector. After sector 6: readiness level revealed. At Level 3
or above with every gate cleared, **launch** (finale with the briefing video,
vision and oath, then "Clearance granted → Model Hangar"). Below Level 3 the finale
explains the minimum rule ("no live deployment below Level 3") and offers to fly
again. Then the debrief: per-sector scores, rank (SHU/HA/RI), integrity, readiness,
submission to the fleet board or solo log, and the board itself. If the hull hits
zero, the run ends in that sector (`cleared:false`, all verdicts `-1`) and goes
to the debrief.

Flight: the sector scrolls forward on its own; the pilot steers freely with
inertia. Controls: arrows/WASD; Space = pulse (dignity); P/Esc = pause; M = mute.
Mouse/touch: drag to steer, plus an on-screen pulse button. Drift rocks damage the
hull. Spawn counts come from `sector.spawn` exactly, so counters can never exceed
their caps. Every sector has ordinary `cores`. Mechanics (`sector.mechanic`):

- `scan` (M1 Purpose): hold near a purpose beacon for ~1.2 s → `scans`+1.
- `integrity` (M2 Triage): red shortcut cores show `+shortcutGain` when taken and
  drop integrity by `integrityPerShortcut`; at the gate an integrity audit shows
  `shortcutPenalty` applied. Every shortcut is avoidable.
- `harmonize` (M3 Dignity): no weapons. Space pulses (with a cooldown) and calms
  discord fragments in range → `harmonized`+1 each; untouched fragments hurt like rocks.
- `chain` (M4 Oversight): SI pods (cyan) and human pods (gold). Collecting the
  opposite kind to the last extends the chain (`chainLinks`+1); the same kind
  twice breaks it ("an unchecked SI step").
- `assist` (M5 Adoption): stay near a stranded crew pod for ~1.5 s to tow it →
  `assists`+1, plus a temporary speed and shield boost.
- `review` (M6 Lifecycle): registry satellites orbit; when one flashes amber,
  hold near it for ~1.2 s → `reviews`+1. Each satellite is reviewed at most once.

Results must be exact `SectorResult` objects scored with `scoring.js`. `timeMs`
is simulated time. With `?debug=1` the page exposes
`window.__humansi = { getState(), setTimescale(n) }`, and `?timescale=N` (1–8)
speeds the simulation without changing the reported `timeMs`.

Accessibility: overlays, briefings, the gate, the finale and the debrief are DOM,
not canvas, with focus management and full keyboard support. The canvas has a
text alternative, and all content is also readable on the landing page. Reduced
motion turns off shake and heavy particles. The game pauses when the tab is
hidden. Audio is WebAudio-synthesised, starts only after a gesture, and can be muted.

## The hangar (`hangar.html`)

Locked state (no clearance): a minimal sealed hangar door, what unlocks it (clear
the Six Gates at readiness Level 3+) and a link to fly. The catalog is still
listed by name, so nothing is hidden from people who will not play. Unlocked:
model cards with name, publisher, openness badge (fully open / open weights),
licence with its kind (OSI / custom / mixed), the Ollama command, a source link,
the note, the catalog caveat and the disclaimer. The console panel:

- solo mode: explains the console needs the fleet server plus Ollama and shows
  `runtime.steps`;
- fleet without Ollama: "No open-source model connected" plus the steps;
- fleet with Ollama: a model picker (only installed hangar models), a chat
  transcript where every SI message is labelled "SI-generated · <model> ·
  orientation, not legal advice", a **Stop** button (human override, aborts the
  stream), and starter prompts about the gates.
