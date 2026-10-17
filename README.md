# HumanSI Synergy

**A new world. A playbook you can play.**

```
> boot humanSi.007
> loading world ........................ ISV Synergy
> loading rule book .................... Charter + Six Gates
> arming gates ......................... G1 G2 G3 G4 G5 G6
> crew ................................. human + SI
> pilot ................................ you
> status ............................... simulation ready
```

HumanSI Synergy is a simulation: a small new world aboard the starship
**ISV Synergy**, where humans and Super Intelligence (SI) learn to share the
controls. The world runs on one set of laws, **the Rule Book**, the playbook of
this simulation. You don't read it so much as play it. Every level is a law of
the world, and every gate is a decision you have to get right before an SI
system is allowed to touch a real one.

> **Orientation, not legal advice.** This Rule Book does not license, certify
> or authorise anyone, and it is not a compliance guarantee. Anything with legal
> consequence goes to qualified counsel. The method is designed against the EU AI
> Act's articles and formatively evaluated; it is not field-validated.

---

## The playbook of this world

The Rule Book has two parts. The **Charter** says *why* humans and SI work
together; the **Six Gates** say *how*. The full text lives in one file,
[`web/data/rulebook.json`](web/data/rulebook.json), and everything in the
simulation reads from it.

### I. The Charter

**Mission:** *To foster and enlighten a peaceful civilization by empowering
humans and Super Intelligence, creating a harmonious partnership between the two.*

| Value | What it means | Articles |
|-------|---------------|----------|
| ◎ Harmony | Seamless integration between humans and SI. | Shared course · Balance over dominance · Plain signals |
| ⬆ Empowerment | Full potential through mutual support. | Lift, don't replace · Teach as you go · Support flows both ways |
| ☮ Peace | Co-evolution of technology and humanity. | No weapons of discord · Understand first · Grow at a shared pace |
| ✦ Innovation | Continuous discovery for synergy. | Discover openly · Test before trust · Measure uplift |
| ⚖ Ethics | Strong ethical principles in every SI interaction. | Human values are the keel · Accountable command · No shortcuts through people |

**Vision:** *To shape a future where humans and Super Intelligence work in true
synergy, unlocking transformative progress for civilization while preserving
the essence of humanity, promoting shared growth, and ensuring peaceful
coexistence.*

**Oath:** *This is not just a vision. It is a responsibility.*

### II. The Six Gates

Before an SI system touches a real decision, it passes six gates, in order. Each
gate asks one hard question and ends in a verdict:

- **PASS**: answered with evidence, so proceed.
- **REVISE**: close the named gap, then come back.
- **STOP**: this design does not go ahead.

| Gate | Module | The question |
|------|--------|--------------|
| G1 | Purpose, readiness, proportionality | Is there a clear purpose, is SI necessary and proportionate compared with the alternatives, and is the organisation ready for it? |
| G2 | Role and risk triage | Do we know, in writing, our role (provider or deployer), the system's risk class, and which obligations apply? |
| G3 | Human-centred impact and dignity | Have the people affected been heard, are the red lines drawn where SI must never decide alone, and can a decision be contested? |
| G4 | Transparency, oversight, accountability | Is the human reviewer genuinely capable of intervention, with the time, authority, understanding and workflow fit to stop the system, or is oversight decorative? |
| G5 | Adoption and workforce transition | Do the people who use and are affected by the system have the competence, the information and a voice? |
| G6 | Lifecycle governance and learning | Is there a named owner, a log, a review date, and a trigger for re-review when the model, vendor, users or consequences change? |

**The minimum rule:** no use case enters live deployment below readiness Level 3.

**Shu · Ha · Ri**, the three stages of mastery the world is built on:

- **SHU** means master the rule.
- **HA** means break the rule: break conventions, never the law or the truth.
- **RI** means become the rule: the method becomes the vocabulary other people use.

---

## The simulation

**Nova Run** is an original, fast side-scrolling platformer. You play **Nova,
the ship's penguin navigator**, and run the Six Gates through six worlds:

1. crystal caverns
2. asteroid mining rigs
3. a biodome garden
4. a neon data city
5. the engineering deck
6. an orbital station

Each world acts out its gate. You scan for purpose, refuse shortcuts, calm
discord with a harmony pulse (Nova carries no weapons), keep every SI step
checked by a human, lift stranded crew, and review the registry. At every gate
you make the call: pass, revise or stop.

Clear all six gates at readiness Level 3 or higher and the world grants you
**launch clearance** for the **Model Hangar**, a catalog of open-source AI
models you can run yourself. On the fleet server, clearance also opens the
console: a local open-source model that answers from the Rule Book, labelled as
SI, with a human stop button.

**The Glass Box** is a slower, second mode — Gate 4 made playable. An SI system
has made a decision about a person; you are the human overseer. You probe the
factors it used, reverse-engineer the one that actually tipped the call, then
rule pass, revise or stop. The whole puzzle is one lesson: *you cannot oversee a
decision you cannot inspect.* Some boxes are glass, some are sealed, and some
look clean until you find the proxy. It runs entirely in the browser, offline,
and keeps no score anywhere but your own device.

## Play

**[ranjith1605.github.io/humanSi.007](https://ranjith1605.github.io/humanSi.007/)**
redirects into `web/`, where the landing page, Nova Run and the Model Hangar
live. On GitHub Pages the site runs in **solo mode**: the same game and the same
scoring, with your runs kept in your own browser. The shared fleet board and
the SI console need the fleet server (next section).

To play from a clone, serve `web/` as static files:

```bash
python3 -m http.server --directory web 8000    # then open http://localhost:8000/
```

| Action | Keyboard | Gamepad | Touch |
|--------|----------|---------|-------|
| Move | ← → or A D | left stick or D-pad | ◀ ▶ |
| Jump (hold for height) | Space, Z, K, W or ↑ | A | Jump |
| Glide | press jump again in the air and hold | A, again and hold | Jump, again and hold |
| Harmony pulse | X, J or Enter | X or B | Pulse |
| Drop through / look down | ↓ or S | stick or D-pad down | ▼ |
| Pause | P or Esc | Start | the II button |
| Mute | M | | the Sound button on the pause screen |

The touch buttons appear only on touch devices. Menus, briefings and gate
verdicts (keys 1, 2, 3) work with the keyboard alone.

**The Glass Box** is at `/inspect.html` (linked from the landing page). It is
point-and-click: probe a factor, name the deciding one, give a verdict. No
install, no server, nothing stored beyond your best score on your own device.

## Run the fleet server

The fleet server is one Go binary, standard library only, with the whole site
embedded. It re-scores every run, keeps the shared board with a live feed,
signs launch clearances and relays the SI console to a local model.

```bash
go run ./cmd/humansi                     # http://localhost:8080
```

| Flag | Environment | Default | What it sets |
|------|-------------|---------|--------------|
| `-addr` | `HUMANSI_ADDR` | `:8080` | listen address |
| `-data` | `HUMANSI_DATA_DIR` | `./data` | directory for `leaderboard.json` (best 500 runs) |
| `-ollama` | `HUMANSI_OLLAMA_URL` | empty: console off | Ollama base URL, e.g. `http://localhost:11434` |
| `-trust-proxy` | `HUMANSI_TRUST_PROXY` | `false` | take the client address from `X-Forwarded-For` (rightmost entry); turn on only behind a proxy you run |
| | `HUMANSI_SECRET` | a random key per start | signs launch clearances; without it, clearances stop working whenever the server restarts |
| `-version` | | | print the version and exit |

Flags win over environment variables. The secret is read from the environment
only, so it never shows up in a process list; use a long random value.

With Docker (the image holds only the static binary):

```bash
docker build -t humansi .
docker run -p 8080:8080 -v humansi-data:/data -e HUMANSI_SECRET=... humansi
# Ollama on the host (Docker Desktop): add -e HUMANSI_OLLAMA_URL=http://host.docker.internal:11434
```

## Connect an open-source model

The SI console in the Model Hangar talks to a model on your own machine through
[Ollama](https://ollama.com). From [`models.json`](web/data/models.json):

1. Install Ollama from ollama.com and start it (it listens on http://localhost:11434).
2. Pull a model from the hangar, e.g. `ollama pull qwen2.5:0.5b`.
3. Start the HumanSI server with `HUMANSI_OLLAMA_URL=http://localhost:11434 go run ./cmd/humansi`.
4. Fly the Six Gates, earn clearance, and open the console.

The console opens only with a **launch clearance from that server**: clear all
six gates at readiness Level 3 or higher while playing on it. The clearance is
a signed token that lasts 24 hours. A clearance earned in solo mode unlocks the
catalog view only. The model picker lists only hangar models that are actually
installed in Ollama. Every answer is labelled SI-generated, and Stop (or Esc)
ends the generation on the server too.

## Repository map

```
web/            the whole site: landing page, Nova Run, the Glass Box, Model Hangar, Rule Book data, media
cmd/humansi/    the fleet server's entry point: flags, wiring, graceful shutdown
internal/       server packages: rulebook, game (scoring mirror), leaderboard, clearance, copilot, api
testdata/       the scoring fixture shared by the Go and JavaScript tests
scripts/        the media pipeline and the asset-reference check
docs/           architecture and roadmap
.github/        CI workflow, issue and pull request templates
embed.go        embeds web/ in the server binary
Dockerfile      two-stage build of a static server image
index.html      GitHub Pages redirect into web/ (with .nojekyll)
```

## Development

```bash
test -z "$(gofmt -l .)" && go vet ./... && go test -race ./...       # server
node --test web/js/scoring.test.mjs web/js/game/levels.test.mjs \
  web/js/glassbox/glassbox.test.mjs                                  # scoring, level and Glass Box checks
node scripts/check-assets.mjs                                        # every local link, import and asset resolves
```

CI runs exactly these on every push and pull request. Scoring lives in
[`web/js/scoring.js`](web/js/scoring.js) and `internal/game` mirrors it; after a
scoring or Rule Book change, rebuild the shared fixture with
`node web/js/scoring.test.mjs --regenerate`, review the diff, and make both test
suites pass. `play.html?debug=1` exposes `window.__humansi` for test bots, and
`&timescale=N` (1–8) speeds up the simulation.

`scripts/build-media.sh` regenerates every briefing image and video from the
original artwork. It needs ffmpeg and Python 3 with Pillow and NumPy, and it
checks its own output.

More: [architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md),
[contributing](CONTRIBUTING.md), [licence](LICENSE) and [what the licence
covers](NOTICE.md).

## Status

This repository is being built in the open. The current state:

| Part | State |
|------|-------|
| The Rule Book: Charter and Six Gates ([`rulebook.json`](web/data/rulebook.json)) | ✅ in the repo |
| Scoring rules ([`scoring.js`](web/js/scoring.js)) and API client ([`api.js`](web/js/api.js)) | ✅ in the repo |
| Model Hangar catalog ([`models.json`](web/data/models.json)) | ✅ in the repo |
| Architecture ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)) | ✅ in the repo |
| Nova Run (the game): six levels, one per gate | ✅ built: full runs through all six gates, scored and submitted, checked in solo and fleet mode |
| The Glass Box: the Gate-4 inspection puzzle | ✅ built: five cases, full run checked in a browser at desktop and phone width |
| Landing page | ✅ built |
| Fleet server (Go): server scoring, shared board, live feed, launch clearance | ✅ built and checked end to end with the site |
| Model Hangar page and SI console | ✅ built; the console is tested against a stand-in for Ollama, not yet against a real model |
| Briefing video and images ([`build-media.sh`](scripts/build-media.sh)) | ✅ built; the WebM videos are checked in a browser, the H.264 fallback is not yet |
| CI ([`ci.yml`](.github/workflows/ci.yml)) | 🛠 in the repo; every check passes locally, first GitHub run pending |
| GitHub Pages | 🛠 Pages already builds this repo from `main`; the root redirect and `.nojekyll` (checked under `/humanSi.007/` locally) make the game live once this lands on `main` |
| Docker image | 🛠 [`Dockerfile`](Dockerfile) in the repo, not yet built and run |

## Credits

The briefing-room artwork (the captain, Nova and the crew around the table) was
provided by the project author. All game art, music and levels are original and
generated in code.
