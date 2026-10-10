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

The game, *Nova Run*, is an original fast side-scrolling platformer with six
levels, one per gate. Each level's mechanic acts out its module, and at the gate the pilot gives verdicts on two real-world-style
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
  js/api.js  js/scoring.js  js/scoring.test.mjs  js/landing.js  js/hangar.js
  js/game/*.js  js/game/levels/*.js  js/game/levels.test.mjs
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

## Design direction: minimal pages, a vivid game

The landing page and the hangar are minimal and cinematic: few elements, lots of
space, strong type (Orbitron display, Space Grotesk body), the briefing video as
the emotional anchor, glass panels with thin cyan edges, and one accent per gate
(the module's `color`). No clutter, no emoji, no fake HUD numbers. Everything
works at 360 px wide with a 16 px gutter and no horizontal scroll.

The game is the opposite on purpose: vivid, fast, colourful, crafted, like the
great 90s PC side-scrolling platformers people played for hours. It uses **all
original** characters, art, names and level design. Nothing is copied from any
existing game.

## The game: *Nova Run* (`play.html`)

An original, fast side-scrolling platformer. The hero is **Nova, the ship's
penguin navigator** from the briefing image, re-imagined as a quick, springy
space-penguin with a visor and a small thruster pack. **The Captain**
(`comms-captain`) and Nova (`comms-navigator`) brief each level over comms.

### Feel (this is what makes it addictive, so get it right)
- **Speed and momentum**: quick acceleration, high top speed, a little skid on
  turning, run momentum carried into jumps.
- **Jump**: variable height (release early for a short hop), coyote time (~100 ms),
  jump buffering (~120 ms), and a **flap-glide**: hold jump in the air to slow the
  fall, the penguin's thruster flutter.
- **Level toys**: springs (big bounces), speed boosters (dash strips), one-way
  platforms, moving platforms, crumbling platforms, and wind or updraft columns in
  some worlds.
- **Secrets everywhere**: hidden alcoves and breakable or false walls holding gems.
  Every spawn must still be reachable, and the gate itself must never need a secret.
- **Juice**: squash and stretch, dust puffs, sparkle bursts on pickup, gentle screen
  shake on hits (off with reduced motion), a pickup "streak" counter with rising
  chime pitch, smooth camera with look-ahead, and 3–4 parallax background layers.
- **Hull** is shown as 5 energy cells (each 20 hull). A hit costs one cell, gives
  knockback and ~1 s of invulnerability blink. Falling into a pit respawns Nova at
  the last checkpoint beacon and costs one cell. Zero cells ends the run in that
  level (`cleared:false`, all verdicts `-1`) and goes to the debrief.
- **Harmony pulse** (X/J/Enter, or the touch button): Nova's only "blaster", and it
  is not a weapon. Rings of light that **calm** creatures. Calmed discord critters
  (M3) turn into friendly sparkles (`harmonized`+1). Glitch-bots (the `drift`
  hazards, in every level) are only stunned for ~2 s and score nothing. Pulse has a
  short cooldown.
- **Replay hooks**, all real and local: per-level best time and completion %
  (gems, mechanic items, correct verdicts) saved in `localStorage`, and a level
  **seal** (bronze, silver or gold) for completion. These are personal records
  only; the score itself always comes from `scoring.js`, and the streak counter is
  flair that does not change it.

### Look
A crisp neo-retro pixel-art look. Render the world at a low internal resolution
(e.g. 480×270, adapting to the aspect ratio) and upscale with nearest-neighbour
(`image-rendering: pixelated`, integer scaling where possible). Draw tiles, the
penguin sprite (idle, run cycle, jump, fall, glide, hurt, pulse) and props
**procedurally in code** (pixel arrays or canvas drawing at native resolution,
cached to offscreen canvases): rich, saturated per-world palettes, highlights
and dithering, no external sprite files. Each world has its own palette and
backdrop:

| Level | World | Palette and backdrop |
|-------|-------|----------------------|
| G1 Purpose Rift | crystal caverns | violet and magenta crystals, glowing geodes, a distant nebula |
| G2 Triage Belt | asteroid mining rigs | rust, steel, warning red, scaffolds over the void |
| G3 Dignity Expanse | biodome gardens | lush greens, water, sunlight shafts through the dome |
| G4 Oversight Nebula | data city | cyan neon, glass towers, gentle rain |
| G5 Adoption Drift | engineering deck | amber pipes, steam, conveyor belts |
| G6 Lifecycle Orbit | orbital station | gold and white, Earth-like planet rising, star trails |

### Structure
Title (disclaimer, callsign, mode badge, controls, level select limited to levels
already reached on this device; a full run always starts at G1) → for each level:
briefing card (gate number, module name, gate question, mechanic how-to, comms
line) → run → **gate archway** at the end → gate overlay with two scenarios, each
answered PASS / REVISE / STOP (keys 1/2/3) and immediately explained, with the
cited module and articles → next level. After G6: readiness reveal → launch finale
(briefing video, vision, oath, "Clearance granted → Model Hangar") at Level 3+ with
every gate cleared, or the minimum-rule ending ("no live deployment below
Level 3", fly again) → debrief (per-level scores, rank SHU/HA/RI, integrity,
readiness, seals, submission to the fleet board or solo log, and the board).

Levels are hand-designed tile maps (string rows plus an entity legend) in
`web/js/game/levels/`. Each is ~250–400 tiles wide, takes ~35–60 s for a
first-time player, and has a start, at least one checkpoint and the gate. Entity
counts must equal `sector.spawn` **exactly**: `cores` (gems), `humanPods` +
`siPods`, `stranded` (crew capsules), `discord` (critters), `anomalies` (purpose
beacons), `satellites` (registry terminals), `shortcuts` (red cores) and `drift`
(glitch-bots and spike traps). A node test (`web/js/game/levels.test.mjs`,
`node --test`) checks every level against the rule book: counts, exactly one start,
exactly one gate, at least one checkpoint, rectangular rows, and every entity on a
non-solid tile.

Mechanics (`sector.mechanic`) as platformer actions:
- `scan` (M1): stand within range of a purpose beacon; a ring fills over ~1.2 s → `scans`+1.
- `integrity` (M2): red shortcut cores float over risky fast routes. Taking one
  shows `+shortcutGain` and drops integrity by `integrityPerShortcut`; at the gate
  an integrity audit applies `shortcutPenalty`. Every one is avoidable.
- `harmonize` (M3): discord critters patrol. The pulse calms them → `harmonized`+1
  each. Touching an uncalmed one hurts.
- `chain` (M4): SI pods (cyan) and human pods (gold). Collecting the opposite kind
  to the last extends the chain (`chainLinks`+1); the same kind twice breaks it
  ("an unchecked SI step"). The level lays them out so a perfect alternating chain
  is possible but takes care.
- `assist` (M5): stand beside a stranded crew capsule for ~1.5 s → `assists`+1;
  the freed crew member cheers and beams to safety, and Nova gets a short speed boost.
- `review` (M6): registry terminals take turns flashing amber; stand beside an
  amber one for ~1.2 s → `reviews`+1. Each is reviewed once.

Every level also has gems (`cores`).

Controls: arrows/WASD to move; Space/Z/K/W/Up to jump (hold to glide); X/J/Enter
to pulse; Down to look down or drop through one-way platforms; P/Esc to pause;
M to mute. **Gamepad** via the Gamepad API (left stick or D-pad, A to jump, X or B
to pulse, Start to pause). **Touch**: on-screen left, right, jump and pulse
buttons with large hit areas, shown only on touch devices.

Results must be exact `SectorResult` objects scored with `scoring.js`. `timeMs` is
simulated time from level start to reaching the gate. With `?debug=1` the page
exposes `window.__humansi = { getState(), setTimescale(n), teleport(x, y) }`, and
`?timescale=N` (1–8) speeds the simulation without changing the reported `timeMs`.
`getState()` returns at least `{ screen, levelIndex, results, hull, integrity,
player: {x, y, vx, vy, onGround}, entities: [{id, kind, x, y, active}], gate: {x, y} }`,
with coordinates in tiles.

Audio: WebAudio-synthesised chiptune. A short upbeat looping theme per world
(simple sequencer: bass, arpeggio, drums), pickup chimes whose pitch rises with
the streak, jump, glide, pulse and gate fanfares. It starts only after a user
gesture, M mutes, and the setting is remembered.

Accessibility: overlays, briefings, the gate, the finale and the debrief are DOM,
with focus management and full keyboard support. The canvas has a text
alternative, and all content is also readable on the landing page. Reduced motion
turns off shake and heavy particles. The game pauses when the tab is hidden.
Performance: fixed-timestep simulation (120 Hz), render on rAF, cached tile and
sprite canvases, only visible tiles drawn, a steady 60 fps on a laptop.

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
