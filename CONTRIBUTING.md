# Contributing to HumanSI Synergy

Thanks for helping build the world. Small, focused pull requests are easiest to review.

## Ways to help

- **Play and report:** open a *Bug* issue with what you did, what you expected and what happened.
- **Level ideas:** open a *Level idea* issue. Sketch the layout in text if you can.
- **Rule Book suggestions:** open a *Rule Book suggestion* issue. The Rule Book text
  is not under an open licence (see [NOTICE.md](NOTICE.md)), so the author decides on
  every change to it.
- **Code:** pick an issue, say you're on it, and open a pull request.

## Ground rules

- **No invented data.** No fake players, scores, counters or "live" labels. An empty
  board says it is empty.
- **No overclaiming.** The world's minds are simulated. Never describe them as conscious or sentient.
- **SI-generated text is labelled,** and a human can always stop it.
- **No law dates in code or copy.** Articles can be named, application dates can't:
  they have changed before.
- **Original work only.** No characters, art, music or levels from other games.
- **Standard libraries first.** The Go server uses only the standard library. The
  web front end is vanilla HTML, CSS and ES modules with no build step.

## Development

```bash
go vet ./... && go test -race ./...                                  # server
node --test web/js/scoring.test.mjs web/js/game/levels.test.mjs      # scoring + level checks
go run ./cmd/humansi                                                 # fleet server on :8080
python3 -m http.server --directory web 8000                          # solo mode, as on GitHub Pages
```

Scoring lives in `web/js/scoring.js`, and `internal/game` must match it exactly.
Both are tested against `testdata/score-cases.json`, so change all three together.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how everything fits, and
[docs/ROADMAP.md](docs/ROADMAP.md) for where it is going.

## Pull requests

- One topic per pull request, with a description of what changed and how you checked it.
- CI must be green.
- UI changes include a screenshot at desktop and phone width.

By contributing code you agree to license it under the MIT licence.
