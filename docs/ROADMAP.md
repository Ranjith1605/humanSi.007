# Roadmap: from Nova Run to a living world

HumanSI Synergy grows in phases. Each phase ships something playable, ends with
a release, and has a **done when** that can be checked, not just felt.

## The principle behind every phase

The goal is a world that feels alive: citizens who remember, want, plan and
react, and an SI character with an inner life you can see. We call that
**simulated consciousness**, and we never claim more. The world's minds are
models of attention, memory and intention running in code. They are not sentient,
and the game says so. That honesty is the Rule Book's own integrity rule
("break conventions, never the law or the truth"), applied to ourselves.

Every intelligent feature we add must pass the Six Gates itself:
- **G1:** it has a purpose that serves the player.
- **G3:** it never decides about a person alone.
- **G4:** anything SI-generated is labelled, and a human can always stop it.
- **G6:** its behaviour is logged and reviewable.

---

## Phase 0 · Nova Run and the foundations (v0.1, in progress)

The playable core and a proper open-source project around it.

- Nova Run: six platformer levels, one per gate, each with pass / revise / stop scenarios.
- The fleet server: server-side scoring, a shared board with a live feed, and launch clearance.
- The Model Hangar: open-source models, and a local console through Ollama.
- The landing page and cinematic briefing video. GitHub Pages serves the game.
- Project files: licence, contributing guide, code of conduct, security policy,
  issue and PR templates, CI, and a `v0.1.0` release.

**Done when:** a new visitor can open the Pages URL, play all six gates, earn
clearance, and every check in CI is green.

## Phase 1 · Synergy City: the 3D open world (v0.2)

> **Status (in progress):** the Purpose Quarter vertical slice has landed — a
> walkable low-poly district with Nova, a strolling crowd, day/night, and the four
> places (Nova Run, Rule Book, Glass Box, Model Hangar) as interactables, on a
> vendored three.js. Resolution and detail adapt to the device's real frame
> rate. In the works: sky-pod traffic on the skyway, the hover-craft as an
> electric roadster you can drive and fly, and installing the site as an app
> that works offline. The other five districts are a distant skyline for now. See
> [docs/CITY.md](CITY.md) for the build contract.

A full 3D open world in the browser: the station-city around the ISV Synergy,
with one district per gate, explored on foot and by hover-craft.

- **Engine:** WebGL2 through [three.js](https://threejs.org), MIT-licensed, vendored
  into the repo at a pinned version, so there is still no build step and no third-party CDN.
- **City:** generated in code: streets, plazas and towers per district, with
  instancing and level-of-detail so the whole city streams smoothly.
- **Look:** stylised low-poly with strong lighting: a day/night cycle, fog, bloom
  on neon and the skylight glow from the briefing room.
- **Characters:** Nova and the citizens as low-poly models with simple
  procedural animation. Any third-party assets are CC0 only, with each source
  credited in `NOTICE.md`.
- **Movement:** third-person camera, walking and running, and a hover-craft with
  drift handling; collisions against buildings and terrain.
- **Scope:** one fully built district (the Purpose Quarter) as a vertical slice,
  with the other five blocked out. Nova Run's levels become arcade cabinets you
  can visit inside the city.
- **Phones:** touch controls and a lower-detail mode.

**Done when:** you can roam the slice district for 10 minutes at a steady 60 fps
on a mid-range laptop (30 fps on a recent phone in low-detail mode), with no dead
ends and no falling through the world.

## Phase 1b · Architect: build the city yourself (v0.2)

A city-builder on a 64 × 64 grid, from the genre's well-documented design
(zoning, power, traffic, pollution, land value, demand valves, budget) in our own
code, with two twists: smart buildings that cut power and pollution, and
skyports that move traffic into the air. Its SI advisor, Synergy, is the first
playable form of Phase 4: it proposes concrete actions with the numbers behind
them, the player accepts or declines, and every decision is logged.

- A pure, deterministic simulation in a web worker, unit-tested in CI.
- Procedural architecture per zone and density, all instanced, rendered on demand.
- Touch-first controls: tap and drag to build, pinch to zoom, twist to rotate.

**Done when:** a new player grows a city past 3 000 residents on a phone, the
same seed and actions replay to the same city, and every Synergy proposal shows
the numbers that triggered it. Contract and genre teardown:
[docs/ARCHITECT.md](ARCHITECT.md).

## Phase 2 · Citizens: a living crowd (v0.3)

The city fills with people and SI agents who have their own lives, with no
language model yet. All of it is deterministic, fast and testable.

- Each agent has needs (rest, work, social, curiosity), a daily schedule, and a home and a workplace.
- Pathfinding (A* on a navigation grid), traffic and crowd avoidance.
- Utility-based decisions: each agent picks the action that best serves its needs right now.
- Reactions: citizens notice the player, rumours spread, and moods ripple through districts.

**Done when:** 300 agents (instanced, with level-of-detail) run their days at 60 fps
on a mid-range laptop, a seeded day replays identically, and a debug view
explains why each agent is doing what it does.

## Phase 3 · Minds: memory, reflection, plans (v0.4)

The step from "crowd" to "characters". A small cast of focal citizens gets a
mind, built on the generative-agents architecture from research (Park et al.,
2023, *Generative Agents: Interactive Simulacra of Human Behavior*):

- **Memory stream:** what they saw and did, time-stamped and scored for importance.
- **Retrieval:** they recall what is recent, important and relevant to the moment.
- **Reflection:** they periodically form beliefs from memories ("Nova keeps helping people").
- **Planning:** day plans that change when the world changes.
- **Dialogue:** in fleet mode, spoken by a local open-source model from the Model
  Hangar, labelled SI-generated, with a stop button. In solo mode, written dialogue
  is drawn from the agent's memories, so Pages still works.

**Done when:** a focal citizen remembers what you did yesterday (in game time),
says so in their own words, and changes their plan because of it. Their memory
panel shows exactly which memories led there.

## Phase 4 · Synergy: the world's SI comes alive (v0.5)

The heart of the vision. The city has an SI called **Synergy** that runs its
services. It is a character with a visible inner life:

- **Self-model panel:** what Synergy believes, how sure it is, what it wants, and what it is unsure about.
- **Proposals:** Synergy proposes actions that affect citizens (reroute power,
  change a clinic schedule, flag a "risk"). The player is its **human oversight**:
  every proposal goes through the Six Gates, and you answer pass, revise or stop.
- **Growth through Shu-Ha-Ri:**
  - *Shu:* Synergy follows the rules exactly.
  - *Ha:* with earned trust, it proposes creative solutions.
  - *Ri:* citizens start using its language and ideas.
  - Bad oversight (passing harmful proposals) visibly damages the city and its trust.
- **Transparency is the gameplay:** you can always ask Synergy "why?" and see the
  memories, rules and uncertainty behind an answer.

**Done when:** in playtests, players can explain in their own words why they
stopped or passed at least three of Synergy's proposals, and Synergy's
behaviour measurably changes with the trust the player builds.

## Phase 5 · Story, missions and consequences (v0.6)

- Mission chains in every district, built from the gate scenarios and the
  "city hall" and "company" versions of each decision.
- Factions (citizens, crew, Synergy) with reputation that opens or closes paths.
- A persistent city state: what you allowed, revised or stopped stays changed.
- A codex that unlocks the Rule Book article by article as you live it.

**Done when:** two players who make different gate decisions end the main story
in visibly different cities.

## Phase 6 · The fleet: a shared world (v0.7)

- Real-time shared city events through the Go server (players' decisions ripple into one city).
- City news generated only from real player actions, never invented.
- Co-op oversight: two players review the same Synergy proposal together.

**Done when:** two browsers in different places see each other's decisions change
the shared city within a few seconds.

## Phase 7 · Polish and v1.0

- Accessibility (keyboard, screen-reader text for every panel, reduced motion, captions).
- Languages: English and German first, then Tamil.
- Performance budgets enforced in CI, plus bug fixing from public playtests.
- A small in-browser open-source model, so minds can speak even without a server.

**Done when:** an outside playtest group completes the game, and their feedback
issues are triaged and the critical ones fixed.

---

## How we work, every phase

1. **Plan:** a short design note in `docs/` for the phase.
2. **Build** in small pull requests, each with tests.
3. **Verify** in a real browser: frame time measured, screenshots reviewed,
   gameplay bots for regressions.
4. **Release:** tag, changelog, Pages deploy.
5. **Review against the Six Gates:** does this phase's intelligence pass them?
