// Node tests for the Architect simulation and its message protocol.
// Run: node --test web/js/architect/sim.test.mjs
//
// They pin behaviour, not the exact tune: directions (more jobs open R), orders
// (brownouts start at the far edge), guarantees (70 % land) and contracts
// (every proposal is applicable, every decision is logged). Cities are either
// played through the public tools or built by writing layers directly and
// calling recompute(), which is how a test gets a precise situation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  W,
  H,
  TERRAIN,
  KIND,
  FLAG,
  TOOLS,
  LAYER_NAMES,
  mulberry32,
  normalizeSeed,
  createState,
  canPlace,
  apply,
  step,
  advise,
  decide,
  setTax,
  setPolicy,
  stats,
  inspect,
  serialize,
  deserialize,
  demandTargets,
  recompute,
} from './sim.js';
import { createProtocol, SPEED_DELAYS } from './protocol.js';

const N = W * H;
const idx = (x, y) => y * W + x;

// --- builders -----------------------------------------------------------------

/** A state on flat, empty land with plenty of money. */
function flat(seed = 1, funds = 1e6) {
  const s = createState(seed);
  s.layers.terrain.fill(TERRAIN.LAND);
  s.funds = funds;
  recompute(s);
  return s;
}

/** Write a tile directly (no cost, no checks); call recompute() afterwards. */
function put(s, x, y, kind, level = 0, flags = 0) {
  const i = idx(x, y);
  s.layers.kind[i] = kind;
  s.layers.level[i] = level;
  s.layers.flags[i] = flags;
}

function putPlant(s, x, y) {
  for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) put(s, x + dx, y + dy, KIND.PLANT);
  s.layers.flags[idx(x, y)] |= FLAG.ANCHOR;
}

const has = (s, x, y, f) => (s.layers.flags[idx(x, y)] & f) !== 0;

function sameLayers(a, b) {
  for (const name of LAYER_NAMES) assert.deepEqual(a.layers[name], b.layers[name], `layer ${name}`);
}

/** A scripted session: the same list of actions replayed on a fresh state. */
function play(seed) {
  const s = createState(seed);
  s.layers.terrain.fill(TERRAIN.LAND, idx(0, 28), idx(0, 36)); // keep the test site clear
  recompute(s);
  apply(s, 'road', 20, 30, 44, 30);
  apply(s, 'plant', 20, 27);
  apply(s, 'res', 24, 28, 31, 29);
  apply(s, 'ind', 34, 31, 38, 32);
  apply(s, 'com', 32, 28, 34, 29);
  for (let m = 0; m < 30; m++) {
    step(s);
    if (m === 10) apply(s, 'park', 30, 31);
    if (m === 12) setTax(s, 9);
    if (m === 20) setPolicy(s, 'smartCode', true);
    for (const p of advise(s)) decide(s, p.id, m % 2 ? 'accept' : 'decline');
  }
  return s;
}

// --- PRNG and determinism ---------------------------------------------------------

test('the PRNG is the same Mulberry32 as city/core.js makeRng', async () => {
  let makeRng;
  try {
    ({ makeRng } = await import('../city/core.js'));
  } catch (err) {
    // core.js pulls in three.js; if that ever stops loading under node, fall
    // back to the published Mulberry32 reference values for seed 42.
    const r = mulberry32(42);
    assert.equal(r(), 0.6011037519201636);
    assert.equal(r(), 0.44829055899754167);
    return;
  }
  for (const seed of [0, 1, 42, 0x5eed, 0xffffffff]) {
    const a = mulberry32(seed);
    const b = makeRng(seed);
    for (let k = 0; k < 50; k++) assert.equal(a(), b(), `seed ${seed} draw ${k}`);
  }
});

test('seeds: numbers pass through, digit strings parse, other text hashes stably', () => {
  assert.equal(normalizeSeed(42), 42);
  assert.equal(normalizeSeed('42'), 42);
  assert.equal(normalizeSeed('river town'), normalizeSeed('river town'));
  assert.notEqual(normalizeSeed('river town'), normalizeSeed('river towns'));
  assert.ok(Number.isInteger(normalizeSeed(undefined)));
});

test('determinism: the same seed and actions replay to an identical city', () => {
  const a = play(1234);
  const b = play(1234);
  sameLayers(a, b);
  assert.deepEqual(stats(a), stats(b));
  assert.deepEqual(advise(a), advise(b));
  assert.deepEqual(a.log, b.log);
  assert.equal(a.rng, b.rng);
  assert.ok(stats(a).residents > 0, 'the scripted city actually grew');
  const c = play(4321);
  assert.notDeepEqual(c.layers.terrain, a.layers.terrain, 'a different seed makes a different map');
});

test('the sim never touches Math.random, Date or performance', () => {
  const saved = { random: Math.random, now: Date.now, perf: globalThis.performance };
  Math.random = () => { throw new Error('Math.random used'); };
  Date.now = () => { throw new Error('Date.now used'); };
  try {
    play(99);
    const s = play(5);
    serialize(s);
  } finally {
    Math.random = saved.random;
    Date.now = saved.now;
  }
});

// --- map generation ---------------------------------------------------------------

test('map generation: 70 % land, a clear centre, water crossing to the edges, forests', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const s = createState(seed);
    const t = s.layers.terrain;
    let land = 0;
    let forest = 0;
    let water = 0;
    for (let i = 0; i < N; i++) {
      if (t[i] === TERRAIN.LAND) land++;
      else if (t[i] === TERRAIN.FOREST) forest++;
      else water++;
    }
    assert.ok(land >= N * 0.7, `seed ${seed}: only ${land} land tiles`);
    assert.ok(water > 0 && forest > 0, `seed ${seed}: water ${water}, forest ${forest}`);
    for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) assert.equal(t[idx(x, y)], TERRAIN.LAND, `seed ${seed} centre ${x},${y}`);
    // A river crosses the map, a coast runs along a whole edge: either way
    // water reaches at least two map edges.
    const edges = [
      [...Array(W).keys()].some((x) => t[idx(x, 0)] === TERRAIN.WATER),
      [...Array(W).keys()].some((x) => t[idx(x, H - 1)] === TERRAIN.WATER),
      [...Array(H).keys()].some((y) => t[idx(0, y)] === TERRAIN.WATER),
      [...Array(H).keys()].some((y) => t[idx(W - 1, y)] === TERRAIN.WATER),
    ].filter(Boolean).length;
    assert.ok(edges >= 2, `seed ${seed}: water touches ${edges} edges`);
    const st = stats(s);
    assert.equal(st.tick, 0);
    assert.equal(st.year, 1);
    assert.equal(st.monthName, 'Jan');
    assert.equal(st.funds, 20000);
    assert.equal(st.tax, 7);
  }
});

test('a brand-new city opens R and I so the first zones can grow', () => {
  const st = stats(createState(3));
  assert.ok(st.demand.r > 0 && st.demand.i > 0);
});

// --- placement ------------------------------------------------------------------------

test('canPlace: inspect and bulldoze', () => {
  const s = flat();
  s.layers.terrain[idx(5, 5)] = TERRAIN.WATER;
  s.layers.terrain[idx(6, 5)] = TERRAIN.FOREST;
  put(s, 7, 5, KIND.ROAD);
  putPlant(s, 10, 10);
  recompute(s);
  assert.deepEqual(canPlace(s, 'inspect', 5, 5), { ok: true, cost: 0, reason: '' });
  assert.equal(canPlace(s, 'inspect', -1, 0).ok, false);
  assert.equal(canPlace(s, 'nope', 1, 1).reason, 'Unknown tool');
  assert.equal(canPlace(s, 'bulldoze', 5, 5).ok, false, 'water stays');
  assert.equal(canPlace(s, 'bulldoze', 1, 1).ok, false, 'nothing to clear');
  assert.deepEqual(canPlace(s, 'bulldoze', 6, 5), { ok: true, cost: 10, reason: '' });
  assert.deepEqual(canPlace(s, 'bulldoze', 7, 5), { ok: true, cost: 5, reason: '' });
  // A 2×2 is cleared whole from any of its tiles, for one bulldoze.
  const r = apply(s, 'bulldoze', 11, 11);
  assert.equal(r.ok, true);
  assert.equal(r.cost, 5);
  for (const [x, y] of [[10, 10], [11, 10], [10, 11], [11, 11]]) assert.equal(s.layers.kind[idx(x, y)], KIND.EMPTY);
  apply(s, 'bulldoze', 6, 5);
  assert.equal(s.layers.terrain[idx(6, 5)], TERRAIN.LAND, 'bulldozing forest clears it');
});

test('canPlace: roads, zones and single-tile structures', () => {
  const s = flat();
  s.layers.terrain[idx(5, 5)] = TERRAIN.WATER;
  s.layers.terrain[idx(6, 5)] = TERRAIN.FOREST;
  put(s, 7, 5, KIND.ROAD);
  put(s, 8, 5, KIND.RES);
  recompute(s);
  assert.deepEqual(canPlace(s, 'road', 1, 1), { ok: true, cost: 10, reason: '' });
  assert.deepEqual(canPlace(s, 'road', 6, 5), { ok: true, cost: 20, reason: '' }, 'forest adds 10');
  assert.equal(canPlace(s, 'road', 5, 5).ok, false);
  assert.equal(canPlace(s, 'road', 7, 5).ok, false);
  assert.equal(canPlace(s, 'road', 8, 5).ok, false);
  for (const tool of ['res', 'com', 'ind']) {
    assert.deepEqual(canPlace(s, tool, 1, 1), { ok: true, cost: 20, reason: '' }, tool);
    assert.equal(canPlace(s, tool, 6, 5).cost, 30, `${tool} on forest`);
    assert.equal(canPlace(s, tool, 5, 5).ok, false, `${tool} on water`);
    assert.equal(canPlace(s, tool, 7, 5).ok, false, `${tool} on road`);
  }
  assert.equal(canPlace(s, 'res', 8, 5).ok, false, 'already zoned');
  for (const [tool, cost] of [['park', 40], ['solar', 400], ['battery', 300]]) {
    assert.deepEqual(canPlace(s, tool, 1, 1), { ok: true, cost, reason: '' }, tool);
    assert.equal(canPlace(s, tool, 7, 5).ok, false, `${tool} on a road`);
    assert.equal(canPlace(s, tool, 5, 5).ok, false, `${tool} on water`);
  }
});

test('canPlace: 2×2 plant and skyport need clear land and fit on the map', () => {
  const s = flat();
  s.layers.terrain[idx(21, 21)] = TERRAIN.FOREST;
  s.layers.terrain[idx(31, 31)] = TERRAIN.WATER;
  put(s, 41, 40, KIND.ROAD);
  recompute(s);
  for (const [tool, cost] of [['plant', 3000], ['skyport', 1500]]) {
    assert.deepEqual(canPlace(s, tool, 1, 1), { ok: true, cost, reason: '' }, tool);
    assert.equal(canPlace(s, tool, 20, 20).ok, false, `${tool}: forest in the footprint`);
    assert.equal(canPlace(s, tool, 30, 30).ok, false, `${tool}: water in the footprint`);
    assert.equal(canPlace(s, tool, 40, 39).ok, false, `${tool}: occupied footprint`);
    assert.equal(canPlace(s, tool, W - 1, 5).ok, false, `${tool}: off the east edge`);
    assert.equal(canPlace(s, tool, 5, H - 1).ok, false, `${tool}: off the south edge`);
  }
  apply(s, 'plant', 1, 1);
  const L = s.layers;
  assert.equal(L.kind[idx(1, 1)], KIND.PLANT);
  assert.equal(L.kind[idx(2, 2)], KIND.PLANT);
  assert.ok(L.flags[idx(1, 1)] & FLAG.ANCHOR);
  assert.equal(L.flags[idx(2, 1)] & FLAG.ANCHOR, 0, 'only the top-left is the anchor');
  assert.equal(L.variant[idx(2, 2)], L.variant[idx(1, 1)], 'one structure, one style');
});

test('canPlace: smart retrofit costs 150 per level on developed buildings only', () => {
  const s = flat();
  put(s, 3, 3, KIND.RES, 0);
  put(s, 4, 3, KIND.RES, 2);
  put(s, 5, 3, KIND.IND, 3, FLAG.SMART);
  put(s, 6, 3, KIND.PARK);
  recompute(s);
  assert.equal(canPlace(s, 'smart', 3, 3).ok, false, 'an empty lot');
  assert.deepEqual(canPlace(s, 'smart', 4, 3), { ok: true, cost: 300, reason: '' });
  assert.equal(canPlace(s, 'smart', 5, 3).ok, false, 'already smart');
  assert.equal(canPlace(s, 'smart', 6, 3).ok, false, 'not a building');
  apply(s, 'smart', 4, 3);
  assert.ok(has(s, 4, 3, FLAG.SMART));
});

test('canPlace: money is checked last and says "Not enough credits"', () => {
  const s = flat(1, 15);
  assert.deepEqual(canPlace(s, 'road', 1, 1), { ok: true, cost: 10, reason: '' });
  assert.deepEqual(canPlace(s, 'res', 1, 1), { ok: false, cost: 20, reason: 'Not enough credits' });
  s.layers.terrain[idx(1, 2)] = TERRAIN.WATER;
  assert.notEqual(canPlace(s, 'res', 1, 2).reason, 'Not enough credits', 'the real obstacle comes first');
  s.funds = -50; // upkeep can push funds below zero
  const r = apply(s, 'road', 1, 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Not enough credits');
});

test('apply paints straight roads and zone rectangles, skipping what cannot take them', () => {
  const s = flat();
  put(s, 14, 10, KIND.RES);
  recompute(s);
  const before = s.funds;
  const r = apply(s, 'road', 10, 10, 20, 12); // mostly horizontal: snaps to y = 10
  assert.equal(r.ok, true);
  assert.equal(r.placed, 10, 'the zoned tile is skipped');
  assert.equal(r.cost, 100);
  assert.equal(s.funds, before - 100);
  for (let x = 10; x <= 20; x++) assert.equal(s.layers.kind[idx(x, 10)], x === 14 ? KIND.RES : KIND.ROAD);
  assert.equal(s.layers.kind[idx(20, 12)], KIND.EMPTY);
  const v = apply(s, 'road', 30, 5, 31, 9); // mostly vertical
  assert.equal(v.placed, 5);
  assert.equal(s.layers.kind[idx(30, 9)], KIND.ROAD);

  const z = apply(s, 'com', 12, 11, 9, 13); // drawn backwards: still the rectangle
  assert.equal(z.placed, 12);
  for (let y = 11; y <= 13; y++) for (let x = 9; x <= 12; x++) assert.equal(s.layers.kind[idx(x, y)], KIND.COM);
  const again = apply(s, 'com', 9, 11, 12, 13);
  assert.equal(again.ok, false, 'nothing left to paint');
});

test('painting stops when the money runs out', () => {
  const s = flat(1, 75);
  const r = apply(s, 'road', 0, 0, 20, 0);
  assert.equal(r.placed, 7);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'Not enough credits');
  assert.equal(s.funds, 5);
  assert.equal(s.layers.kind[idx(6, 0)], KIND.ROAD);
  assert.equal(s.layers.kind[idx(7, 0)], KIND.EMPTY, 'built from the drag start outward');
});

// --- the maps ----------------------------------------------------------------------------

test('road access reaches Chebyshev distance 2 and no further', () => {
  const s = flat();
  put(s, 30, 30, KIND.ROAD);
  for (const [x, y] of [[31, 30], [32, 32], [28, 29], [33, 30], [30, 33]]) put(s, x, y, KIND.RES);
  recompute(s);
  assert.ok(has(s, 31, 30, FLAG.ROAD_ACCESS));
  assert.ok(has(s, 32, 32, FLAG.ROAD_ACCESS), 'diagonal 2');
  assert.ok(has(s, 28, 29, FLAG.ROAD_ACCESS));
  assert.ok(!has(s, 33, 30, FLAG.ROAD_ACCESS), '3 away');
  assert.ok(!has(s, 30, 33, FLAG.ROAD_ACCESS), '3 away');
  assert.equal(stats(s).noAccess, 2);
});

test('power floods through connected tiles from a plant, and not across gaps', () => {
  const s = flat();
  putPlant(s, 10, 10);
  for (let x = 12; x <= 20; x++) put(s, x, 10, KIND.ROAD);
  put(s, 21, 10, KIND.RES, 1);
  put(s, 23, 10, KIND.RES, 1); // a one-tile gap: not connected
  recompute(s);
  assert.ok(has(s, 21, 10, FLAG.POWERED));
  assert.ok(has(s, 20, 10, FLAG.POWERED), 'roads conduct and show power');
  assert.ok(!has(s, 23, 10, FLAG.POWERED));
  const st = stats(s);
  assert.equal(st.power.supply, 600);
  assert.equal(st.unpowered, 1);
  assert.equal(inspect(s, 21, 10).powered, true);
  assert.equal(inspect(s, 23, 10).powered, false);
});

test('supply sums per network: plant 600, solar 40, batteries only beside generation', () => {
  const s = flat();
  put(s, 5, 5, KIND.SOLAR);
  put(s, 6, 5, KIND.BATTERY);
  put(s, 20, 20, KIND.BATTERY); // alone: stores nothing
  put(s, 21, 20, KIND.RES, 1);
  recompute(s);
  assert.equal(stats(s).power.supply, 100);
  assert.ok(!has(s, 21, 20, FLAG.POWERED));
  putPlant(s, 40, 40);
  recompute(s);
  assert.equal(stats(s).power.supply, 700);
});

test('an overloaded grid browns out at its far edge, in breadth-first order', () => {
  const s = flat();
  put(s, 10, 30, KIND.SOLAR); // 40 supply
  // A line of homes outward from the source: L2 homes draw 5 each.
  for (let x = 11; x <= 25; x++) put(s, x, 30, KIND.RES, 2);
  recompute(s);
  const powered = [];
  for (let x = 11; x <= 25; x++) powered.push(has(s, x, 30, FLAG.POWERED));
  const firstDark = powered.indexOf(false);
  assert.equal(firstDark, 8, '8 homes × 5 = 40 supply');
  assert.ok(powered.slice(0, firstDark).every(Boolean), 'everything nearer is powered');
  assert.ok(powered.slice(firstDark).every((p) => !p), 'everything farther is dark');
  const st = stats(s);
  assert.equal(st.power.demand, 75);
  assert.equal(st.power.served, 40);
  assert.equal(st.unpowered, 7);
});

test('smart buildings draw 40 % less power', () => {
  const s = flat();
  putPlant(s, 10, 10);
  for (let x = 12; x < 22; x++) put(s, x, 10, KIND.IND, 3);
  recompute(s);
  const plain = stats(s).power.demand;
  assert.equal(plain, 240);
  for (let x = 12; x < 22; x++) apply(s, 'smart', x, 10);
  assert.equal(stats(s).power.demand, 144);
  assert.equal(inspect(s, 12, 10).powerDraw, 14.4);
});

/** A dense strip: a road with level-3 homes packed on both sides, powered. */
function denseStrip(s, y = 30, x0 = 5, x1 = 58) {
  for (let x = x0; x <= x1; x++) {
    put(s, x, y, KIND.ROAD);
    for (const dy of [-2, -1, 1, 2]) put(s, x, y + dy, KIND.RES, 3);
  }
  putPlant(s, x0 - 3, y - 1);
  put(s, x0 - 1, y, KIND.ROAD);
  putPlant(s, x1 + 2, y - 1);
  put(s, x1 + 1, y, KIND.ROAD);
  for (let k = 0; k < 4; k++) putPlant(s, x0 + 4 + k * 12, y + 3);
}

test('traffic: trips land on the nearest road, and a skyport halves it within 10 tiles', () => {
  const s = flat();
  denseStrip(s);
  recompute(s);
  const before = s.layers.traffic.slice();
  assert.ok(before[idx(30, 30)] > 80, `a packed street is busy (${before[idx(30, 30)]})`);
  assert.equal(before[idx(30, 31)], 0, 'traffic lives on roads');
  assert.equal(inspect(s, 30, 31).traffic, before[idx(30, 30)], 'a building reports its street');
  // A powered skyport just north of the strip (centre at 30, 27).
  put(s, 29, 26, KIND.SKYPORT, 0, FLAG.ANCHOR);
  put(s, 30, 26, KIND.SKYPORT);
  put(s, 29, 27, KIND.SKYPORT);
  put(s, 30, 27, KIND.SKYPORT);
  recompute(s);
  assert.ok(has(s, 29, 26, FLAG.POWERED), 'the skyport is on the grid');
  const after = s.layers.traffic;
  for (const x of [26, 30, 34]) {
    assert.ok(Math.abs(after[idx(x, 30)] - before[idx(x, 30)] / 2) <= 1, `x=${x}: ${before[idx(x, 30)]} -> ${after[idx(x, 30)]}`);
  }
  assert.equal(after[idx(55, 30)], before[idx(55, 30)], 'roads beyond the radius are unchanged');
  assert.ok(stats(s).skyTrips > 0);
  // Unpowered, it relieves nothing: cut it off by isolating it.
  const t = createState(1);
  t.layers.terrain.fill(TERRAIN.LAND);
  denseStrip(t);
  put(t, 29, 20, KIND.SKYPORT, 0, FLAG.ANCHOR);
  put(t, 30, 20, KIND.SKYPORT);
  put(t, 29, 21, KIND.SKYPORT);
  put(t, 30, 21, KIND.SKYPORT);
  recompute(t);
  assert.ok(!has(t, 29, 20, FLAG.POWERED));
  assert.equal(t.layers.traffic[idx(30, 30)], before[idx(30, 30)]);
});

test('pollution: industry and plants pollute, parks clean, smart industry halves it', () => {
  const s = flat();
  for (let y = 20; y < 26; y++) for (let x = 20; x < 30; x++) put(s, x, y, KIND.IND, 3);
  recompute(s);
  const heart = s.layers.pollution[idx(25, 23)];
  const near = s.layers.pollution[idx(25, 27)];
  const far = s.layers.pollution[idx(25, 40)];
  assert.ok(heart > near && near > far, `${heart} > ${near} > ${far}`);
  assert.equal(far, 0);
  put(s, 25, 27, KIND.PARK);
  recompute(s);
  assert.ok(s.layers.pollution[idx(25, 27)] < near, 'a park cleans its surroundings');
  const t = flat();
  for (let y = 20; y < 26; y++) for (let x = 20; x < 30; x++) put(t, x, y, KIND.IND, 3, FLAG.SMART);
  recompute(t);
  assert.ok(t.layers.pollution[idx(25, 23)] <= Math.ceil(heart / 2) + 1, 'smart industry pollutes half as much');
});

test('land value: water and parks raise it, pollution lowers it', () => {
  const s = flat();
  for (let y = 0; y < H; y++) s.layers.terrain[idx(0, y)] = TERRAIN.WATER;
  recompute(s);
  const L = s.layers;
  assert.ok(L.landValue[idx(1, 30)] > L.landValue[idx(20, 30)], 'waterfront is worth more');
  assert.equal(L.landValue[idx(0, 30)], 0, 'water itself has no land value');
  const plain = L.landValue[idx(40, 30)];
  put(s, 41, 30, KIND.PARK);
  recompute(s);
  assert.ok(L.landValue[idx(40, 30)] > plain, 'next to a park');
  for (let y = 10; y < 16; y++) for (let x = 40; x < 50; x++) put(s, x, y, KIND.IND, 3);
  recompute(s);
  assert.ok(L.landValue[idx(45, 17)] < plain, 'beside heavy industry');
});

// --- demand and growth ---------------------------------------------------------------------

test('demand valves: jobs open R, residents open C and I, tax presses all three', () => {
  const base = demandTargets({ residents: 1000, jobsC: 300, jobsI: 300, tax: 7 });
  const jobsHeavy = demandTargets({ residents: 1000, jobsC: 300, jobsI: 1500, tax: 7 });
  const resHeavy = demandTargets({ residents: 5000, jobsC: 300, jobsI: 300, tax: 7 });
  assert.ok(jobsHeavy.r > base.r && jobsHeavy.r > 0.5);
  assert.ok(resHeavy.c > base.c && resHeavy.i > base.i);
  assert.ok(resHeavy.r < 0, 'too few jobs: settlers stop coming');
  const high = demandTargets({ residents: 1000, jobsC: 300, jobsI: 300, tax: 15 });
  const low = demandTargets({ residents: 1000, jobsC: 300, jobsI: 300, tax: 0 });
  for (const k of ['r', 'c', 'i']) {
    assert.ok(high[k] < base[k] && base[k] < low[k], `tax moves ${k}`);
    assert.ok(Math.abs(base[k] - high[k] - 8 * 0.04) < 1e-9, `${k}: 0.04 per point`);
  }
  for (const t of [jobsHeavy, resHeavy, high, low]) for (const v of Object.values(t)) assert.ok(v >= -1 && v <= 1);
});

/** Unpowered developed blocks of one kind (they cannot grow, so totals stay put for a step). */
function cityOf(counts) {
  const s = flat();
  let y = 2;
  for (const [kind, n] of counts) {
    for (let k = 0; k < n; k++) put(s, 2 + (k % 50), y + Math.floor(k / 50) * 2, kind, 3);
    y += 12;
  }
  recompute(s);
  s.demand = { r: 0, c: 0, i: 0 };
  return s;
}

test('demand moves the right way in a played city', () => {
  const jobs = cityOf([[KIND.IND, 40], [KIND.RES, 4]]);
  step(jobs);
  assert.ok(stats(jobs).demand.r > 0.1, 'a jobs-heavy city opens R');
  const homes = cityOf([[KIND.RES, 40], [KIND.IND, 2]]);
  step(homes);
  const d = stats(homes).demand;
  assert.ok(d.c > 0.1 && d.i > 0.1, 'a residents-heavy city opens C and I');
  assert.ok(d.r < 0, 'and closes R');
  const taxed = cityOf([[KIND.IND, 40], [KIND.RES, 4]]);
  setTax(taxed, 20);
  step(taxed);
  const dt = stats(taxed).demand;
  const dj = stats(jobs).demand;
  assert.ok(dt.r < dj.r && dt.c < dj.c && dt.i < dj.i, 'higher tax lowers all three');
});

/** The tutorial city: a road, a plant, 6 R + 3 I + 2 C beside the road. */
function firstCity(s, { plant = true, road = true } = {}) {
  if (road) apply(s, 'road', 26, 32, 38, 32);
  if (plant) apply(s, 'plant', 24, 31);
  apply(s, 'res', 27, 30, 32, 30);
  apply(s, 'ind', 33, 33, 35, 33);
  apply(s, 'com', 33, 30, 34, 30);
  if (!road) {
    // Without a road the plant must still reach the zones: link them with a park line.
    apply(s, 'park', 26, 31);
    apply(s, 'park', 26, 30);
  }
}

test('growth needs both power and road access', () => {
  const noPower = createState(11);
  firstCity(noPower, { plant: false });
  const noRoad = createState(11);
  firstCity(noRoad, { road: false });
  for (let m = 0; m < 24; m++) {
    step(noPower);
    step(noRoad);
  }
  assert.equal(stats(noPower).developed, 0, 'no power, no growth');
  assert.ok(stats(noRoad).unpoweredLots === 0, 'the road-less lots do have power');
  assert.equal(stats(noRoad).developed, 0, 'no road, no growth');
});

test('tuning: a first city of 6 R + 3 I + 2 C starts growing within a few months', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = createState(seed);
    firstCity(s);
    let month = 0;
    while (month < 4 && stats(s).developed === 0) { step(s); month++; }
    assert.ok(stats(s).developed > 0, `seed ${seed}: nothing grew in ${month} months`);
    for (let m = month; m < 12; m++) step(s);
    const st = stats(s);
    assert.ok(st.residents > 0 && st.jobs > 0, `seed ${seed}: ${st.residents} residents, ${st.jobs} jobs`);
  }
});

test('losing power empties a building over a few months; Smart Code makes new growth smart', () => {
  const s = createState(11);
  firstCity(s);
  for (let m = 0; m < 12; m++) step(s);
  const grown = stats(s).developed;
  assert.ok(grown > 0);
  setPolicy(s, 'smartCode', true);
  for (let m = 0; m < 12; m++) step(s);
  assert.ok(stats(s).smartTiles > 0, 'growth under the Smart Code is smart');
  apply(s, 'bulldoze', 24, 31); // the plant
  for (let m = 0; m < 12; m++) step(s);
  assert.ok(stats(s).developed < grown, 'buildings decay without power');
});

// --- budget ----------------------------------------------------------------------------------

test('budget arithmetic: funds change by income minus upkeep, both from the formula', () => {
  const s = createState(11);
  firstCity(s);
  apply(s, 'park', 30, 34);
  apply(s, 'solar', 40, 34);
  for (let m = 0; m < 18; m++) {
    const before = s.funds;
    step(s);
    const st = stats(s);
    assert.equal(s.funds - before, st.lastIncome - st.lastUpkeep, `month ${m}`);
    // Upkeep: road 1, park 2, plant 50, solar 5 (battery 5, skyport 30).
    assert.equal(st.lastUpkeep, st.roads + st.parks * 2 + st.plants * 50 + st.solar * 5 + st.batteries * 5 + st.skyports * 30);
    // Income grows with residents and (1.5×) jobs, and with the tax rate.
    assert.equal(st.lastIncome, st.income, 'stats projects the same formula');
  }
  const st = stats(s);
  assert.ok(st.residents > 0 && st.lastIncome > 0);
  const r = st.lastIncome / (st.tax * (st.residents + 1.5 * st.jobs));
  setTax(s, 14);
  assert.ok(Math.abs(stats(s).income / (14 * (st.residents + 1.5 * st.jobs)) - r) < 0.01, 'income is linear in tax');
  assert.equal(setTax(s, 99).rate, 20);
  assert.equal(setTax(s, -3).rate, 0);
  assert.equal(setTax(s, 'x').ok, false);
});

// --- Synergy -----------------------------------------------------------------------------------

/** Every build proposal must be valid for the current state, at its stated cost. */
function assertApplicable(s, p) {
  assert.ok(p.id && p.title && Array.isArray(p.reasons) && p.reasons.length > 0, 'shape');
  assert.match(p.gate, /^G[1-6]$/);
  if (p.action.type === 'build') {
    const c = canPlace(s, p.action.tool, p.action.x, p.action.y);
    assert.ok(c.ok, `${p.id}: ${c.reason}`);
  } else if (p.action.type === 'tax') {
    assert.ok(p.action.rate >= 0 && p.action.rate <= 20 && p.action.rate !== s.tax);
  } else {
    assert.deepEqual(p.action, { type: 'policy', name: 'smartCode', value: true });
  }
}

test('Synergy: unpowered buildings get a plant that joins their grid, with true numbers', () => {
  const s = flat();
  for (let x = 10; x <= 30; x++) put(s, x, 20, KIND.ROAD);
  for (let x = 12; x <= 20; x++) put(s, x, 21, KIND.RES, 2);
  recompute(s);
  const st = stats(s);
  const p = advise(s).find((q) => q.kind === 'power');
  assert.ok(p);
  assertApplicable(s, p);
  assert.equal(p.action.tool, 'plant');
  assert.ok(p.reasons.some((r) => r.startsWith(`${st.unpowered} developed tiles have no power`)), p.reasons.join(' | '));
  assert.ok(p.reasons.some((r) => r.includes('no power source')));
  const r = decide(s, p.id, 'accept');
  assert.equal(r.ok, true, r.reason);
  assert.equal(stats(s).unpowered, 0, 'the proposed plant powered them');
  assert.equal(s.log.length, 1);
  assert.equal(s.log[0].decision, 'accept');
  assert.equal(s.log[0].proposal.id, p.id);
});

test('Synergy: a small shortfall gets a solar farm, a big one a plant', () => {
  const s = flat();
  put(s, 10, 30, KIND.SOLAR);
  for (let x = 11; x <= 19; x++) put(s, x, 30, KIND.RES, 2); // 45 draw on 40 supply
  recompute(s);
  const p = advise(s).find((q) => q.kind === 'power');
  assert.equal(p.action.tool, 'solar');
  assert.ok(p.reasons.includes('Their grid supplies 40 but needs 45'), p.reasons.join(' | '));
  assertApplicable(s, p);
  decide(s, p.id, 'accept');
  assert.equal(stats(s).unpowered, 0);
});

test('Synergy: congestion gets a skyport near the worst road', () => {
  const s = flat();
  denseStrip(s);
  recompute(s);
  const st = stats(s);
  assert.ok(st.trafficMax >= 80);
  const p = advise(s).find((q) => q.kind === 'congestion');
  assert.ok(p, 'a skyport proposal');
  assertApplicable(s, p);
  assert.ok(p.reasons[0].includes(`peaks at ${st.trafficMax} of 255`), p.reasons[0]);
  const before = st.trafficMax;
  assert.equal(decide(s, p.id, 'accept').ok, true);
  assert.ok(stats(s).trafficMax < before, 'traffic fell');
});

test('Synergy: polluted homes get a park; deficits a tax rise; slumps a tax cut; strain the Smart Code', () => {
  const s = flat();
  for (let y = 20; y < 26; y++) for (let x = 20; x < 30; x++) put(s, x, y, KIND.IND, 3);
  for (let x = 20; x < 30; x++) put(s, x, 26, KIND.RES, 1);
  recompute(s);
  const park = advise(s).find((q) => q.kind === 'park');
  assert.ok(park);
  assertApplicable(s, park);
  const worst = Math.max(...[...Array(10).keys()].map((k) => s.layers.pollution[idx(20 + k, 26)]));
  assert.ok(park.reasons.some((r) => r.startsWith(`Worst: ${worst} at`)), park.reasons.join(' | '));

  const d = flat();
  d.deficitMonths = 3;
  d.lastIncome = 10;
  d.lastUpkeep = 90;
  const up = advise(d).find((q) => q.kind === 'taxUp');
  assert.deepEqual(up.action, { type: 'tax', rate: 8 });
  assert.ok(up.reasons[0].includes('3 months'));
  assert.ok(up.reasons[1].includes('10 cr in, 90 cr out'));
  decide(d, up.id, 'accept');
  assert.equal(d.tax, 8);
  assert.equal(advise(d).find((q) => q.kind === 'taxUp'), undefined, 'the counter restarts');

  const slump = flat();
  slump.demand = { r: -0.5, c: -0.4, i: -0.6 };
  const down = advise(slump).find((q) => q.kind === 'taxDown');
  assert.deepEqual(down.action, { type: 'tax', rate: 6 });
  assert.ok(down.reasons[0].includes('R −0.50, C −0.40, I −0.60'), down.reasons[0]);

  const strain = flat();
  putPlant(strain, 10, 10);
  for (let x = 12; x < 34; x++) put(strain, x, 10, KIND.IND, 3); // 22 × 24 = 528 of 600
  recompute(strain);
  const sc = advise(strain).find((q) => q.kind === 'smartCode');
  assertApplicable(strain, sc);
  assert.ok(sc.reasons[0].startsWith('Power draw is 528 of 600 supply (88 %)'), sc.reasons[0]);
  decide(strain, 'smartCode', 'accept');
  assert.equal(strain.smartCode, true);
});

test('Synergy: at most three proposals, every one applicable, across many played cities', () => {
  for (const seed of [1, 2, 3, 7, 9]) {
    const s = play(seed);
    for (let m = 0; m < 24; m++) {
      const props = advise(s);
      assert.ok(props.length <= 3);
      assert.equal(new Set(props.map((p) => p.id)).size, props.length, 'ids are unique');
      for (const p of props) assertApplicable(s, p);
      step(s);
    }
  }
});

test('Synergy: declining dismisses a kind for 12 months, and every decision is logged', () => {
  const s = flat();
  for (let x = 10; x <= 30; x++) put(s, x, 20, KIND.ROAD);
  for (let x = 12; x <= 20; x++) put(s, x, 21, KIND.RES, 1);
  recompute(s);
  const p = advise(s).find((q) => q.kind === 'power');
  assert.deepEqual(decide(s, p.id, 'decline'), { ok: true, reason: '' });
  assert.deepEqual(s.log.at(-1), { tick: 0, proposal: p, decision: 'decline' });
  for (let m = 0; m < 12; m++) {
    assert.equal(advise(s).find((q) => q.kind === 'power'), undefined, `month ${m}`);
    s.tick++; // hold the city still: only the clock moves
  }
  assert.ok(advise(s).find((q) => q.kind === 'power'), 'back after 12 months');
  assert.equal(decide(s, 'nope', 'accept').ok, false);
  assert.equal(decide(s, p.id, 'maybe').ok, false);
  assert.equal(s.log.length, 1, 'invalid decisions are not logged');
  const q = advise(s).find((x) => x.kind === 'power');
  s.funds = 0;
  const r = decide(s, q.id, 'accept');
  assert.equal(r.ok, false, 'the proposal went stale: no money now');
});

test('Synergy: an accepted proposal costs what a tool would', () => {
  const s = flat(1, 5000);
  for (let x = 10; x <= 30; x++) put(s, x, 20, KIND.ROAD);
  for (let x = 12; x <= 20; x++) put(s, x, 21, KIND.RES, 2);
  recompute(s);
  const p = advise(s).find((q) => q.kind === 'power');
  const r = decide(s, p.id, 'accept');
  assert.equal(r.cost, 3000);
  assert.equal(s.funds, 2000);
  assert.equal(s.log.at(-1).ok, true);
});

// --- save and load --------------------------------------------------------------------------

test('serialize → deserialize round-trips exactly and resumes the same future', () => {
  const a = play(77);
  const saved = serialize(a);
  const text = JSON.stringify(saved);
  assert.ok(text.length < 40000, `save is ${text.length} bytes`);
  const b = deserialize(JSON.parse(text));
  const c = deserialize(text);
  sameLayers(a, b);
  sameLayers(a, c);
  assert.deepEqual(stats(b), stats(a));
  assert.deepEqual(advise(b), advise(a));
  assert.deepEqual(b.log, a.log);
  for (let m = 0; m < 24; m++) {
    step(a);
    step(b);
    apply(a, 'res', 40, 40, 44, 41);
    apply(b, 'res', 40, 40, 44, 41);
  }
  sameLayers(a, b);
  assert.deepEqual(stats(b), stats(a));
  assert.equal(b.rng, a.rng);
});

test('deserialize rejects damaged or foreign data', () => {
  const good = serialize(createState(5));
  assert.throws(() => deserialize({ format: 'other' }));
  assert.throws(() => deserialize({ ...good, version: 2 }));
  assert.throws(() => deserialize({ ...good, layers: { ...good.layers, kind: 'AAAA' } }));
  const bad = { ...good, layers: { ...good.layers } };
  bad.layers.kind = bad.layers.kind.replace(/^AAAA/, '////'); // kind 255
  assert.throws(() => deserialize(bad));
  assert.throws(() => deserialize({ ...good, tax: 50 }));
  assert.throws(() => deserialize('{not json'));
});

// --- inspect --------------------------------------------------------------------------------

test('inspect reports a tile in plain terms', () => {
  const s = createState(11);
  firstCity(s);
  const info = inspect(s, 27, 30);
  for (const k of ['kind', 'level', 'powered', 'roadAccess', 'smart', 'landValue', 'pollution', 'traffic', 'label']) assert.ok(k in info, k);
  assert.equal(info.kind, KIND.RES);
  assert.equal(info.kindName, 'res');
  assert.equal(info.powered, true);
  assert.equal(info.roadAccess, true);
  assert.equal(info.label, 'Residential lot');
  assert.deepEqual(inspect(s, 25, 32).anchor, { x: 24, y: 31 });
  assert.equal(inspect(s, 99, 0), null);
});

test('every tool is described: id, label, cost and size', () => {
  for (const [id, t] of Object.entries(TOOLS)) {
    assert.equal(t.id, id);
    assert.ok(t.label && typeof t.cost === 'number' && (t.size === 1 || t.size === 2) && t.desc, id);
  }
  assert.equal(TOOLS.road.paint, 'line');
  for (const z of ['res', 'com', 'ind']) assert.equal(TOOLS[z].paint, 'rect');
  assert.ok(Object.isFrozen(TOOLS) && Object.isFrozen(TOOLS.road));
});

// --- performance and the long run -----------------------------------------------------------

/** Every buildable tile used: roads every 5 rows and 16 columns, level-3 zones, smart, many plants. */
function developedCity() {
  const s = flat();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y % 5 === 0 || x % 16 === 0) { put(s, x, y, KIND.ROAD); continue; }
      const k = x < 24 ? KIND.RES : x < 40 ? KIND.COM : (x + y) % 3 ? KIND.IND : KIND.RES;
      put(s, x, y, k, 3, FLAG.SMART);
    }
  }
  for (let y = 1; y < H - 1; y += 5) for (let x = 1; x < W - 1; x += 16) putPlant(s, x, y);
  for (let y = 1; y < H - 1; y += 10) for (let x = 7; x < W - 1; x += 16) putPlant(s, x, y + 2);
  for (const [x, y] of [[10, 11], [30, 31], [50, 41]]) {
    put(s, x, y, KIND.SKYPORT, 0, FLAG.ANCHOR);
    put(s, x + 1, y, KIND.SKYPORT);
    put(s, x, y + 1, KIND.SKYPORT);
    put(s, x + 1, y + 1, KIND.SKYPORT);
  }
  for (let y = 3; y < H; y += 10) for (let x = 5; x < W; x += 8) if (s.layers.kind[idx(x, y)] !== KIND.ROAD) put(s, x, y, KIND.PARK);
  recompute(s);
  return s;
}

test('step time budget: a fully developed 64 × 64 city steps in under 8 ms on average', () => {
  const s = developedCity();
  const st = stats(s);
  assert.ok(st.developed > 2500, `${st.developed} developed tiles`);
  for (let k = 0; k < 5; k++) step(s); // warm up the JIT
  const runs = 40;
  let stepMs = 0;
  let adviseMs = 0;
  for (let k = 0; k < runs; k++) {
    let t = performance.now();
    step(s);
    stepMs += performance.now() - t;
    t = performance.now();
    advise(s);
    adviseMs += performance.now() - t;
  }
  const avg = stepMs / runs;
  const adv = adviseMs / runs;
  console.log(`# step ${avg.toFixed(3)} ms, advise ${adv.toFixed(3)} ms (average of ${runs}, ${stats(s).developed} developed tiles)`);
  assert.ok(avg < 8, `step averaged ${avg.toFixed(2)} ms`);
  assert.ok(avg + adv < 8, `step + advise averaged ${(avg + adv).toFixed(2)} ms`);
});

/**
 * A well-run city, played by rules a careful new player might follow: zone
 * blocks on a road grid as demand asks, keep power ahead of need, add parks,
 * accept Synergy's build proposals.
 */
function wellRun(seed, months) {
  const s = createState(seed);
  const blocks = [];
  for (let by = 12; by < 52; by += 5) for (let bx = 10; bx < 54; bx += 9) blocks.push({ x: bx + 1, y: by + 1, d: Math.hypot(bx + 5 - 32, by + 3 - 32) });
  blocks.sort((a, b) => a.d - b.d);
  const typeOf = (b) => (b.x > 37 && b.y > 30 ? 'ind' : Math.abs(b.x + 4 - 32) < 8 && Math.abs(b.y + 2 - 32) < 5 ? 'com' : 'res');
  const used = new Set();
  const zone = (tool) => {
    const b = blocks.find((q) => !used.has(q) && typeOf(q) === tool) || blocks.find((q) => !used.has(q) && typeOf(q) === 'res');
    if (!b) return;
    used.add(b);
    apply(s, 'road', b.x - 1, b.y - 1, b.x + 8, b.y - 1);
    apply(s, 'road', b.x - 1, b.y + 4, b.x + 8, b.y + 4);
    apply(s, 'road', b.x - 1, b.y - 1, b.x - 1, b.y + 4);
    apply(s, 'road', b.x + 8, b.y - 1, b.x + 8, b.y + 4);
    if (tool === 'res') { apply(s, 'park', b.x + 3, b.y + 1); apply(s, 'park', b.x + 4, b.y + 2); }
    apply(s, tool, b.x, b.y, b.x + 7, b.y + 3);
  };
  const lots = (k) => {
    let n = 0;
    for (let i = 0; i < N; i++) if (s.layers.kind[i] === k && s.layers.level[i] === 0 && (s.layers.flags[i] & 3) === 3 && s.layers.pollution[i] < 40) n++;
    return n;
  };
  zone('res');
  zone('ind');
  zone('com');
  const trail = [];
  for (let m = 0; m < months; m++) {
    const st = stats(s);
    if (st.funds > 800) {
      if (st.demand.r > 0.15 && lots(KIND.RES) < 16) zone('res');
      if (st.demand.i > 0.15 && lots(KIND.IND) < 10) zone('ind');
      if (st.demand.c > 0.15 && lots(KIND.COM) < 10) zone('com');
    }
    for (const p of advise(s)) if (p.kind !== 'taxDown') decide(s, p.id, 'accept');
    step(s);
    if (s.tick % 12 === 0) trail.push(stats(s));
  }
  return { s, trail };
}

test('tuning: a well-run city passes 3 000 residents within 10 years', () => {
  for (const seed of [7, 21, 1001]) {
    const { trail } = wellRun(seed, 120);
    const year = trail.findIndex((st) => st.residents >= 3000) + 1;
    assert.ok(year >= 1 && year <= 10, `seed ${seed}: ${trail.map((st) => st.residents).join(', ')}`);
    const last = trail.at(-1);
    assert.ok(last.funds > 0, `seed ${seed} stayed solvent`);
    assert.equal(last.unpowered, 0, `seed ${seed} kept its power up`);
  }
});

// --- protocol -----------------------------------------------------------------------------------

/** A protocol with a hand-cranked clock. */
function harness() {
  const out = [];
  const timers = [];
  const p = createProtocol((msg, transfer) => out.push({ msg, transfer }), {
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
  });
  const fire = () => {
    const t = timers.filter((x) => x.fn).at(-1);
    const fn = t.fn;
    t.fn = null;
    fn();
  };
  const last = (type) => out.filter((o) => o.msg.type === type).at(-1)?.msg;
  return { p, out, timers, fire, last };
}

test('protocol: init posts a state with fresh layer copies and transfer lists', () => {
  const { p, out, last } = harness();
  p.handle({ type: 'tax', rate: 3 });
  assert.equal(last('error').reason, 'Send init first');
  p.handle({ type: 'init', seed: 42 });
  const { msg, transfer } = out.at(-1);
  assert.equal(msg.type, 'state');
  assert.deepEqual(Object.keys(msg.layers).sort(), [...LAYER_NAMES].sort());
  for (const name of LAYER_NAMES) {
    assert.ok(msg.layers[name] instanceof Uint8Array && msg.layers[name].length === N, name);
    assert.ok(transfer.includes(msg.layers[name].buffer), `${name} is transferable`);
  }
  assert.equal(transfer.length, LAYER_NAMES.length);
  assert.equal(msg.stats.tick, 0);
  assert.equal(msg.stats.speed, 0);
  assert.ok(Array.isArray(msg.advice) && Array.isArray(msg.events) && Array.isArray(msg.log));
  const first = msg.layers.kind;
  p.handle({ type: 'tool', tool: 'road', x: 30, y: 30, x2: 35, y2: 30 });
  assert.deepEqual(last('toolResult'), { type: 'toolResult', ok: true, cost: 60, reason: '', placed: 6, tool: 'road' });
  const next = last('state').layers.kind;
  assert.notEqual(next, first, 'a fresh copy every time');
  assert.equal(first[idx(30, 30)], KIND.EMPTY, 'old copies are not mutated');
  assert.equal(next[idx(30, 30)], KIND.ROAD);
});

test('protocol: the speed timer steps at 2.4 s, 1.2 s and 0.5 s, and pauses', () => {
  const { p, timers, fire, last } = harness();
  assert.deepEqual([...SPEED_DELAYS], [0, 2400, 1200, 500]);
  p.handle({ type: 'init', seed: 1 });
  assert.equal(timers.length, 0, 'paused by default');
  for (const [speed, ms] of [[1, 2400], [2, 1200], [3, 500]]) {
    p.handle({ type: 'speed', speed });
    assert.equal(timers.filter((t) => t.fn).at(-1).ms, ms);
    assert.equal(timers.filter((t) => t.fn).length, 1, 'one pending timer, never a pile');
  }
  fire();
  assert.equal(last('state').stats.tick, 1);
  assert.equal(last('state').stats.speed, 3);
  fire();
  assert.equal(last('state').stats.tick, 2, 'the chain re-arms itself');
  p.handle({ type: 'speed', speed: 0 });
  assert.equal(timers.filter((t) => t.fn).length, 0);
  p.dispose();
});

test('protocol: tools, decisions, inspect, save and restore', () => {
  const { p, last } = harness();
  p.handle({ type: 'init', seed: 11 });
  p.handle({ type: 'tool', tool: 'res', x: 30, y: 30, x2: 33, y2: 31 });
  assert.equal(last('toolResult').placed, 8);
  p.handle({ type: 'tool', tool: 'plant', x: 63, y: 63 });
  assert.equal(last('toolResult').ok, false);
  p.handle({ type: 'inspect', x: 30, y: 30 });
  assert.equal(last('inspect').info.kindName, 'res');
  p.handle({ type: 'tool', tool: 'inspect', x: 30, y: 31 });
  assert.equal(last('inspect').info.y, 31);
  const advice = last('state').advice;
  const power = advice.find((a) => a.kind === 'power');
  assert.ok(power, 'eight unpowered lots draw a proposal');
  p.handle({ type: 'decide', id: power.id, decision: 'accept' });
  assert.equal(last('decided').ok, true);
  assert.equal(last('state').log.at(-1).decision, 'accept');
  p.handle({ type: 'policy', name: 'smartCode', value: true });
  assert.equal(last('state').stats.smartCode, true);
  p.handle({ type: 'tax', rate: 11 });
  assert.equal(last('state').stats.tax, 11);
  p.handle({ type: 'step', count: 6 });
  const st = last('state').stats;
  assert.equal(st.tick, 6);
  p.handle({ type: 'save' });
  const data = last('saved').data;
  JSON.stringify(data); // JSON-safe

  const other = harness();
  other.p.handle({ type: 'init', seed: 999, save: data });
  const restored = other.last('state');
  assert.deepEqual(restored.stats, st);
  assert.deepEqual(restored.layers.kind, last('state').layers.kind);
  assert.equal(restored.events[0].type, 'loaded');

  const broken = harness();
  broken.p.handle({ type: 'init', seed: 5, save: { format: 'nope' } });
  assert.equal(broken.last('state').events[0].type, 'loadFailed');
  assert.equal(broken.last('state').stats.tick, 0, 'a bad save starts a fresh city instead');

  p.handle({ type: 'new', seed: 3 });
  assert.equal(last('state').stats.tick, 0);
  p.handle({ type: 'warp' });
  assert.match(last('error').reason, /Unknown message/);
  p.handle({ type: 'tool', tool: 'res', x: 'a', y: null });
  assert.equal(last('toolResult').ok, false, 'bad input is answered, not thrown');
});
