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

---

## Phase 1.5 · Skyway, the roadster, and phones (contract)

> **Status:** the control handoff, exactly-once presses and adaptive resolution
> have landed. The skyway, the roadster and install/offline are in progress.

### Control handoff (`ctx.control`, `ctx.camera3p`, `ctx.perf`)

The engine drives one **controller** at a time: `{ position: THREE.Vector3, update(dt) }`.
Nova is the default. A vehicle takes over with `ctx.control.take(controller)` and
hands back with `ctx.control.release()`; `ctx.control.active` and
`ctx.control.player` (Nova: `{ object3D, position, update, setVisible(on) }`)
are readable. The camera and the place prompts follow the active controller.

- `ctx.camera3p.setDistance(m)`: follow distance (7.5 on foot; wider for a car).
- `ctx.interactions.setEnabled(false)` silences the place prompts while driving;
  `add()` returns the item, and moving `item.pos` moves its prompt (a parked car's
  prompt must follow the car).
- **Edge presses are exactly-once.** `input.state.jump` and `input.state.activate`
  are true in exactly one fixed step per press, whatever the frame rate. A press
  used to step out of a vehicle does not also open a nearby place, and the press
  that opens a place is not seen by a vehicle on its first step.
- Touch has a third button, `#btn-up` (labelled "Jump"), wired to `jump`. A
  vehicle may relabel it ("Lift", "Land") and must restore "Jump" on exit.
- `ctx.collision.resolve(pos, r, only)`: with `only = 'wall'`, only the district
  wall is solid (for flight above the rooftops). The tallest building is 56 m.
- `ctx.perf`: `{ level, dpr, fps, onChange(fn) }`. Level 0 = full detail, 1 =
  reduced, 2 = minimal. Modules with optional detail (flying traffic, crowd
  extras) subscribe and shed work at 1–2.

### Skyway (`web/js/city/skyway.js`): `export function buildSkyway(ctx, world)`

Flying traffic above the Purpose Quarter. Lanes are loops over the street grid
(roads run along x or z = ±48 and ±96, avenues at 0) at 64–92 m, each lane one
direction, stacked at different heights so traffic crosses without meeting.
Vehicles are **original sky-pods** designed in code: a teardrop body, a glass
canopy, four ducted rotor rings and an emissive under-glow, with red/green nav
lights; they bank into turns and keep spacing. Instanced (≤ 6 draw calls).
Counts: 80 on high, 24 on low, halved at perf level 1, a quarter at level 2.
Seeded by `ctx.rng`. Night makes the glow stronger (`ctx.env.timeOfDay`).

### Roadster (`web/js/city/roadster.js`): `export function buildRoadster(ctx, world)`

An **original electric roadster** (no real brand, badge, name or likeness): a
low two-seat wedge with a glass canopy, a full-width light bar front and rear,
and four wheels that fold flat and glow when it flies. Parked at `[8, -24]`
facing north (toward the plaza), next to Nova's spawn.

- **Enter:** an interaction (`label: 'Electric roadster'`, `hint: 'Press E to drive'`,
  radius 3.5). On activate: Nova hidden (`setVisible(false)`), places silenced,
  `control.take(car)`, camera 11 m, HUD prompt with the controls.
- **Drive:** throttle and reverse on `move.y`, steer on `move.x` (yaw rate grows
  with speed), boost on `run`; ~26 m/s top speed (~95 km/h), 8 m/s reverse;
  `collision.resolve(pos, 1.8)` against buildings and the wall.
- **Fly:** `jump` lifts off: wheels fold, the car climbs to a 70 m cruise height
  (above every roof), then flies forward/back on `move.y`, yaws on `move.x`, up to
  ~45 m/s (65 with boost), banking visually. Above 60 m only the wall collides.
  `jump` again lands straight down if the spot below is clear
  (`collision.blocks(x, z, 1.8)` false), else stays up and toasts
  "No room to land here: fly over a street".
- **Exit:** `activate` while landed and slower than 4 m/s puts Nova beside the
  driver's door (collision-resolved), shows her, restores the camera, places and
  the touch label, and releases control. The parked car keeps its interaction.
- Respect reduced motion (no bank wobble, steadier camera). The debug state reports
  `driving` and `pilot`.

### Install and offline (PWA)

HumanSI Synergy installs as an app on iOS and Android and opens offline.

- `web/manifest.webmanifest`: name "HumanSI Synergy", short name "HumanSI",
  `start_url` and `scope` `./`, `display: standalone`, dark `background_color`
  and `theme_color` from `css/tokens.css`, icons 192 and 512 (plus a maskable
  512) in `web/assets/icons/`, and shortcuts to Synergy City, Architect and Nova Run.
- Every page's `<head>` gets: `<link rel="manifest" href="manifest.webmanifest">`,
  `<link rel="icon" …>` and `<link rel="apple-touch-icon" href="assets/icons/apple-touch-icon.png">`
  (180 × 180), `<meta name="mobile-web-app-capable" content="yes">`,
  `<meta name="apple-mobile-web-app-capable" content="yes">`,
  `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
  `<meta name="apple-mobile-web-app-title" content="HumanSI">`, and
  `<script type="module" src="js/pwa.js"></script>`.
- `web/js/pwa.js` registers `sw.js` (relative, so it works under the Pages
  sub-path and at the Go server's root) when `serviceWorker` is supported and the
  page is a secure context. Nothing else.
- `web/sw.js`: a versioned cache. On install, precache the app shell (every page,
  its CSS and JS modules, the vendored three.js, `data/*.json`, icons). Fetch:
  same-origin GET only; never touch `/api/` or event streams; navigations are
  network-first with the cached page as the offline fallback; other assets are
  stale-while-revalidate; videos are never precached. Old caches are deleted on
  activate. A version bump is the only cache-busting mechanism.
- The Go server serves `.webmanifest` as `application/manifest+json`.
- Icons are original (the HumanSI mark: a cyan visor arc in a violet ring on the
  void colour), rendered from `web/assets/icons/icon.svg` by
  `scripts/build-icons.mjs` (dev-only, not run in CI) and committed as PNGs.
