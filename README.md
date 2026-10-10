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

## Status

This repository is being built in the open. The current state:

| Part | State |
|------|-------|
| The Rule Book: Charter and Six Gates ([`rulebook.json`](web/data/rulebook.json)) | ✅ in the repo |
| Scoring rules ([`scoring.js`](web/js/scoring.js)) and API client ([`api.js`](web/js/api.js)) | ✅ in the repo |
| Model Hangar catalog ([`models.json`](web/data/models.json)) | ✅ in the repo |
| Architecture ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)) | ✅ in the repo |
| Nova Run (the game) | 🛠 being built |
| Fleet server (Go), landing page, Model Hangar page | 🛠 being built |

How to play and how to run the server will be added here as each part lands.

## Credits

The briefing-room artwork (the captain, Nova and the crew around the table) was
provided by the project author. All game art, music and levels are original and
generated in code.
