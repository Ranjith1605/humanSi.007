# Synergy City — build contract (Phase 1, v0.2)

A 3D, explorable district of the ISV Synergy's station-city, in the browser with
three.js. This file is the contract every builder works from. Read it fully.

## Non-negotiables

- **Vanilla ES modules, no build step, no npm at runtime, no CDN.** three.js is
  vendored at `web/vendor/three/three.module.js` (r160, MIT). Import it by
  **relative path** — from `web/js/city/*.js` that is
  `import * as THREE from '../../vendor/three/three.module.js'`. Do **not** add an
  import map (the strict CSP forbids inline scripts) and do **not** import three
  addons by the bare specifier `'three'`. If you need an addon, vendor its file
  next to three and rewrite its `from 'three'` to the relative path.
- **CSP stays strict.** No inline scripts, no `eval`, no `new Function`, no
  workers loaded from blobs. WebGL is fine. The page's own `<script>` is a module
  with `src`.
- **No fabricated data, no overclaiming.** Citizens are simple simulated agents;
  never call them conscious. Keep the honesty rules from `docs/ARCHITECTURE.md`.
- **Phones matter.** Must run on a recent phone in a low-detail mode, with touch
  controls, and never scroll the page sideways.
- **Reduced motion & accessibility.** Respect `prefers-reduced-motion` (calm the
  camera, stop idle bobbing). The canvas has a text alternative; all overlays
  (loading, controls, pause, interaction prompts) are real DOM with focus
  management and keyboard support. Everything the city points to (Nova Run, the
  Rule Book) is reachable by link, not only by walking.

## World conventions

- **Units:** 1 three.js unit = 1 metre. **Y is up.** The ground is the XZ plane at
  `y = 0`. Nova is ~1.1 m tall. Streets ~8 m wide, building blocks ~40 m, towers
  10–60 m. The district is roughly a 300 m × 300 m square centred on the origin.
- **Coordinates in data** (`web/data/city.json`) are metres, `[x, z]` on the
  ground, with `y` implied 0 unless stated.
- **Scene graph:** everything hangs off `ctx.scene`. Group your additions under a
  single named `THREE.Group` (e.g. `scene.getObjectByName('world')`) so they are
  easy to find and dispose.

## The shared context object `ctx`

`engine` (owned below) builds `ctx` and passes it to every module's `build*`
function. It has:

```
ctx = {
  THREE,                       // the three namespace
  scene, camera, renderer,     // three.js core objects
  clock: { time, dt },         // seconds; dt is the fixed step (see loop)
  quality: 'high' | 'low',     // 'low' on phones / weak GPUs
  input,                       // see Input API
  collision,                   // see Collision API
  interactions,                // see Interaction API
  hud,                         // see HUD API
  rng(),                       // deterministic PRNG in [0,1) (seeded; no Math.random in world gen)
  register(obj),               // obj may have update(dt) and/or dispose(); engine calls them
  env,                         // { setTimeOfDay(t01), timeOfDay } — 0=midnight .5=noon
}
```

- **Loop:** fixed-timestep simulation at 60 Hz (`dt = 1/60`), rendered on
  `requestAnimationFrame`. Anything animated registers via `ctx.register({update})`.
  The loop pauses when the tab is hidden and while the pause menu is open.
- **Determinism:** world generation uses `ctx.rng()` only, never `Math.random()`
  or `Date.now()`, so the city is the same every load. (Gameplay that needs
  variety, like citizen choices, may use `Math.random()` at runtime — just not
  world layout.)

## Module interfaces (what each builder exports)

Each module is a single entry function that adds to the scene and registers its
own updaters. Keep per-frame work light; prefer `InstancedMesh` for anything
repeated (buildings, windows, streetlights, citizens).

- **world** (`web/js/city/world.js`): `export function buildWorld(ctx)`
  → `{ spawn: THREE.Vector3, bounds: {min:[x,z], max:[x,z]} }`.
  Builds the ground, the sky/background, the Purpose Quarter district fully, and
  the other five districts as distant low-detail massing (a skyline, not walkable).
  Registers every static building's footprint with `ctx.collision.addBox(...)`.
  Lighting (sun/hemisphere) and fog are world's to set, driven by `ctx.env`.
- **player** (`web/js/city/player.js`): `export function buildPlayer(ctx, spawn)`
  → `{ object3D, position, update(dt) }`. The Nova avatar (a low-poly space
  penguin: body, visor, thruster pack, built in code) with idle/walk/run
  procedural animation, and the character controller: move relative to the camera,
  walk/run, gravity onto the ground plane, and `ctx.collision.resolve()` so Nova
  can't enter buildings. Optional hover-craft toggle is a bonus, not required.
- **citizens** (`web/js/city/citizens.js`): `export function buildCitizens(ctx, world)`.
  A modest crowd (≤ 40 on high, ≤ 12 on low) of simple low-poly figures that
  stroll between points with gentle avoidance. Instanced where possible. They are
  ambience; they never block the player hard. No language model, no claims of mind.
- **places** (`web/js/city/places.js`): `export function buildPlaces(ctx, world)`.
  The points of interest from `web/data/city.json`: the **Nova Run arcade cabinet**
  (interacting opens `play.html`), a **Rule Book kiosk** (opens `index.html#gates`),
  the **Glass Box terminal** (opens `inspect.html`), and the **Model Hangar gate**
  (opens `hangar.html`), plus signage. Each registers an `ctx.interactions.add(...)`.

`engine`/`main` (`web/js/city/engine.js`, `core.js`, `input.js`, `camera.js`,
`collision.js`, `interactions.js`, `hud.js`, and `web/city.html` + `web/css/city.css`)
are the **skeleton**, written and verified by the lead before the content build.
Builders import three and the context; they do not modify the skeleton. If a
skeleton change is genuinely needed, put it in `sharedFileRequests`.

## Collision API (`ctx.collision`)

- `addBox(cx, cz, halfX, halfZ, { tag })` — register an axis-aligned building
  footprint (full height; the city is walked at ground level).
- `resolve(position, radius) → position` — push a point out of any box it overlaps
  (circle-vs-AABB on XZ). Call it every frame after moving the player.
- `blocks(x, z, radius) → boolean` — test without moving (for citizen avoidance).
- The ground is a flat plane at y = 0, so nothing can fall through the world;
  keep Nova's `y` clamped ≥ 0.

## Interaction API (`ctx.interactions`)

- `add({ position: THREE.Vector3|[x,z], radius, label, hint, onActivate })`.
  When the player is within `radius`, the HUD shows `label` + `hint` ("Press E")
  and the activate control (E / gamepad A / an on-screen button) calls
  `onActivate()`. Opening another page is a normal `location.href = 'play.html'`.

## Input API (`ctx.input`)

Already normalised by the skeleton across keyboard, gamepad and touch:
`input.move` (THREE.Vector2, −1..1, camera-relative intent), `input.run` (bool),
`input.look` (Vector2 delta for the camera), `input.jump` (bool, edge),
`input.activate` (bool, edge), `input.pausePressed` (bool, edge). Touch adds an
on-screen stick + run/activate buttons on touch devices only.

## HUD API (`ctx.hud`)

`hud.setDistrict(name)`, `hud.prompt(label, hint) / hud.clearPrompt()`,
`hud.toast(text)`, `hud.setLoading(0..1 | null)`. The pause menu, controls help
and the loading screen are the skeleton's.

## Performance budget (the "done when")

- A 10-minute roam of the Purpose Quarter holds **60 fps on a mid-range laptop**
  and **≥ 30 fps on a recent phone** (low mode). Draw calls stay modest (instance
  aggressively; the whole city should be well under ~300 draw calls). No memory
  growth over time (reuse geometry/materials; dispose on teardown).
- No dead ends that trap the player, and no way to fall through or leave the world
  (an invisible boundary wall rings the district).
- `?debug=1` exposes `window.__city = { getState() }` returning at least
  `{ fps, drawCalls, player:{x,y,z}, quality, timeOfDay, nearest }` so an
  automated test can drive and measure it. `?quality=low|high` forces a mode.

## Look

Stylised low-poly, cohesive and calm: a warm skylight sun, a cool sky gradient,
soft fog for depth, emissive neon on signage and the arcade cabinet (bloom is
faked with emissive materials + additive halos, not a postprocessing pass).
Day/night cycle on a slow clock. One accent family per district, the Purpose
Quarter in violet/magenta (its gate colour, M1). Readable, not cluttered; the
player and the interactables always stand out from the backdrop.

## Scope of this phase

Build the **Purpose Quarter** fully and well, with Nova walkable, citizens,
day/night, the four interactable places, and the other five districts as a
distant skyline. Not this phase: interiors, the hover-craft city-wide, the living
citizen minds (that is Phase 2–3 on the roadmap).
