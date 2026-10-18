// Architect — the city simulation. Pure: no DOM, no three.js, no timers, and
// never Math.random, Date or performance. Everything random comes from a
// Mulberry32 PRNG whose state lives inside the sim state, so a seed plus a list
// of actions always replays to the same city, and a save resumes the exact
// random sequence. protocol.js runs it (in a worker or inline), the view and
// the cursor share canPlace with it, and sim.test.mjs pins its behaviour.
//
// The rules and their starting numbers are documented in docs/ARCHITECT.md
// (Part 2, "Simulation rules"). Every number here is a game value tuned for
// play, never real-world data, and Synergy is a rule-based advisor: a handful
// of if-this-then-propose-that rules that quote the numbers they read.
//
// Events returned by step(): { type: 'grow' | 'decline', x, y, kind, level,
// cause? }, { type: 'milestone', residents }, { type: 'year', year },
// { type: 'deficit', funds }, { type: 'brownout', unpowered }.

export const W = 64;
export const H = 64;
const N = W * H;

export const TERRAIN = Object.freeze({ LAND: 0, WATER: 1, FOREST: 2 });
export const KIND = Object.freeze({
  EMPTY: 0, ROAD: 1, RES: 2, COM: 3, IND: 4, PARK: 5, PLANT: 6, SOLAR: 7, BATTERY: 8, SKYPORT: 9,
});
export const FLAG = Object.freeze({ POWERED: 1, ROAD_ACCESS: 2, SMART: 4, ANCHOR: 8 });
export const KIND_NAMES = Object.freeze(['empty', 'road', 'res', 'com', 'ind', 'park', 'plant', 'solar', 'battery', 'skyport']);
export const LAYER_NAMES = Object.freeze(['terrain', 'kind', 'level', 'variant', 'flags', 'landValue', 'pollution', 'traffic']);
export const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

const { LAND, WATER, FOREST } = TERRAIN;
const { EMPTY, ROAD, RES, COM, IND, PARK, PLANT, SOLAR, BATTERY, SKYPORT } = KIND;
const { POWERED, ROAD_ACCESS, SMART, ANCHOR } = FLAG;

// --- the tune ---------------------------------------------------------------
// One place for every game value, so tuning never means hunting through code.

const START_FUNDS = 20000;
const START_TAX = 7;
const NEUTRAL_TAX = 7; // demand is unshifted at this rate
const MAX_TAX = 20;
const TAX_DEMAND = 0.04; // demand shift per tax point away from NEUTRAL_TAX
const FOREST_CLEAR = 10; // extra cost wherever a build clears forest
const BULLDOZE_FOREST = 10; // clearing a forest tile on its own
const NO_CREDITS = 'Not enough credits';

const SUPPLY_PLANT = 600;
const SUPPLY_SOLAR = 40;
const SUPPLY_BATTERY = 60; // buffered, so only on a grid that generates something
const DRAW = [null, null, [0, 2, 5, 12], [0, 3, 8, 16], [0, 6, 14, 24]]; // by kind, then level
const DRAW_SKYPORT_TILE = 5; // 20 per 2×2: flying traffic needs charging
const SMART_DRAW = 0.6;

const RESIDENTS = [0, 20, 90, 300];
const JOBS_C = [0, 10, 45, 150];
const JOBS_I = [0, 15, 60, 160];
const WORKER_SHARE = 0.6; // residents who want a job

const TRIPS = [0, 0, 10, 8, 12]; // per level, by kind
const DIFFUSE_PASSES = 3;
const SKYPORT_RADIUS = 10;
const SKYPORT_RELIEF = 0.5;
const CONGESTED = 80; // traffic at which Synergy calls a road congested
const HEAVY_TRAFFIC = 120; // where shops and industry start to mind it

const POLLUTION_IND = 40; // per level, halved when smart
const POLLUTION_PLANT = 120; // per plant tile
const POLLUTION_TRAFFIC = 0.4;
const PARK_CLEANS = 30;
const PARK_CLEAN_RADIUS = 3;
// The blur averages a source over its neighbours, which made a whole
// industrial block barely register two tiles away. The gain restores the
// intended reach: homes beside heavy industry or a plant are clearly polluted.
const POLLUTION_GAIN = 2;
const POLLUTED = 50; // pollution at which Synergy calls a home polluted

const LV_BASE = 40;
const LV_WATER = 30; // within 3
const LV_PARK = 25; // within 4
const LV_SKYPORT = 15; // within 8
const LV_SMART = 10;
const LV_POLLUTION = 0.5;
const LV_TRAFFIC = 0.3;
// Homes and shops grow tall mostly on good land. Below the land value a level
// asks for, growth to it is rare (POOR_LAND_CHANCE of the usual roll) rather
// than impossible: a hard gate made a plain-land first town stop dead at
// level 2 after half a year, with demand wide open and nothing to explain why.
const LV_FOR_LEVEL = [0, 0, 20, 55];
const POOR_LAND_CHANCE = 0.15;
// Taller takes longer: the monthly growth roll is scaled by the level a lot is
// growing to, so a new town shows homes within weeks but its towers arrive
// over a couple of years, and there is still something to watch in year two.
const LEVEL_PACE = [0, 1, 0.45, 0.3];
// The monthly growth budget, in residents or jobs, scaled by demand: a fixed
// part so a small town can grow at all, and a share of what the city already
// has. The share compounds, so it stays small: at 8 % a well-run city went
// from 2 000 to 70 000 residents in a dozen years and money stopped mattering.
const BUDGET_R = 150;
const BUDGET_C = 60;
const BUDGET_I = 80;
const BUDGET_SHARE = 0.025;

const DEMAND_BASE_R = 0.2;
const DEMAND_BASE_C = 0.1;
const DEMAND_BASE_I = 0.25; // the outside market
const GROW_BAR = 0.15;
const GROW_BAR_PER_LEVEL = 0.03;
const SMART_CODE_BAR = 0.05;
const DECLINE_BAR = -0.35;
const DECLINE_CHANCE = 0.2;
const NEGLECT_TICKS = 3; // months without power or access before a building loses a level

// Income is tax % × (residents + 1.5 × jobs) × INCOME_RATE / 12 a month. The
// contract's starting tune had no INCOME_RATE (1.0); play-testing a scripted
// city showed money stopped mattering by year 3, so it is scaled down.
const INCOME_RATE = 0.2;
const UPKEEP = [0, 1, 0, 0, 0, 2, 50, 5, 5, 30]; // by kind; 2×2 structures counted once
const PROPOSAL_LIMIT = 3;
const DECLINE_COOLDOWN = 12;
const ACCEPT_COOLDOWN = 4; // let an accepted fix take effect before asking again
const LOG_LIMIT = 100;
// What a save holds. landValue, pollution and traffic are rebuilt on load
// (they are always a pure function of these), which keeps saves small.
const SAVED_LAYERS = ['terrain', 'kind', 'level', 'variant', 'flags'];
const MILESTONES = [500, 1000, 2000, 3000, 5000, 10000, 20000, 50000, 100000, 200000];

export const TUNING = Object.freeze({
  START_FUNDS, START_TAX, SUPPLY_PLANT, SUPPLY_SOLAR, SUPPLY_BATTERY, SMART_DRAW,
  SKYPORT_RADIUS, CONGESTED, POLLUTED, DECLINE_COOLDOWN, NEGLECT_TICKS,
});

function freezeDeep(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freezeDeep(v);
  return Object.freeze(o);
}

export const TOOLS = freezeDeep({
  inspect: { id: 'inspect', label: 'Inspect', cost: 0, size: 1, paint: null, kind: null, desc: 'Read a tile: power, road access, land value, pollution, traffic.' },
  bulldoze: { id: 'bulldoze', label: 'Bulldoze', cost: 5, size: 1, paint: null, kind: null, desc: `Clear a tile (forest ${BULLDOZE_FOREST} cr). A 2×2 structure is cleared whole.` },
  road: { id: 'road', label: 'Road', cost: 10, size: 1, paint: 'line', kind: ROAD, desc: 'Drag a straight line. Zones need a road within 2 tiles.' },
  res: { id: 'res', label: 'Residential', cost: 20, size: 1, paint: 'rect', kind: RES, desc: 'Homes. Drag a rectangle. Needs power and a road.' },
  com: { id: 'com', label: 'Commercial', cost: 20, size: 1, paint: 'rect', kind: COM, desc: 'Shops and offices. Drag a rectangle. Needs power and a road.' },
  ind: { id: 'ind', label: 'Industrial', cost: 20, size: 1, paint: 'rect', kind: IND, desc: 'Workshops and factories. Drag a rectangle. Needs power and a road.' },
  park: { id: 'park', label: 'Park', cost: 40, size: 1, paint: null, kind: PARK, desc: `Cuts pollution by ${PARK_CLEANS} within ${PARK_CLEAN_RADIUS} tiles and raises land value.` },
  plant: { id: 'plant', label: 'Fusion plant', cost: 3000, size: 2, paint: null, kind: PLANT, desc: `2×2 on clear land. Supplies ${SUPPLY_PLANT} power.` },
  solar: { id: 'solar', label: 'Solar farm', cost: 400, size: 1, paint: null, kind: SOLAR, desc: `Supplies ${SUPPLY_SOLAR} power, no pollution.` },
  battery: { id: 'battery', label: 'Battery', cost: 300, size: 1, paint: null, kind: BATTERY, desc: `Adds ${SUPPLY_BATTERY} buffered supply to a grid that generates power.` },
  skyport: { id: 'skyport', label: 'Skyport', cost: 1500, size: 2, paint: null, kind: SKYPORT, desc: `2×2 on clear land. Needs power. Flying traffic halves road traffic within ${SKYPORT_RADIUS} tiles.` },
  smart: { id: 'smart', label: 'Smart retrofit', cost: 150, size: 1, paint: null, kind: null, perLevel: true, desc: 'Make a building smart: 40 % less power, half the industrial pollution, +10 land value. 150 cr per level.' },
});

// --- PRNG -------------------------------------------------------------------

/** Mulberry32, the same algorithm as city/core.js makeRng (the test checks it). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One draw from the sim's own stream; the stream position is part of the save. */
function rand(state) {
  const a = (state.rng + 0x6d2b79f5) | 0;
  state.rng = a >>> 0; // a JSON-safe non-negative integer
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Seeds can be typed by a player: numbers pass through, text is hashed (FNV-1a). */
export function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(Math.abs(seed)) >>> 0;
  const s = String(seed ?? '').trim();
  if (/^\d{1,10}$/.test(s)) return Number(s) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// --- small helpers ------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const inMap = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const isZone = (k) => k === RES || k === COM || k === IND;
const round1 = (v) => Math.round(v * 10) / 10;
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const signed = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);

function drawOf(k, lv, f) {
  let d = 0;
  if (k === RES || k === COM || k === IND) d = DRAW[k][lv];
  else if (k === SKYPORT) d = DRAW_SKYPORT_TILE;
  return f & SMART ? d * SMART_DRAW : d;
}

// Scratch buffers shared by every state: the sim is single-threaded and every
// call runs to completion, so one set suffices and steps allocate nothing big.
const scratch = {
  a: new Float32Array(N),
  b: new Float32Array(N),
  c: new Float32Array(N),
  d: new Float32Array(N),
  queue: new Int32Array(N),
  queue2: new Int32Array(N),
  visit: new Int32Array(N),
  list: new Int32Array(N),
  mark: new Uint8Array(N),
};

// Access search order: nearest first (Chebyshev ring, then true distance, then
// scan order), so "the nearest road" is well defined and deterministic.
const ACCESS_OFFSETS = (() => {
  const o = [];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx || dy) o.push([dx, dy]);
  o.sort((p, q) => Math.max(Math.abs(p[0]), Math.abs(p[1])) - Math.max(Math.abs(q[0]), Math.abs(q[1]))
    || (p[0] * p[0] + p[1] * p[1]) - (q[0] * q[0] + q[1] * q[1]) || p[1] - q[1] || p[0] - q[0]);
  return Int8Array.from(o.flat());
})();

// --- map generation -----------------------------------------------------------

/**
 * A river or a coast and a few forest patches. Water is drawn by integer
 * random walks rather than trigonometry, so every JS engine draws the same map
 * for a seed. All water and forest stays out of the central 16 × 16, which is
 * where a new player starts, and the totals keep at least 70 % plain land.
 */
function generateTerrain(terrain, seed) {
  const r = mulberry32(seed ^ 0x51ed270b);
  terrain.fill(LAND);
  const vertical = r() < 0.5;
  const coast = r() < 0.35;
  const far = r() < 0.5; // which side of the centre the water runs on
  const set = (a, b, t) => {
    const x = vertical ? b : a;
    const y = vertical ? a : b;
    if (inMap(x, y)) terrain[y * W + x] = t;
  };

  let wob = 0;
  let width = 3;
  for (let a = 0; a < 64; a++) {
    if (r() < 0.45) wob = clamp(wob + (r() < 0.5 ? -1 : 1), -4, 4);
    if (r() < 0.2) width = clamp(width + (r() < 0.5 ? -1 : 1), 2, 4);
    if (coast) {
      // A wavy shoreline 2–8 tiles deep along one edge.
      const depth = 5 + Math.round(wob * 0.75);
      for (let b = 0; b < depth; b++) set(a, far ? 63 - b : b, WATER);
    } else {
      // A river crossing the whole map, centred 9–15 or 48–54 tiles in.
      const centre = (far ? 51 : 12) + wob;
      for (let b = centre - (width >> 1); b < centre - (width >> 1) + width; b++) set(a, b, WATER);
    }
  }

  const patches = 4 + Math.floor(r() * 4);
  for (let p = 0; p < patches; p++) {
    const rad = 2 + r() * 2.5;
    let cx = 0;
    let cy = 0;
    for (let tries = 0; tries < 20; tries++) {
      cx = Math.floor(r() * W);
      cy = Math.floor(r() * H);
      const nearCentre = cx > 24 - rad - 2 && cx < 40 + rad + 2 && cy > 24 - rad - 2 && cy < 40 + rad + 2;
      if (!nearCentre) break;
    }
    const r2 = rad * rad;
    const span = Math.ceil(rad);
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!inMap(x, y) || dx * dx + dy * dy > r2 || r() > 0.85) continue;
        const i = y * W + x;
        if (terrain[i] === LAND) terrain[i] = FOREST;
      }
    }
  }

  // Guarantees, enforced rather than hoped for.
  for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) terrain[y * W + x] = LAND;
  let land = 0;
  for (let i = 0; i < N; i++) if (terrain[i] === LAND) land++;
  for (let i = 0; land < N * 0.7 && i < N; i++) if (terrain[i] === FOREST) { terrain[i] = LAND; land++; }
}

/** Chebyshev distance to the nearest water, capped at 4. Terrain water never changes. */
function computeWaterDist(state) {
  const { terrain } = state.layers;
  const dist = state.d.waterDist;
  dist.fill(4);
  for (let i = 0; i < N; i++) {
    if (terrain[i] !== WATER) continue;
    const x = i % W;
    const y = (i / W) | 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inMap(nx, ny)) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const j = ny * W + nx;
        if (d < dist[j]) dist[j] = d;
      }
    }
  }
}

// --- state ----------------------------------------------------------------------

function makeLayers() {
  const layers = {};
  for (const name of LAYER_NAMES) layers[name] = new Uint8Array(N);
  return layers;
}

// Derived data: rebuilt from the layers by refresh(), never saved.
function makeDerived() {
  return {
    roadOf: new Int32Array(N),
    comp: new Int32Array(N),
    waterDist: new Uint8Array(N),
    nets: [],
    totals: null,
    skyTrips: 0,
  };
}

export function createState(seed = 1) {
  const s = normalizeSeed(seed);
  const state = {
    version: 1,
    seed: s,
    rng: (s ^ 0x9e3779b9) >>> 0,
    tick: 0,
    funds: START_FUNDS,
    tax: START_TAX,
    smartCode: false,
    // A brand-new city wants settlers and industry, so the first zones grow.
    demand: { r: 0.6, c: 0.2, i: 0.45 },
    deficitMonths: 0,
    lastIncome: 0,
    lastUpkeep: 0,
    milestone: 0,
    unpoweredBefore: 0,
    cooldown: {},
    log: [],
    layers: makeLayers(),
    neglect: new Uint8Array(N),
    d: makeDerived(),
  };
  generateTerrain(state.layers.terrain, s);
  computeWaterDist(state);
  refresh(state);
  return state;
}

// --- placement --------------------------------------------------------------------

const fail = (reason) => ({ ok: false, cost: 0, reason });

/** The anchor of the 2×2 structure covering (x, y), or -1. */
function anchorOf(state, x, y) {
  const { kind, flags } = state.layers;
  const k = kind[y * W + x];
  if (k !== PLANT && k !== SKYPORT) return -1;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const ax = x - dx;
      const ay = y - dy;
      if (!inMap(ax, ay)) continue;
      const j = ay * W + ax;
      if (kind[j] === k && flags[j] & ANCHOR) return j;
    }
  }
  return -1;
}

/**
 * Whether `tool` can be used at (x, y), and what it costs. Pure, and shared by
 * the sim and the view's cursor so the two can never disagree. Validity is
 * checked before money, so the reason names the real obstacle first.
 */
export function canPlace(state, tool, x, y) {
  const t = TOOLS[tool];
  if (!t) return fail('Unknown tool');
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inMap(x, y)) return fail('Off the map');
  const { terrain, kind, level, flags } = state.layers;
  const i = y * W + x;
  let cost = t.cost;

  if (tool === 'inspect') return { ok: true, cost: 0, reason: '' };

  if (tool === 'bulldoze') {
    if (terrain[i] === WATER) return fail('Water cannot be cleared');
    if (kind[i] === EMPTY && terrain[i] !== FOREST) return fail('Nothing to clear');
    if (kind[i] === EMPTY) cost = BULLDOZE_FOREST;
  } else if (tool === 'smart') {
    if (!isZone(kind[i]) || level[i] === 0) return fail('Needs a developed building');
    if (flags[i] & SMART) return fail('Already smart');
    cost = t.cost * level[i];
  } else if (t.size === 2) {
    if (!inMap(x + 1, y + 1)) return fail('Off the map');
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const j = (y + dy) * W + x + dx;
        if (terrain[j] === WATER) return fail('Needs land, not water');
        if (terrain[j] === FOREST) return fail('Needs clear land: bulldoze the forest');
        if (kind[j] !== EMPTY) return fail('Needs a clear 2×2 site');
      }
    }
  } else {
    if (terrain[i] === WATER) return fail('Cannot build on water');
    if (kind[i] === t.kind) return fail(tool === 'road' ? 'Already a road' : 'Already built');
    if (kind[i] !== EMPTY) return fail('Occupied: bulldoze first');
    if (terrain[i] === FOREST) cost += FOREST_CLEAR;
  }

  if (state.funds < cost) return { ok: false, cost, reason: NO_CREDITS };
  return { ok: true, cost, reason: '' };
}

/** Place without checks: canPlace has already said yes. */
function place(state, tool, x, y, cost) {
  const L = state.layers;
  const i = y * W + x;
  const t = TOOLS[tool];
  state.funds -= cost;

  if (tool === 'bulldoze') {
    const a = anchorOf(state, x, y);
    if (a >= 0) {
      const ax = a % W;
      const ay = (a / W) | 0;
      for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) clearTile(state, (ay + dy) * W + ax + dx);
    } else {
      clearTile(state, i);
      L.terrain[i] = L.terrain[i] === FOREST ? LAND : L.terrain[i];
    }
    return;
  }
  if (tool === 'smart') {
    L.flags[i] |= SMART;
    return;
  }
  if (t.size === 2) {
    const v = Math.floor(rand(state) * 256);
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const j = (y + dy) * W + x + dx;
        clearTile(state, j);
        L.kind[j] = t.kind;
        L.variant[j] = v;
      }
    }
    L.flags[i] |= ANCHOR;
    return;
  }
  clearTile(state, i);
  if (L.terrain[i] === FOREST) L.terrain[i] = LAND;
  L.kind[i] = t.kind;
  // Zones get their style when they develop; roads have one style.
  L.variant[i] = t.kind === PARK || t.kind === SOLAR || t.kind === BATTERY ? Math.floor(rand(state) * 256) : 0;
}

function clearTile(state, i) {
  const L = state.layers;
  L.kind[i] = EMPTY;
  L.level[i] = 0;
  L.variant[i] = 0;
  L.flags[i] = 0;
  state.neglect[i] = 0;
}

/** Tiles a paint gesture covers, in the order they are built. */
function paintTiles(tool, x, y, x2, y2) {
  const t = TOOLS[tool];
  if (x2 === undefined || y2 === undefined || x2 === null || y2 === null || !t.paint) return [[x, y]];
  const out = [];
  if (t.paint === 'line') {
    // Snap to the dominant axis: a drag paints a straight road.
    const horizontal = Math.abs(x2 - x) >= Math.abs(y2 - y);
    const len = horizontal ? Math.abs(x2 - x) : Math.abs(y2 - y);
    const sx = horizontal ? Math.sign(x2 - x) : 0;
    const sy = horizontal ? 0 : Math.sign(y2 - y);
    for (let k = 0; k <= len; k++) out.push([x + sx * k, y + sy * k]);
  } else {
    // Rectangles fill row by row from the corner the drag started at.
    const sx = x2 >= x ? 1 : -1;
    const sy = y2 >= y ? 1 : -1;
    for (let yy = y; yy !== y2 + sy; yy += sy) for (let xx = x; xx !== x2 + sx; xx += sx) out.push([xx, yy]);
  }
  return out;
}

/**
 * Use a tool. With x2, y2 a paint tool covers a line (road) or a rectangle
 * (zones): tiles that cannot take it are skipped, and painting stops when the
 * money runs out, so a long drag builds as much as the player can afford.
 */
export function apply(state, tool, x, y, x2, y2) {
  if (!TOOLS[tool]) return { ok: false, cost: 0, placed: 0, reason: 'Unknown tool' };
  if (tool === 'inspect') return { ok: true, cost: 0, placed: 0, reason: '' };
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inMap(x, y)) return { ok: false, cost: 0, placed: 0, reason: 'Off the map' };
  const ex = Number.isInteger(x2) ? clamp(x2, 0, W - 1) : undefined;
  const ey = Number.isInteger(y2) ? clamp(y2, 0, H - 1) : undefined;
  let cost = 0;
  let placed = 0;
  let firstReason = '';
  let broke = false;
  for (const [tx, ty] of paintTiles(tool, x, y, ex, ey)) {
    const c = canPlace(state, tool, tx, ty);
    if (!c.ok) {
      if (c.reason === NO_CREDITS) { broke = true; break; }
      if (!firstReason) firstReason = c.reason;
      continue;
    }
    place(state, tool, tx, ty, c.cost);
    cost += c.cost;
    placed++;
  }
  if (placed > 0) refresh(state);
  if (placed === 0) return { ok: false, cost: 0, placed: 0, reason: broke ? NO_CREDITS : firstReason || 'Nothing to do' };
  return { ok: true, cost, placed, reason: broke ? NO_CREDITS : '' };
}

// --- the maps ---------------------------------------------------------------------

/** Road access, and each tile's nearest road (where its trips go). */
function computeAccess(state) {
  const { terrain, kind, flags } = state.layers;
  const roadOf = state.d.roadOf;
  for (let i = 0; i < N; i++) {
    flags[i] &= ~ROAD_ACCESS;
    roadOf[i] = -1;
    if (terrain[i] === WATER) continue;
    if (kind[i] === ROAD) {
      roadOf[i] = i;
      flags[i] |= ROAD_ACCESS;
      continue;
    }
    const x = i % W;
    const y = (i / W) | 0;
    for (let o = 0; o < ACCESS_OFFSETS.length; o += 2) {
      const nx = x + ACCESS_OFFSETS[o];
      const ny = y + ACCESS_OFFSETS[o + 1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (kind[j] === ROAD) {
        roadOf[i] = j;
        if (kind[i] !== EMPTY) flags[i] |= ROAD_ACCESS;
        break;
      }
    }
  }
}

/**
 * Calls `fn(j)` for each tile linked to tile `i` by road access: a building's
 * access road, or, for a road, the buildings whose access road it is. Roads
 * carry the grid to the lots they serve, so a zone that a road reaches is on
 * the grid even across the 1–2 tile gap the access rule allows. Without this
 * link, a lot two rows from its road had access but sat on an island with no
 * power, and Synergy proposed a second plant beside a working one.
 */
function forAccessLinks(kind, roadOf, i, fn) {
  if (kind[i] !== ROAD) {
    if (roadOf[i] >= 0) fn(roadOf[i]);
    return;
  }
  const x = i % W;
  const y = (i / W) | 0;
  for (let o = 0; o < ACCESS_OFFSETS.length; o += 2) {
    const nx = x + ACCESS_OFFSETS[o];
    const ny = y + ACCESS_OFFSETS[o + 1];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (roadOf[j] === i && kind[j] !== EMPTY) fn(j);
  }
}

/**
 * Power: every non-empty tile conducts to the tiles it touches, and roads also
 * conduct to the buildings they give access to (forAccessLinks). Each
 * connected network sums its supply, then powers tiles in breadth-first order
 * outward from its sources until the supply runs out, so an overloaded grid
 * browns out at its far edge, the way a player can see and fix, rather than
 * flickering at random.
 */
function computePower(state) {
  const { kind, level, flags } = state.layers;
  const d = state.d;
  const comp = d.comp;
  const roadOf = d.roadOf;
  const { queue, queue2, visit } = scratch;
  comp.fill(0);
  visit.fill(0);
  d.nets = [];
  for (let i = 0; i < N; i++) flags[i] &= ~POWERED;

  for (let s = 0; s < N; s++) {
    if (kind[s] === EMPTY || comp[s]) continue;
    const id = d.nets.length + 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    comp[s] = id;
    let gen = 0;
    let batteries = 0;
    let draw = 0;
    let sources = 0;
    const join = (j) => {
      if (!comp[j]) { comp[j] = id; queue[tail++] = j; }
    };
    while (head < tail) {
      const i = queue[head++];
      const k = kind[i];
      if (k === PLANT) { if (flags[i] & ANCHOR) gen += SUPPLY_PLANT; sources++; }
      else if (k === SOLAR) { gen += SUPPLY_SOLAR; sources++; }
      else if (k === BATTERY) { batteries++; sources++; }
      draw += drawOf(k, level[i], flags[i]);
      const x = i % W;
      if (x > 0 && kind[i - 1] !== EMPTY && !comp[i - 1]) { comp[i - 1] = id; queue[tail++] = i - 1; }
      if (x < W - 1 && kind[i + 1] !== EMPTY && !comp[i + 1]) { comp[i + 1] = id; queue[tail++] = i + 1; }
      if (i >= W && kind[i - W] !== EMPTY && !comp[i - W]) { comp[i - W] = id; queue[tail++] = i - W; }
      if (i < N - W && kind[i + W] !== EMPTY && !comp[i + W]) { comp[i + W] = id; queue[tail++] = i + W; }
      forAccessLinks(kind, roadOf, i, join);
    }
    const supply = gen + (gen > 0 ? batteries * SUPPLY_BATTERY : 0);
    const net = { id, size: tail, supply, draw, served: 0, sources, x: s % W, y: (s / W) | 0 };
    d.nets.push(net);
    if (supply <= 0) continue;

    // Second pass: breadth-first from every source at once.
    let h2 = 0;
    let t2 = 0;
    for (let q = 0; q < tail; q++) {
      const i = queue[q];
      const k = kind[i];
      if (k === PLANT || k === SOLAR || k === BATTERY) { queue2[t2++] = i; visit[i] = id; }
    }
    let left = supply;
    let out = false;
    const reach = (j) => {
      if (visit[j] !== id) { visit[j] = id; queue2[t2++] = j; }
    };
    while (h2 < t2) {
      const i = queue2[h2++];
      const need = drawOf(kind[i], level[i], flags[i]);
      if (!out && left + 1e-9 >= need) {
        flags[i] |= POWERED;
        left -= need;
        net.served += need;
      } else {
        out = true;
      }
      const x = i % W;
      if (x > 0 && comp[i - 1] === id && visit[i - 1] !== id) { visit[i - 1] = id; queue2[t2++] = i - 1; }
      if (x < W - 1 && comp[i + 1] === id && visit[i + 1] !== id) { visit[i + 1] = id; queue2[t2++] = i + 1; }
      if (i >= W && comp[i - W] === id && visit[i - W] !== id) { visit[i - W] = id; queue2[t2++] = i - W; }
      if (i < N - W && comp[i + W] === id && visit[i + W] !== id) { visit[i + W] = id; queue2[t2++] = i + W; }
      forAccessLinks(kind, roadOf, i, reach);
    }
  }
}

/** Separable 3-tap blur, edges clamped. `w` is the centre weight ([1, w, 1]). */
function blur(src, tmp, w) {
  const norm = 1 / (w + 2);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const l = x > 0 ? src[i - 1] : src[i];
      const r = x < W - 1 ? src[i + 1] : src[i];
      tmp[i] = (l + src[i] * w + r) * norm;
    }
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x;
      const u = y > 0 ? tmp[i - W] : tmp[i];
      const dn = y < H - 1 ? tmp[i + W] : tmp[i];
      src[i] = (u + tmp[i] * w + dn) * norm;
    }
  }
}

/** Trips onto the nearest road, spread along the network, relieved by skyports. */
function computeTraffic(state) {
  const { kind, level, flags, traffic } = state.layers;
  const roadOf = state.d.roadOf;
  const { a: tr, b: tmp, list: roads, mark } = scratch;
  tr.fill(0);
  let nRoads = 0;
  for (let i = 0; i < N; i++) {
    const k = kind[i];
    if (k === ROAD) roads[nRoads++] = i;
    else if (isZone(k) && level[i] > 0 && roadOf[i] >= 0) tr[roadOf[i]] += TRIPS[k] * level[i];
  }
  for (let pass = 0; pass < DIFFUSE_PASSES; pass++) {
    for (let r = 0; r < nRoads; r++) {
      const i = roads[r];
      const x = i % W;
      let sum = 0;
      let n = 0;
      if (x > 0 && kind[i - 1] === ROAD) { sum += tr[i - 1]; n++; }
      if (x < W - 1 && kind[i + 1] === ROAD) { sum += tr[i + 1]; n++; }
      if (i >= W && kind[i - W] === ROAD) { sum += tr[i - W]; n++; }
      if (i < N - W && kind[i + W] === ROAD) { sum += tr[i + W]; n++; }
      tmp[i] = n ? tr[i] * 0.5 + (sum / n) * 0.5 : tr[i];
    }
    for (let r = 0; r < nRoads; r++) tr[roads[r]] = tmp[roads[r]];
  }

  // Powered skyports take trips off the roads within their radius (no stacking).
  mark.fill(0);
  let any = false;
  for (let i = 0; i < N; i++) {
    if (kind[i] !== SKYPORT || !(flags[i] & ANCHOR) || !(flags[i] & POWERED)) continue;
    any = true;
    const cx = (i % W) + 1;
    const cy = ((i / W) | 0) + 1;
    for (let y = Math.max(0, cy - SKYPORT_RADIUS - 1); y < Math.min(H, cy + SKYPORT_RADIUS + 1); y++) {
      for (let x = Math.max(0, cx - SKYPORT_RADIUS - 1); x < Math.min(W, cx + SKYPORT_RADIUS + 1); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= SKYPORT_RADIUS * SKYPORT_RADIUS) mark[y * W + x] = 1;
      }
    }
  }
  let sky = 0;
  if (any) {
    for (let r = 0; r < nRoads; r++) {
      const i = roads[r];
      if (!mark[i]) continue;
      sky += tr[i] * (1 - SKYPORT_RELIEF);
      tr[i] *= SKYPORT_RELIEF;
    }
  }
  state.d.skyTrips = sky;
  traffic.fill(0);
  for (let r = 0; r < nRoads; r++) traffic[roads[r]] = Math.min(255, Math.round(tr[roads[r]]));
}

function computePollution(state) {
  const { kind, level, flags, traffic, pollution } = state.layers;
  const { a: p, b: tmp } = scratch;
  for (let i = 0; i < N; i++) {
    const k = kind[i];
    let v = 0;
    if (k === IND) v = POLLUTION_IND * level[i] * (flags[i] & SMART ? 0.5 : 1);
    else if (k === PLANT) v = POLLUTION_PLANT;
    else if (k === ROAD) v = traffic[i] * POLLUTION_TRAFFIC;
    p[i] = v;
  }
  for (let i = 0; i < N; i++) {
    if (kind[i] !== PARK) continue;
    const x = i % W;
    const y = (i / W) | 0;
    for (let ny = Math.max(0, y - PARK_CLEAN_RADIUS); ny <= Math.min(H - 1, y + PARK_CLEAN_RADIUS); ny++) {
      for (let nx = Math.max(0, x - PARK_CLEAN_RADIUS); nx <= Math.min(W - 1, x + PARK_CLEAN_RADIUS); nx++) {
        p[ny * W + nx] -= PARK_CLEANS;
      }
    }
  }
  for (let i = 0; i < N; i++) if (p[i] < 0) p[i] = 0;
  // Two box passes ([1,1,1] twice): pollution reaches about two tiles out.
  blur(p, tmp, 1);
  blur(p, tmp, 1);
  for (let i = 0; i < N; i++) pollution[i] = Math.min(255, Math.round(p[i] * POLLUTION_GAIN));
}

function computeLandValue(state) {
  const { terrain, kind, flags, pollution, traffic, landValue } = state.layers;
  const { roadOf, waterDist } = state.d;
  const { a: lv, b: tmp, c: parkB, d: skyB } = scratch;
  parkB.fill(0);
  skyB.fill(0);
  // Parks and skyports stamp a bonus that fades with Chebyshev distance;
  // overlapping ones keep the best, so spamming them does not stack.
  for (let i = 0; i < N; i++) {
    const k = kind[i];
    if (k !== PARK && !(k === SKYPORT && flags[i] & ANCHOR)) continue;
    const park = k === PARK;
    const out = park ? parkB : skyB;
    const reach = park ? 4 : 8;
    const x0 = i % W;
    const y0 = (i / W) | 0;
    const x1 = x0 + (park ? 0 : 1);
    const y1 = y0 + (park ? 0 : 1);
    for (let y = Math.max(0, y0 - reach); y <= Math.min(H - 1, y1 + reach); y++) {
      const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
      for (let x = Math.max(0, x0 - reach); x <= Math.min(W - 1, x1 + reach); x++) {
        const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
        const dist = Math.max(1, dx, dy);
        const b = park ? (LV_PARK * (5 - dist)) / 4 : (LV_SKYPORT * (9 - dist)) / 8;
        const j = y * W + x;
        if (b > out[j]) out[j] = b;
      }
    }
  }
  for (let i = 0; i < N; i++) {
    const wd = waterDist[i];
    let v = LV_BASE + parkB[i] + skyB[i];
    if (terrain[i] === WATER) v += LV_WATER; // keeps the blur from dragging shorelines down
    else if (wd <= 3) v += (LV_WATER * (4 - wd)) / 3;
    if (flags[i] & SMART) v += LV_SMART;
    const near = roadOf[i] >= 0 ? traffic[roadOf[i]] : 0;
    v -= pollution[i] * LV_POLLUTION + near * LV_TRAFFIC;
    lv[i] = clamp(v, 0, 255);
  }
  blur(lv, tmp, 2);
  for (let i = 0; i < N; i++) landValue[i] = terrain[i] === WATER ? 0 : Math.round(clamp(lv[i], 0, 255));
}

/** Population, jobs, counts and power totals: what stats() and the advisor read. */
function computeTotals(state) {
  const { kind, level, flags } = state.layers;
  const t = {
    residents: 0, jobsC: 0, jobsI: 0, developed: 0, smart: 0, unpowered: 0, unpoweredLots: 0,
    noAccess: 0, zoned: 0, count: new Array(10).fill(0), supply: 0, draw: 0, served: 0, upkeep: 0,
    trafficMax: 0,
  };
  for (let i = 0; i < N; i++) {
    const k = kind[i];
    if (k === EMPTY) continue;
    const f = flags[i];
    if (k === PLANT || k === SKYPORT) { if (f & ANCHOR) t.count[k]++; }
    else t.count[k]++;
    if (!isZone(k)) continue;
    t.zoned++;
    const lv = level[i];
    if (!(f & ROAD_ACCESS)) t.noAccess++;
    if (lv === 0) {
      if (!(f & POWERED)) t.unpoweredLots++;
      continue;
    }
    t.developed++;
    if (f & SMART) t.smart++;
    if (!(f & POWERED)) t.unpowered++;
    if (k === RES) t.residents += RESIDENTS[lv];
    else if (k === COM) t.jobsC += JOBS_C[lv];
    else t.jobsI += JOBS_I[lv];
  }
  for (const net of state.d.nets) {
    t.supply += net.supply;
    t.draw += net.draw;
    t.served += net.served;
  }
  for (let k = 0; k < 10; k++) t.upkeep += UPKEEP[k] * t.count[k];
  const traffic = state.layers.traffic;
  for (let i = 0; i < N; i++) if (traffic[i] > t.trafficMax) t.trafficMax = traffic[i];
  state.d.totals = t;
  return t;
}

/**
 * Rebuild everything derived after editing layers directly (the tests build
 * cities this way; so could a scenario editor). Tools never need it.
 */
export function recompute(state) {
  computeWaterDist(state);
  refresh(state);
}

/** Recompute everything derived from the layers. Called after every change. */
function refresh(state) {
  computeAccess(state);
  computePower(state);
  computeTraffic(state);
  computePollution(state);
  computeLandValue(state);
  computeTotals(state);
}

// --- demand and growth -----------------------------------------------------------------

/**
 * Where demand is heading. Exported so the tests (and anyone curious) can see
 * the valve logic on its own. Small slack terms give a brand-new town settlers,
 * a corner shop and a workshop before the big ratios mean anything.
 *
 * The baselines (DEMAND_BASE_*) are what a balanced city keeps: people keep
 * moving to a city whose jobs and homes match. Without them the R valve opened
 * only once jobs beat workers by about a fifth, while industry stopped as soon
 * as jobs passed workers, so a well-run city stalled for good at a few
 * thousand residents with every valve just under the growth bar.
 */
export function demandTargets({ residents, jobsC, jobsI, tax }) {
  const jobs = jobsC + jobsI;
  const workers = residents * WORKER_SHARE;
  const shift = (NEUTRAL_TAX - tax) * TAX_DEMAND;
  // Residents follow jobs: when there are more jobs than workers, people move in.
  const r = clamp(DEMAND_BASE_R + ((jobs + 120 - workers) / (workers + jobs + 150)) * 2, -1, 1);
  // Shops follow residents: about 0.3 commercial jobs per resident.
  const c = clamp(DEMAND_BASE_C + ((residents * 0.3 + 30 - jobsC) / (residents * 0.3 + jobsC + 100)) * 2, -1, 1);
  // Industry sells outside the city and wants workers.
  const i = clamp(DEMAND_BASE_I + ((workers + 60 - jobs) / (workers + jobs + 150)) * 1.5, -1, 1);
  return { r: clamp(r + shift, -1, 1), c: clamp(c + shift, -1, 1), i: clamp(i + shift, -1, 1) };
}

function updateDemand(state) {
  const t = state.d.totals;
  const target = demandTargets({ residents: t.residents, jobsC: t.jobsC, jobsI: t.jobsI, tax: state.tax });
  // Eased, so a valve opens over a few months instead of slamming.
  state.demand.r += (target.r - state.demand.r) * 0.3;
  state.demand.c += (target.c - state.demand.c) * 0.3;
  state.demand.i += (target.i - state.demand.i) * 0.3;
}

/** How much a tile's own surroundings help or hurt its zone type. */
function localScore(k, lv, pol, near) {
  // Land value is neutral at its base (LV_BASE): plain land neither helps nor hurts.
  if (k === RES) return ((lv - LV_BASE) / 100) * 0.8 - (pol / 100) * 0.6 - (Math.max(0, near - 80) / 100) * 0.4;
  if (k === COM) {
    // Shops like passing trade, up to a point.
    return ((lv - LV_BASE) / 100) * 0.5 + (Math.min(near, 100) / 100) * 0.1
      - (Math.max(0, near - HEAVY_TRAFFIC) / 100) * 0.5 - (pol / 100) * 0.2;
  }
  return 0.05 - (Math.max(0, near - HEAVY_TRAFFIC) / 100) * 0.4; // industry minds congestion, not smoke
}

function scoreOf(state, i) {
  const L = state.layers;
  const k = L.kind[i];
  const ro = state.d.roadOf[i];
  const near = ro >= 0 ? L.traffic[ro] : 0;
  const dem = k === RES ? state.demand.r : k === COM ? state.demand.c : state.demand.i;
  return dem + localScore(k, L.landValue[i], L.pollution[i], near);
}

function grow(state, events) {
  const L = state.layers;
  const { kind, level, flags, variant, landValue } = L;
  const t = state.d.totals;
  const order = scratch.list;
  let m = 0;
  for (let i = 0; i < N; i++) if (isZone(kind[i])) order[m++] = i;
  // Seeded shuffle, so the city never changes in lockstep or in scan order.
  for (let j = m - 1; j > 0; j--) {
    const k = Math.floor(rand(state) * (j + 1));
    const tmp = order[j];
    order[j] = order[k];
    order[k] = tmp;
  }
  // A monthly growth budget per type keeps one good month from overshooting.
  let budgetR = Math.max(0, state.demand.r) * (BUDGET_R + t.residents * BUDGET_SHARE);
  let budgetC = Math.max(0, state.demand.c) * (BUDGET_C + t.jobsC * BUDGET_SHARE);
  let budgetI = Math.max(0, state.demand.i) * (BUDGET_I + t.jobsI * BUDGET_SHARE);
  const bar0 = GROW_BAR + (state.smartCode ? SMART_CODE_BAR : 0);

  for (let o = 0; o < m; o++) {
    const i = order[o];
    const k = kind[i];
    const lv = level[i];
    const f = flags[i];
    const x = i % W;
    const y = (i / W) | 0;
    if (!(f & POWERED) || !(f & ROAD_ACCESS)) {
      if (lv === 0) continue;
      // Lost power or access: the building empties out over a few months.
      if (++state.neglect[i] >= NEGLECT_TICKS) {
        state.neglect[i] = 0;
        level[i] = lv - 1;
        if (level[i] === 0) flags[i] &= ~SMART;
        events.push({ type: 'decline', x, y, kind: k, level: lv - 1, cause: f & POWERED ? 'access' : 'power' });
      }
      continue;
    }
    state.neglect[i] = 0;
    const score = scoreOf(state, i);
    const bar = bar0 + lv * GROW_BAR_PER_LEVEL;
    if (lv < 3 && score > bar) {
      const left = k === RES ? budgetR : k === COM ? budgetC : budgetI;
      if (left <= 0) continue;
      let chance = Math.min(0.6, 0.15 + (score - bar) * 0.8) * LEVEL_PACE[lv + 1];
      if (k !== IND && landValue[i] < LV_FOR_LEVEL[lv + 1]) chance *= POOR_LAND_CHANCE;
      if (rand(state) >= chance) continue;
      level[i] = lv + 1;
      variant[i] = Math.floor(rand(state) * 256);
      if (state.smartCode) flags[i] |= SMART;
      if (k === RES) budgetR -= RESIDENTS[lv + 1] - RESIDENTS[lv];
      else if (k === COM) budgetC -= JOBS_C[lv + 1] - JOBS_C[lv];
      else budgetI -= JOBS_I[lv + 1] - JOBS_I[lv];
      events.push({ type: 'grow', x, y, kind: k, level: lv + 1 });
    } else if (lv > 0 && score < DECLINE_BAR && rand(state) < DECLINE_CHANCE) {
      level[i] = lv - 1;
      if (level[i] === 0) flags[i] &= ~SMART;
      events.push({ type: 'decline', x, y, kind: k, level: lv - 1, cause: 'score' });
    }
  }
}

function monthlyIncome(state, t) {
  return Math.round((state.tax * (t.residents + 1.5 * (t.jobsC + t.jobsI)) * INCOME_RATE) / 12);
}

/** One month. */
export function step(state) {
  const events = [];
  updateDemand(state);
  grow(state, events);
  refresh(state);
  const t = state.d.totals;

  const income = monthlyIncome(state, t);
  const upkeep = t.upkeep;
  state.funds += income - upkeep;
  state.lastIncome = income;
  state.lastUpkeep = upkeep;
  state.deficitMonths = income < upkeep ? state.deficitMonths + 1 : 0;
  if (state.deficitMonths === 1 || (state.funds < 0 && state.funds - income + upkeep >= 0)) {
    events.push({ type: 'deficit', funds: state.funds });
  }
  if (t.unpowered > 0 && state.unpoweredBefore === 0) events.push({ type: 'brownout', unpowered: t.unpowered });
  state.unpoweredBefore = t.unpowered;
  while (state.milestone < MILESTONES.length && t.residents >= MILESTONES[state.milestone]) {
    events.push({ type: 'milestone', residents: MILESTONES[state.milestone] });
    state.milestone++;
  }

  state.tick++;
  if (state.tick % 12 === 0) events.push({ type: 'year', year: 1 + state.tick / 12 });
  return { events };
}

// --- budget and policy -------------------------------------------------------------------

export function setTax(state, rate) {
  const r = Math.round(Number(rate));
  if (!Number.isFinite(r)) return { ok: false, reason: 'Tax must be a number' };
  state.tax = clamp(r, 0, MAX_TAX);
  return { ok: true, reason: '', rate: state.tax };
}

export function setPolicy(state, name, value) {
  if (name !== 'smartCode') return { ok: false, reason: 'Unknown policy' };
  state.smartCode = !!value;
  return { ok: true, reason: '' };
}

// --- reading the city --------------------------------------------------------------------

export function stats(state) {
  const t = state.d.totals;
  const month = state.tick % 12;
  const year = 1 + Math.floor(state.tick / 12);
  const income = monthlyIncome(state, t);
  return {
    tick: state.tick,
    year,
    month, // 0-based index into MONTHS
    monthName: MONTHS[month],
    date: `${MONTHS[month]}, Year ${year}`,
    funds: state.funds,
    residents: t.residents,
    jobs: t.jobsC + t.jobsI,
    jobsC: t.jobsC,
    jobsI: t.jobsI,
    power: { supply: t.supply, demand: round1(t.draw), served: round1(t.served) },
    demand: { r: round3(state.demand.r), c: round3(state.demand.c), i: round3(state.demand.i) },
    tax: state.tax,
    smartCode: state.smartCode,
    income, // projected for the coming month at the current tax
    upkeep: t.upkeep,
    net: income - t.upkeep,
    lastIncome: state.lastIncome,
    lastUpkeep: state.lastUpkeep,
    deficitMonths: state.deficitMonths,
    developed: t.developed,
    zoned: t.zoned,
    smartTiles: t.smart,
    unpowered: t.unpowered,
    unpoweredLots: t.unpoweredLots,
    noAccess: t.noAccess,
    roads: t.count[ROAD],
    parks: t.count[PARK],
    plants: t.count[PLANT],
    solar: t.count[SOLAR],
    batteries: t.count[BATTERY],
    skyports: t.count[SKYPORT],
    trafficMax: t.trafficMax,
    skyTrips: Math.round(state.d.skyTrips),
  };
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

const LEVEL_LABELS = {
  [RES]: ['Residential lot', 'Eco-homes', 'Apartments', 'Residential tower'],
  [COM]: ['Commercial lot', 'Shops', 'Offices', 'Glass tower'],
  [IND]: ['Industrial lot', 'Workshops', 'Factory', 'Automated hall'],
};
const KIND_LABELS = ['Empty land', 'Road', '', '', '', 'Park', 'Fusion plant', 'Solar farm', 'Battery', 'Skyport'];

export function inspect(state, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inMap(x, y)) return null;
  const L = state.layers;
  const i = y * W + x;
  const k = L.kind[i];
  const lv = L.level[i];
  const f = L.flags[i];
  const ro = state.d.roadOf[i];
  let label = isZone(k) ? LEVEL_LABELS[k][lv] : KIND_LABELS[k];
  if (k === EMPTY) label = L.terrain[i] === WATER ? 'Water' : L.terrain[i] === FOREST ? 'Forest' : 'Empty land';
  if (f & SMART) label = `Smart ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  const a = anchorOf(state, x, y);
  const info = {
    x,
    y,
    kind: k,
    kindName: KIND_NAMES[k],
    terrain: L.terrain[i],
    level: lv,
    variant: L.variant[i],
    powered: !!(f & POWERED),
    roadAccess: !!(f & ROAD_ACCESS),
    smart: !!(f & SMART),
    landValue: L.landValue[i],
    pollution: L.pollution[i],
    // A building's traffic is the traffic on the road its trips use.
    traffic: k === ROAD ? L.traffic[i] : ro >= 0 ? L.traffic[ro] : 0,
    residents: k === RES ? RESIDENTS[lv] : 0,
    jobs: k === COM ? JOBS_C[lv] : k === IND ? JOBS_I[lv] : 0,
    powerDraw: round1(drawOf(k, lv, f) * (k === SKYPORT ? 4 : 1)),
    label,
  };
  if (a >= 0) info.anchor = { x: a % W, y: (a / W) | 0 };
  if (isZone(k) && (f & POWERED) && (f & ROAD_ACCESS)) info.score = round3(scoreOf(state, i));
  return info;
}

// --- Synergy, the advisor ------------------------------------------------------------------
// Rules, not a mind: each proposal kind is one condition over the maps, a
// concrete action that goes through the same canPlace/apply as a player's tool,
// and reasons that quote the numbers the condition read. advise() is pure; it
// only reads, so the UI can call it as often as it likes.

const at = (x, y) => `(${x}, ${y})`;

/** Nearest valid anchor for `tool` around (cx, cy), ring by ring. */
function nearestSpot(state, tool, cx, cy, maxR, accept) {
  for (let r = 0; r <= maxR; r++) {
    let best = null;
    let bestD = Infinity;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r || !inMap(x, y)) continue;
        if (!canPlace(state, tool, x, y).ok || (accept && !accept(x, y))) continue;
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < bestD) { bestD = d; best = { x, y }; }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Does a size×size footprint at (x, y) touch a tile of network `id`? */
function touchesNet(state, x, y, size, id) {
  const comp = state.d.comp;
  for (let yy = y - 1; yy <= y + size; yy++) {
    for (let xx = x - 1; xx <= x + size; xx++) {
      const edge = (yy === y - 1 || yy === y + size) !== (xx === x - 1 || xx === x + size);
      if (!edge || !inMap(xx, yy)) continue;
      if (comp[yy * W + xx] === id) return true;
    }
  }
  return false;
}

function proposePower(state, t) {
  if (t.unpowered === 0 && t.unpoweredLots < 4) return null;
  const { kind, level, flags } = state.layers;
  const comp = state.d.comp;
  // The network holding the most unpowered zone tiles is where a source helps most.
  const tally = new Map();
  for (let i = 0; i < N; i++) {
    if (!isZone(kind[i]) || flags[i] & POWERED) continue;
    const id = comp[i];
    const e = tally.get(id) || { n: 0, dev: 0, sx: 0, sy: 0 };
    e.n++;
    if (level[i] > 0) e.dev++;
    e.sx += i % W;
    e.sy += (i / W) | 0;
    tally.set(id, e);
  }
  let id = 0;
  let e = null;
  for (const [k, v] of tally) if (!e || v.dev * 4 + v.n > e.dev * 4 + e.n) { id = k; e = v; }
  if (!e) return null;
  const net = state.d.nets[id - 1];
  const cx = Math.round(e.sx / e.n);
  const cy = Math.round(e.sy / e.n);
  const isolated = net.supply === 0;
  const gap = Math.max(0, net.draw - net.supply);
  // Proportionate: a small gap gets a solar farm, a real one gets a plant.
  const order = !isolated && gap <= SUPPLY_SOLAR ? ['solar', 'plant'] : ['plant', 'solar'];
  for (const tool of order) {
    const size = TOOLS[tool].size;
    const spot = nearestSpot(state, tool, cx, cy, 24, (x, y) => touchesNet(state, x, y, size, id));
    if (!spot) continue;
    const reasons = [];
    if (t.unpowered > 0) reasons.push(`${t.unpowered} developed tile${t.unpowered === 1 ? ' has' : 's have'} no power`);
    if (t.unpoweredLots > 0) reasons.push(`${t.unpoweredLots} zoned lot${t.unpoweredLots === 1 ? '' : 's'} without power cannot grow`);
    reasons.push(isolated
      ? `Their grid near ${at(cx, cy)} has no power source`
      : `Their grid supplies ${fmt(net.supply)} but needs ${fmt(net.draw)}`);
    const add = tool === 'plant' ? SUPPLY_PLANT : SUPPLY_SOLAR;
    reasons.push(`A ${TOOLS[tool].label.toLowerCase()} at ${at(spot.x, spot.y)} adds ${add} supply for ${fmt(TOOLS[tool].cost)} cr`);
    return {
      id: `power@${spot.x},${spot.y}:${tool}`,
      kind: 'power',
      title: tool === 'plant' ? 'Build a fusion plant' : 'Build a solar farm',
      reasons,
      action: { type: 'build', tool, x: spot.x, y: spot.y },
      gate: 'G1',
    };
  }
  return null;
}

function proposeAccess(state, t) {
  if (t.noAccess < 3) return null;
  const { kind, flags } = state.layers;
  const cut = scratch.mark;
  cut.fill(0);
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < N; i++) {
    if (!isZone(kind[i]) || flags[i] & ROAD_ACCESS) continue;
    cut[i] = 1;
    const x = i % W;
    const y = (i / W) | 0;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  let best = null;
  let bestN = 0;
  let bestJoins = false;
  for (let y = Math.max(0, y0 - 2); y <= Math.min(H - 1, y1 + 2); y++) {
    for (let x = Math.max(0, x0 - 2); x <= Math.min(W - 1, x1 + 2); x++) {
      if (!canPlace(state, 'road', x, y).ok) continue;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) if (inMap(x + dx, y + dy) && cut[(y + dy) * W + x + dx]) n++;
      }
      const i = y * W + x;
      // Extending an existing road beats an island of tarmac.
      const joins = (x > 0 && kind[i - 1] === ROAD) || (x < W - 1 && kind[i + 1] === ROAD)
        || (y > 0 && kind[i - W] === ROAD) || (y < H - 1 && kind[i + W] === ROAD);
      if (n > bestN || (n === bestN && n > 0 && joins && !bestJoins)) { best = { x, y }; bestN = n; bestJoins = joins; }
    }
  }
  if (!best) return null;
  return {
    id: `access@${best.x},${best.y}`,
    kind: 'access',
    title: 'Connect zones to a road',
    reasons: [
      `${t.noAccess} zoned tile${t.noAccess === 1 ? ' has' : 's have'} no road within 2 tiles, so they cannot grow`,
      `A road at ${at(best.x, best.y)} reaches ${bestN} of them for ${TOOLS.road.cost} cr`,
    ],
    action: { type: 'build', tool: 'road', x: best.x, y: best.y },
    gate: 'G1',
  };
}

function proposeTaxUp(state) {
  if (state.deficitMonths < 3 || state.tax >= MAX_TAX) return null;
  const rate = state.tax + 1;
  return {
    id: `tax:${rate}`,
    kind: 'taxUp',
    title: `Raise tax to ${rate} %`,
    reasons: [
      `Upkeep has exceeded income for ${state.deficitMonths} months`,
      `Last month: ${fmt(state.lastIncome)} cr in, ${fmt(state.lastUpkeep)} cr out; funds ${fmt(state.funds)} cr`,
      `Each tax point lowers demand for every zone by ${TAX_DEMAND}`,
    ],
    action: { type: 'tax', rate },
    gate: 'G6',
  };
}

function proposeTaxDown(state) {
  const { r, c, i } = state.demand;
  if (state.tax <= 0 || r > -0.3 || c > -0.3 || i > -0.3) return null;
  const rate = state.tax - 1;
  return {
    id: `tax:${rate}`,
    kind: 'taxDown',
    title: `Lower tax to ${rate} %`,
    reasons: [
      `Demand is negative for every zone: R ${signed(r)}, C ${signed(c)}, I ${signed(i)}`,
      `Tax is ${state.tax} %; each point lower raises every zone's demand by ${TAX_DEMAND}`,
    ],
    action: { type: 'tax', rate },
    gate: 'G6',
  };
}

function proposeSkyport(state, t) {
  if (t.trafficMax < CONGESTED) return null;
  const { traffic, kind } = state.layers;
  let worst = -1;
  let congested = 0;
  for (let i = 0; i < N; i++) {
    if (kind[i] !== ROAD || traffic[i] < CONGESTED) continue;
    congested++;
    if (worst < 0 || traffic[i] > traffic[worst]) worst = i;
  }
  if (worst < 0) return null;
  const wx = worst % W;
  const wy = (worst / W) | 0;
  // Already relieved: a skyport within reach is powered, so another would stack nothing.
  if (relievedBySkyport(state, wx, wy)) return null;
  const comp = state.d.comp;
  const powered = (x, y) => {
    for (let yy = y - 1; yy <= y + 2; yy++) {
      for (let xx = x - 1; xx <= x + 2; xx++) {
        if (!inMap(xx, yy)) continue;
        const j = yy * W + xx;
        if (comp[j] && state.d.nets[comp[j] - 1].supply > 0) return true;
      }
    }
    return false;
  };
  const spot = nearestSpot(state, 'skyport', wx, wy, 6, powered);
  if (!spot) return null;
  return {
    id: `skyport@${spot.x},${spot.y}`,
    kind: 'congestion',
    title: 'Build a skyport',
    reasons: [
      `Road traffic peaks at ${traffic[worst]} of 255 at ${at(wx, wy)}`,
      `${congested} road tile${congested === 1 ? ' is' : 's are'} congested (${CONGESTED} or more)`,
      `A skyport at ${at(spot.x, spot.y)} halves road traffic within ${SKYPORT_RADIUS} tiles for ${fmt(TOOLS.skyport.cost)} cr`,
    ],
    action: { type: 'build', tool: 'skyport', x: spot.x, y: spot.y },
    gate: 'G2',
  };
}

function relievedBySkyport(state, x, y) {
  const { kind, flags } = state.layers;
  for (let i = 0; i < N; i++) {
    if (kind[i] !== SKYPORT || !(flags[i] & ANCHOR) || !(flags[i] & POWERED)) continue;
    const dx = x + 0.5 - ((i % W) + 1);
    const dy = y + 0.5 - (((i / W) | 0) + 1);
    if (dx * dx + dy * dy <= SKYPORT_RADIUS * SKYPORT_RADIUS) return true;
  }
  return false;
}

function proposePark(state) {
  const { kind, level, flags, pollution, landValue } = state.layers;
  // Two reasons for a park: homes sitting in pollution, and homes that demand
  // alone would grow but whose surroundings (low land value) hold them back.
  const bar = GROW_BAR + (state.smartCode ? SMART_CODE_BAR : 0);
  const want = scratch.mark;
  want.fill(0);
  let worst = -1;
  let polluted = 0;
  let held = 0;
  let lvSum = 0;
  for (let i = 0; i < N; i++) {
    if (kind[i] !== RES) continue;
    const lv = level[i];
    if (lv > 0 && pollution[i] >= POLLUTED) {
      polluted++;
      want[i] = 2;
      if (worst < 0 || pollution[i] > pollution[worst]) worst = i;
    } else if (lv < 3 && (flags[i] & (POWERED | ROAD_ACCESS)) === (POWERED | ROAD_ACCESS)
      && state.demand.r > bar + lv * GROW_BAR_PER_LEVEL && scoreOf(state, i) <= bar + lv * GROW_BAR_PER_LEVEL) {
      held++;
      lvSum += landValue[i];
      want[i] = 1;
    }
  }
  if (polluted === 0 && held < 6) return null;
  // The empty tile that reaches the most of those homes (pollution counts double).
  let best = -1;
  let bestN = 0;
  for (let i = 0; i < N; i++) {
    const x = i % W;
    const y = (i / W) | 0;
    if (kind[i] !== EMPTY || !canPlace(state, 'park', x, y).ok) continue;
    let n = 0;
    for (let ny = Math.max(0, y - 3); ny <= Math.min(H - 1, y + 3); ny++) {
      for (let nx = Math.max(0, x - 3); nx <= Math.min(W - 1, x + 3); nx++) n += want[ny * W + nx];
    }
    if (n > bestN) { bestN = n; best = i; }
  }
  if (best < 0) return null;
  const x = best % W;
  const y = (best / W) | 0;
  const reasons = [];
  if (polluted > 0) {
    reasons.push(`${polluted} home tile${polluted === 1 ? ' sits' : 's sit'} in pollution of ${POLLUTED} or more`);
    reasons.push(`Worst: ${pollution[worst]} at ${at(worst % W, (worst / W) | 0)}`);
  }
  if (held >= 6) {
    reasons.push(`${held} homes could grow but are held back by low land value (average ${Math.round(lvSum / held)})`);
  }
  reasons.push(`A park at ${at(x, y)} cuts pollution by ${PARK_CLEANS} within ${PARK_CLEAN_RADIUS} tiles and adds up to ${LV_PARK} land value within 4, for ${TOOLS.park.cost} cr`);
  return {
    id: `park@${x},${y}`,
    kind: 'park',
    title: 'Plant a park',
    reasons,
    action: { type: 'build', tool: 'park', x, y },
    gate: 'G3',
  };
}

function proposeSmartCode(state, t) {
  if (state.smartCode || t.supply <= 0 || t.developed < 12 || t.draw < t.supply * 0.8) return null;
  return {
    id: 'smartCode',
    kind: 'smartCode',
    title: 'Adopt the Smart Code',
    reasons: [
      `Power draw is ${fmt(t.draw)} of ${fmt(t.supply)} supply (${Math.round((t.draw / t.supply) * 100)} %)`,
      `Smart buildings draw ${Math.round((1 - SMART_DRAW) * 100)} % less power, and smart industry pollutes half as much`,
      `Trade-off: new growth needs a slightly higher score (+${SMART_CODE_BAR})`,
    ],
    action: { type: 'policy', name: 'smartCode', value: true },
    gate: 'G5',
  };
}

function proposeRetrofit(state, t) {
  if (!state.smartCode || t.supply <= 0 || t.draw < t.supply * 0.85) return null;
  const { kind, level, flags } = state.layers;
  let best = -1;
  let bestDraw = 0;
  for (let i = 0; i < N; i++) {
    if (!isZone(kind[i]) || level[i] === 0 || flags[i] & SMART) continue;
    const d = drawOf(kind[i], level[i], flags[i]);
    if (d > bestDraw && state.funds >= TOOLS.smart.cost * level[i]) { best = i; bestDraw = d; }
  }
  if (best < 0) return null;
  const x = best % W;
  const y = (best / W) | 0;
  const label = LEVEL_LABELS[kind[best]][level[best]].toLowerCase();
  return {
    id: `smart@${x},${y}`,
    kind: 'retrofit',
    title: 'Retrofit a building',
    reasons: [
      `Power draw is ${fmt(t.draw)} of ${fmt(t.supply)} supply`,
      `The ${label} at ${at(x, y)} draws ${bestDraw}; a retrofit cuts that to ${round1(bestDraw * SMART_DRAW)}`,
      `Cost: ${fmt(TOOLS.smart.cost * level[best])} cr`,
    ],
    action: { type: 'build', tool: 'smart', x, y },
    gate: 'G5',
  };
}

export function advise(state) {
  const t = state.d.totals;
  const cooling = (kind) => (state.cooldown[kind] || 0) > state.tick;
  const out = [];
  const rules = [
    () => proposePower(state, t),
    () => proposeAccess(state, t),
    () => proposeTaxUp(state),
    () => proposeSkyport(state, t),
    () => proposePark(state),
    () => proposeSmartCode(state, t),
    () => proposeRetrofit(state, t),
    () => proposeTaxDown(state),
  ];
  const kinds = ['power', 'access', 'taxUp', 'congestion', 'park', 'smartCode', 'retrofit', 'taxDown'];
  for (let r = 0; r < rules.length && out.length < PROPOSAL_LIMIT; r++) {
    if (cooling(kinds[r])) continue;
    // Raising and lowering tax in the same breath would contradict itself.
    if (kinds[r] === 'taxDown' && out.some((p) => p.kind === 'taxUp')) continue;
    const p = rules[r]();
    if (p) out.push(p);
  }
  return out;
}

/**
 * The human decides. Accepting runs the action through the same rules as a
 * tool (cost and validity included); declining dismisses that kind of proposal
 * for 12 months. Either way the decision is logged, so it can be reviewed.
 */
export function decide(state, id, decision) {
  if (decision !== 'accept' && decision !== 'decline') return { ok: false, reason: 'Decision must be accept or decline' };
  const p = advise(state).find((q) => q.id === id);
  if (!p) return { ok: false, reason: 'That proposal is no longer current' };
  const entry = { tick: state.tick, proposal: copyProposal(p), decision };
  if (decision === 'decline') {
    state.cooldown[p.kind] = state.tick + DECLINE_COOLDOWN;
    pushLog(state, entry);
    return { ok: true, reason: '' };
  }
  const a = p.action;
  let res;
  if (a.type === 'build') res = apply(state, a.tool, a.x, a.y);
  else if (a.type === 'tax') res = setTax(state, a.rate);
  else if (a.type === 'policy') res = setPolicy(state, a.name, a.value);
  else res = { ok: false, reason: 'Unknown action' };
  entry.ok = !!res.ok;
  if (!res.ok) entry.reason = res.reason;
  if (res.ok) {
    state.cooldown[p.kind] = state.tick + ACCEPT_COOLDOWN;
    if (a.type === 'tax') state.deficitMonths = 0; // give the new rate time to show
  }
  pushLog(state, entry);
  return { ok: !!res.ok, reason: res.ok ? '' : res.reason, cost: res.cost || 0 };
}

function copyProposal(p) {
  return { id: p.id, kind: p.kind, title: p.title, reasons: p.reasons.slice(), action: { ...p.action }, gate: p.gate };
}

function pushLog(state, entry) {
  state.log.push(entry);
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

// --- save and load -------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    s += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    s += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return s;
}

function fromB64(s, length) {
  if (typeof s !== 'string' || s.length !== Math.ceil(length / 3) * 4) throw new Error('Save data is damaged');
  const out = new Uint8Array(length);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const ch = s.charCodeAt(i + k);
      const v = ch === 61 ? 0 : ch < 128 ? B64_INDEX[ch] : -1;
      if (v < 0) throw new Error('Save data is damaged');
      n = (n << 6) | v;
    }
    if (o < length) out[o++] = (n >> 16) & 255;
    if (o < length) out[o++] = (n >> 8) & 255;
    if (o < length) out[o++] = n & 255;
  }
  return out;
}

export const SAVE_FORMAT = 'humansi-architect';

/** A JSON-safe snapshot: everything needed to resume exactly, nothing derived. */
export function serialize(state) {
  const layers = {};
  for (const name of SAVED_LAYERS) layers[name] = toB64(state.layers[name]);
  layers.neglect = toB64(state.neglect);
  return {
    format: SAVE_FORMAT,
    version: 1,
    w: W,
    h: H,
    seed: state.seed,
    rng: state.rng,
    tick: state.tick,
    funds: state.funds,
    tax: state.tax,
    smartCode: state.smartCode,
    demand: { ...state.demand },
    deficitMonths: state.deficitMonths,
    lastIncome: state.lastIncome,
    lastUpkeep: state.lastUpkeep,
    milestone: state.milestone,
    unpoweredBefore: state.unpoweredBefore,
    cooldown: { ...state.cooldown },
    log: JSON.parse(JSON.stringify(state.log)),
    layers,
  };
}

const num = (v, lo, hi) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error('Save data is damaged');
  return v;
};

/** Rebuild a state from serialize() output (or its JSON text). Throws on damaged data. */
export function deserialize(obj) {
  const o = typeof obj === 'string' ? JSON.parse(obj) : obj;
  if (!o || o.format !== SAVE_FORMAT || o.version !== 1 || o.w !== W || o.h !== H || !o.layers) {
    throw new Error('Not an Architect save');
  }
  const state = {
    version: 1,
    seed: num(o.seed, 0, 0xffffffff),
    rng: num(o.rng, 0, 0xffffffff),
    tick: num(o.tick, 0, 1e9),
    funds: num(o.funds, -1e12, 1e12),
    tax: num(o.tax, 0, MAX_TAX),
    smartCode: !!o.smartCode,
    demand: { r: num(o.demand?.r, -1, 1), c: num(o.demand?.c, -1, 1), i: num(o.demand?.i, -1, 1) },
    deficitMonths: num(o.deficitMonths, 0, 1e9),
    lastIncome: num(o.lastIncome, -1e12, 1e12),
    lastUpkeep: num(o.lastUpkeep, -1e12, 1e12),
    milestone: num(o.milestone, 0, MILESTONES.length),
    unpoweredBefore: num(o.unpoweredBefore ?? 0, 0, N),
    cooldown: {},
    log: Array.isArray(o.log) ? o.log.slice(-LOG_LIMIT) : [],
    layers: makeLayers(),
    neglect: fromB64(o.layers.neglect, N),
    d: makeDerived(),
  };
  for (const [k, v] of Object.entries(o.cooldown || {})) state.cooldown[k] = num(v, 0, 1e9);
  for (const name of SAVED_LAYERS) state.layers[name] = fromB64(o.layers[name], N);
  const { terrain, kind, level } = state.layers;
  for (let i = 0; i < N; i++) {
    if (terrain[i] > FOREST || kind[i] > SKYPORT || level[i] > 3) throw new Error('Save data is damaged');
  }
  computeWaterDist(state);
  refresh(state);
  return state;
}
