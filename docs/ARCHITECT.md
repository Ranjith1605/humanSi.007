# Architect — the city-builder (build contract and genre teardown)

> **Status:** design contract. The build is in progress; the README's Status
> table says what has landed.

Architect is HumanSI Synergy's city-builder: you zone, wire and grow a smart
city on a 64 × 64 grid, with a rule-based SI advisor, **Synergy**, that proposes
and a human (you) who decides. It runs in the browser on phones and desktops,
with no build step, like everything else in `web/`.

This file is two things: a short **teardown of how city-builders work** (the
part that is "reverse engineering"), and the **build contract** every module in
`web/js/architect/` is written against. Read both before writing code.

---

## Part 1 · How city-builders work: a teardown

City-builders have been studied in public for decades: design talks, postmortems,
books, and in 2008 Electronic Arts released the original 1989 city-builder's
code as free software under the GPL-3.0 licence, as **Micropolis**, for the One
Laptop per Child project. We learn from the *ideas* this public record
documents. We do **not** copy anyone's code, art, names or text: Architect is an
independent implementation in our own code under our MIT licence (GPL code
cannot be pasted into an MIT project anyway), with our own look and our own
numbers.

### The loop

Every city-builder is the same feedback machine:

1. **The player zones and builds**: residential, commercial and industrial land,
   roads, power, services. The player never builds houses directly; they set
   conditions.
2. **The simulation scores every tile** on a few maps: power, traffic,
   pollution, land value (and, in bigger games, crime, fire, health, education).
3. **Demand** for each zone type comes from the balance of people and jobs, and
   from the tax rate. It is usually shown as three bars: **R**, **C**, **I**.
4. **Zones grow or decline** when their tile's conditions and their type's
   demand are good or bad enough. Growth changes population and jobs, which
   changes demand, traffic and pollution: the loop closes.
5. **Money**: taxes in, upkeep out. The budget limits how fast the player can
   act, and taxes feed back into demand.

### The maps are the game

The heart of the genre is a set of overlapping **2D fields**. Each is cheap: a
grid of small numbers, recomputed once per simulated month, often smoothed by a
blur so effects spread to neighbours. The player learns to read them, which is
why every good city-builder lets you see them as overlays.

| Map | Rises with | Falls with | Drives |
| --- | --- | --- | --- |
| Power | connection to a plant with spare capacity | distance, overload | whether a zone can grow at all |
| Traffic | trips from zones to nearby roads | more roads, transit | pollution, land value, growth |
| Pollution | industry, power plants, traffic | parks, distance, clean tech | land value, residential growth |
| Land value | water, parks, quiet, access | pollution, traffic | which zones can grow tall |

### Demand valves

Demand is a **valve**, not a count: a number between −1 and 1 per zone type,
nudged every month toward an equilibrium.

- Residents want jobs: when there are more jobs than workers, **R** opens.
- Shops want customers: commerce grows with the resident population, so **C**
  follows **R**.
- Industry sells beyond the city: **I** has a baseline outside market and also
  wants workers.
- Taxes press every valve closed; low taxes open them, at the cost of income.

### Growth rules

Each zone tile has a **density level** (0 empty lot … 3 tower). A tile tries to
grow when it has power and road access and its type's demand plus its local
score (land value, minus pollution and congestion) clears a threshold, with a
seeded random chance so the city does not change in lockstep. It declines when
the score falls far enough, and decays when power or access is lost.

### What we change

- **Smart buildings**: solar roofs, adaptive lighting, green roofs and batteries
  cut a building's power draw and pollution. A **Smart Code** policy makes new
  growth smart by default, at a slightly higher growth bar.
- **Flying traffic**: **skyports** take trips off the roads, so congestion drops
  around them, and the sky fills with traffic as the city grows.
- **An SI that proposes, a human who decides**: Synergy reads the same maps and
  proposes concrete actions with its reasons. You accept or decline; every
  decision is logged. This is the Rule Book's oversight rule (G4: a human can
  always stop it; G6: decisions are reviewable), played.

---

## Part 2 · Build contract

### Non-negotiables

- **Vanilla ES modules, no build step, no packages, no CDN.** three.js is vendored
  at `web/vendor/three/three.module.js` (r160); from `web/js/architect/*.js` import
  it as `import * as THREE from '../../vendor/three/three.module.js'`. No import
  maps, no bare `'three'` specifiers.
- **CSP stays strict** (`default-src 'self'`): no inline scripts, no `eval`, no
  `new Function`, no `style=""` attributes in HTML (setting `el.style.x` from JS
  is fine), no blob or data workers. A module worker loaded from its own file is
  fine.
- **Reuse, don't fork:** `../city/core.js` (`makeRng`, `detectQuality`, `makeEnv`)
  and `../city/perf.js` (`makePerfGovernor`) are shared with Synergy City.
- **Honest and original.** Never name or imitate a commercial game, studio or car
  brand anywhere a visitor can see it (UI, page titles, code identifiers, assets).
  This teardown is the only place the genre's history is mentioned. Never fetch
  or copy third-party city-builder source. Game numbers are game values: the UI
  says it is a simulation, and Synergy is described as a rule-based advisor,
  never as conscious or as a real AI.
- **Determinism.** The simulation uses only its own seeded PRNG (`makeRng`) —
  never `Math.random`, `Date` or `performance.now` — so a seed and a list of
  actions always replay to the same city. This is tested.
- **No confidential playbook content.** Only the published Rule Book material
  (gates G1–G6, pass / revise / stop, Shu-Ha-Ri, crew roles) may be referenced.

### Files and owners

```
web/architect.html                  app page                      (shell)
web/css/architect.css               app styles                    (shell)
web/js/architect/main.js            bootstrap: host + view + ui    (shell)
web/js/architect/ui.js              DOM HUD, palette, panels       (shell)
web/js/architect/sim.js             the simulation, pure           (sim)
web/js/architect/protocol.js        message handler + tick timer   (sim)
web/js/architect/sim.worker.js      module worker around protocol  (sim)
web/js/architect/host.js            worker, or inline fallback     (sim)
web/js/architect/sim.test.mjs       node --test suite              (sim)
web/js/architect/view.js            three.js scene, ground, roads, overlays, flying traffic, render-on-demand  (view)
web/js/architect/controls.js        camera pan/zoom/rotate, picking, tap/drag  (view)
web/js/architect/buildings.js       procedural architecture + smart features   (buildings)
```

### Grid and encodings

- `W = H = 64`. Tile `(x, y)` with `x` → east, `y` → south; index `i = y * W + x`.
- In 3D, `TILE = 10` metres. Tile centre: `X = (x - W/2 + 0.5) * TILE`,
  `Z = (y - H/2 + 0.5) * TILE`, ground at `Y = 0`. The map spans 640 m.
- Layers are `Uint8Array(W * H)`:

| Layer | Values |
| --- | --- |
| `terrain` | `0` land, `1` water, `2` forest (clearing costs extra) |
| `kind` | `0` empty, `1` road, `2` R, `3` C, `4` I, `5` park, `6` power plant, `7` solar farm, `8` battery, `9` skyport |
| `level` | `0`–`3` density for R/C/I; `0` for everything else |
| `variant` | `0`–`255`, seeded when a building (re)develops; picks its style |
| `flags` | bit `1` POWERED, `2` ROAD_ACCESS, `4` SMART, `8` ANCHOR (top-left tile of a 2 × 2 structure) |
| `landValue`, `pollution`, `traffic` | `0`–`255` |

Power plants and skyports are **2 × 2**: all four tiles carry the kind; only the
top-left has `ANCHOR`, and the view draws one model there spanning 2 × 2 tiles.

### Tools

| Tool id | Cost (cr) | Placement |
| --- | --- | --- |
| `inspect` | 0 | any tile; reports its values |
| `bulldoze` | 5 (forest 10) | clears anything but water; a 2 × 2 is cleared whole |
| `road` | 10 / tile | land or forest (forest adds 10); drag paints a straight line |
| `res`, `com`, `ind` | 20 / tile | empty land or forest; drag paints a rectangle |
| `park` | 40 | empty tile |
| `plant` | 3000 | 2 × 2 empty land (anchor = tapped tile) |
| `solar` | 400 | empty tile |
| `battery` | 300 | empty tile |
| `skyport` | 1500 | 2 × 2 empty land |
| `smart` | 150 × level | a developed R/C/I tile without SMART |

Placement validity is one pure function both the sim and the view's cursor use:
`canPlace(state, tool, x, y) → { ok, cost, reason }` exported from `sim.js`.

### Simulation rules (numbers are the starting tune; tests pin behaviour, not exact values)

- **Tick** = one month. Start: `Year 1, Jan`, funds 20 000 cr, tax 7 %.
- **Map generation** from the seed: a river or coast of water crossing the map and
  a few forest patches, leaving at least 70 % buildable land, and the centre 16 × 16
  always land.
- **Road access**: a road tile within Chebyshev distance 2.
- **Power**: flood-fill over connected non-empty, non-water tiles (roads, zones,
  structures all conduct) from each plant/solar/battery; each connected network
  sums supply (plant 600, solar 40, battery adds 60 of buffer) and demand (per
  developed tile, by kind and level: R `[0,2,5,12]`, C `[0,3,8,16]`, I `[0,6,14,24]`,
  × 0.6 when SMART). If demand exceeds supply, tiles are powered in BFS order until
  supply runs out (a brownout at the network's far edge). Undeveloped zoned lots
  draw nothing but are powered if reached.
- **Population and jobs** per level: residents R `[0,20,90,300]`; jobs C `[0,10,45,150]`,
  I `[0,15,60,160]`.
- **Traffic**: developed zones make trips (R 10, C 8, I 12 per level) deposited on
  their nearest road within 2; then a few diffusion passes along connected road
  tiles. Skyports halve traffic within radius 10.
- **Pollution**: industry 40 per level (half if SMART), plant 120, traffic × 0.4,
  parks −30 within 3; blurred.
- **Land value**: base 40, + up to 30 near water (≤ 3), + up to 25 near parks (≤ 4),
  + up to 15 near a skyport (≤ 8), + 10 if SMART, − pollution × 0.5, − traffic × 0.3;
  clamped to 0–255; blurred.
- **Demand** in [−1, 1], eased toward a target each month:
  - R target rises when jobs exceed residents × 0.6, and falls when they do not.
  - C target follows residents (wants about 0.3 jobs per resident).
  - I target has a baseline outside market and wants workers.
  - Each target is shifted by `(7 − tax) × 0.04` (tax in %, 0–20).
  - A brand-new city must start with R > 0 and I > 0 so the first zones grow.
- **Growth**, every tick, over zone tiles in a seeded shuffled order: a tile with
  POWERED and ROAD_ACCESS computes `score = demand[type] + local` where `local`
  combines land value, pollution (counts against R and C) and traffic. If
  `score > 0.15` and a seeded roll passes, level +1 (max 3, new `variant`); if
  `score < −0.35`, level −1. Without power or access, a developed tile loses a
  level every few ticks. With the Smart Code on, growth gets SMART for free and
  the bar rises by 0.05.
- **Budget**, monthly: income `tax% × (residents + 1.5 × jobs) / 12`; upkeep road 1,
  park 2, plant 50, solar 5, battery 5, skyport 30. Funds may go negative; building
  then fails with reason `"Not enough credits"`.

### Synergy, the advisor

`advise(state) → Proposal[]` (pure, at most 3, recomputed each tick). A proposal is
`{ id, title, reasons: string[], action, gate }`, where `reasons` quote real
numbers from the sim ("4 developed tiles have no power"), `action` is concrete and
applicable (`{ type: 'build', tool, x, y }`, `{ type: 'tax', rate }`,
`{ type: 'policy', name: 'smartCode', value: true }`), and `gate` is the Rule Book
gate it serves (`'G1'`…`'G6'`). Kinds: unpowered developed tiles → build a plant or
solar at a valid spot near them; congestion → a skyport near the worst traffic;
polluted residential → a park; deficit for 3 months → raise tax by 1; strong
negative demand everywhere → lower tax by 1; high power draw → adopt the Smart
Code. Accepting applies the action through the same rules as a tool (cost and
validity included); declining dismisses it for 12 ticks. Every decision is pushed
to `state.log` as `{ tick, proposal, decision }`.

### `sim.js` API (pure: no DOM, no three, no timers)

```js
export const W = 64, H = 64;
export const TOOLS = { inspect: {...}, bulldoze: {...}, ... };   // ids, costs, sizes, labels
export function createState(seed) → state            // generates terrain; tick 0
export function canPlace(state, tool, x, y) → { ok, cost, reason }
export function apply(state, tool, x, y, x2?, y2?) → { ok, cost, placed, reason }  // line/rect when x2,y2 given
export function step(state) → { events }              // one month
export function advise(state) → Proposal[]
export function decide(state, id, decision) → { ok, reason }   // 'accept' | 'decline'
export function setTax(state, rate), setPolicy(state, name, value)
export function stats(state) → { tick, year, month, funds, residents, jobs, power: { supply, demand }, demand: { r, c, i }, tax, smartCode, income, upkeep }
export function inspect(state, x, y) → { kind, level, powered, roadAccess, smart, landValue, pollution, traffic, label }
export function serialize(state) → JSON-safe object; deserialize(obj) → state
```

### Worker protocol (`protocol.js`, used by `sim.worker.js` and the inline fallback)

`createProtocol(post)` returns `{ handle(msg) }`; it owns the state and a timer
that runs `step` at the current speed (0 paused, 1 = every 2.4 s, 2 = 1.2 s,
3 = 0.5 s) and posts a `state` message after every step and every change.

```
in:  { type: 'init', seed, save? }           { type: 'tool', tool, x, y, x2?, y2? }
     { type: 'speed', speed }                 { type: 'tax', rate }
     { type: 'policy', name, value }          { type: 'decide', id, decision }
     { type: 'inspect', x, y }                { type: 'save' }        { type: 'new', seed }
out: { type: 'state', layers: { terrain, kind, level, variant, flags, landValue, pollution, traffic }, stats, advice, events }
     { type: 'toolResult', ok, cost, reason }  { type: 'inspect', info }  { type: 'saved', data }
```

`layers` are fresh `Uint8Array` copies (transferable). `host.js` exports
`createHost(onMessage) → { send(msg), mode: 'worker' | 'inline' }`: it tries
`new Worker(new URL('./sim.worker.js', import.meta.url), { type: 'module' })` and
falls back to running `protocol.js` on the main thread if that throws.

### `buildings.js` API

```js
export function createBuildings({ THREE, tile = 10, W = 64, H = 64, quality }) → {
  group,                      // add to the scene
  sync(layers),               // rebuild instances from the layers (called on each state message)
  update(dt, timeOfDay),      // cheap per-frame: window lights, beacons, turbine spin
  setDetail(level),           // perf level 0/1/2 from the governor: shed extras at 1–2
  dispose(),
}
```

Real architecture, procedurally, all instanced (target ≤ 40 draw calls in total):
- **R**: L1 eco-homes (pitched or flat roofs, many with solar), L2 mid-rise
  apartments with balcony bands, L3 residential towers (stepped or twisting
  floor plates).
- **C**: L1 glass-front pavilions and shops, L2 offices with setbacks, L3 glass
  skyscrapers with lit crowns and spires.
- **I**: L1 sawtooth-roof workshops, L2 factories with stacks (clean vents when
  SMART), L3 large automated halls.
- **Structures**: power plant (a fusion dome with a glowing ring), solar farm
  (panel rows), battery (blocks with glowing cells), skyport (2 × 2 deck, ring,
  landing lights), park (instanced trees and paths).
- **Smart features** visible on SMART tiles: solar panels or green roofs, a
  rooftop wind turbine on taller ones, adaptive windows (fewer lights after
  midnight), and a small status beacon: green = powered, red = unpowered.
- Heights: L1 4–9 m, L2 14–32 m, L3 40–110 m; footprints leave a street margin
  inside the 10 m tile. `variant` picks the style so a city looks varied and the
  same city always looks the same.

### `view.js` and `controls.js` APIs

```js
// `buildings` is injected by main.js (createBuildings(...)); the view adds
// buildings.group to its scene, calls sync() from setLayers(), update() each
// animated frame and setDetail() when the perf level changes. It must also work
// with a stub `{ group: new THREE.Group(), sync() {}, update() {}, setDetail() {}, dispose() {} }`.
export function createView(canvas, { quality, params, buildings }) → {
  renderer, scene, camera, perf,   // perf = makePerfGovernor(renderer, …), owned by the view
  setLayers(layers, stats),   // ground texture, roads, zones, buildings.sync, traffic level
  setOverlay(name),           // 'none' | 'power' | 'landValue' | 'pollution' | 'traffic'
  setCursor(cursor),          // { x, y, w, h, valid } or null
  tileAt(clientX, clientY) → { x, y } | null,
  invalidate(),               // request a render
  frame(dt),                  // advance animation, render only if needed
  resize(), dispose(),
}
export function createControls(view, canvas, { onTap(x, y), onDragPaint(phase, a, b), toolIsPaint() }) → { dispose() }
```

- **Ground**: one plane with a 64 × 64 `DataTexture` (nearest filter) coloured by
  terrain and zone (R green, C blue, I amber; overlay mode recolours it as a
  heatmap). Water gets its own slightly lower, glossier plane.
- **Roads**: one `InstancedMesh` of road slabs with a lane-marking texture.
- **Flying traffic**: instanced sky-pods on lanes above the busiest roads,
  count ∝ population (cap 40 low, 120 high), more near skyports.
- **Render on demand**: render only when something changed (camera, layers,
  cursor) or while animation is running; animation stops when the tab is hidden
  and runs at 30 fps at perf level ≥ 1. Day/night comes from `makeEnv`, advanced
  by the sim month (a day per tick is too fast: use a slow wall-clock cycle).
- **Camera**: perspective, looking down at ~55°, target clamped to the map.
  Mouse: left-drag pans (or paints with a paint tool), right-drag rotates, wheel
  zooms. Touch: one finger pans (or paints with a paint tool), two fingers pinch
  to zoom, twist to rotate, and pan. Keyboard: arrows/WASD pan, Q/E rotate,
  +/− zoom. A tap is a press that moved < 8 px.

### `ui.js` and the page

**Digital minimalism is the design rule.** People don't have time to read, so the
city is the interface and the chrome stays out of its way:

- **Icons first, words second.** Tools, speeds and overlays are icon buttons with
  a 1–2 word label; costs are a small number, not a sentence.
- **Progressive disclosure.** Show the one number that matters; details open on
  tap (a tile's full readout, a proposal's reasons, the budget's line items).
  Panels are closed by default and never open by themselves.
- **No paragraphs on screen.** Any line of copy is at most ~6 words. Help is a
  single coach mark per concept, shown once (remembered in `localStorage`) and
  fading on its own.
- **Seamless play.** The city starts the moment the page loads: no title screen,
  no new-game form, no confirm dialogs for reversible actions. Tool results are
  felt in the scene (the cursor flashes red, the tile pops) with a toast only
  when the reason isn't visible.
- **Calm motion.** Short eased transitions (150–250 ms), none under reduced motion.

- **Top bar**: funds, date, residents, jobs, power supply/demand, and three small
  R/C/I demand bars.
- **Tool palette**: bottom, horizontally scrollable on phones, ≥ 44 px targets,
  `aria-pressed` on the active tool, keyboard shortcuts (1–9, B bulldoze, I
  inspect). Each button shows its cost.
- **Speed**: pause, 1, 2, 3 (Space toggles pause).
- **Overlay picker**: none / power / land value / pollution / traffic, with a legend.
- **Panels** (bottom sheet on phones, side panel on desktop): Inspect, Budget (tax
  slider 0–20 %, Smart Code toggle, income/upkeep), Synergy (proposals with
  reasons, Accept / Decline, and the decision log), City (new city with seed,
  save, load).
- **Synergy** surfaces as a small badge with a count when it has proposals. Each
  proposal is one line (a title of a few words) with ✓ / ✕; its reasons expand on
  tap. The panel's single line of copy: "Rule-based advisor · you decide · logged".
- **Save**: `localStorage` key `humansi.architect.v1`, wrapped in try/catch (private
  mode may throw); autosave every 12 ticks and on `pagehide`.
- Loading screen, pause-free WebGL fallback with links, and a `?debug=1` hook:
  `window.__architect = { getState(), send(msg), tileAt(x, y) }`.
- The page includes the shared PWA tags (see `docs/CITY.md` → *Install and
  offline*) and the same header/brand link back to `index.html`.

### Performance budget

- Phones: ≥ 30 fps while panning a 3 000-resident city at perf level 0 on a
  mid-range phone; the governor handles the rest. Desktop: 60 fps.
- ≤ 60 draw calls, ≤ 250 k triangles at full detail; no per-frame allocations in
  hot paths; no shadows (fake contact shadows only).
- The sim step for a full 64 × 64 city stays under 8 ms on a laptop (tested).

### Tests (`node --test web/js/architect/sim.test.mjs`, run in CI)

At least: determinism (same seed + same actions → identical layers and stats);
map generation guarantees; `canPlace` rules for every tool; road access; power
flood-fill, capacity and brownout order; demand directions (jobs-heavy city opens
R; residents-heavy opens C and I; higher tax lowers all three); growth needs power
and access; SMART lowers power demand; skyport lowers nearby traffic; budget
arithmetic; advisor proposals are applicable and their reasons match the numbers;
accept/decline logging; serialize → deserialize round trip; step time budget.
