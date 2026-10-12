// Nova Run level checks.
//
//   node --test web/js/game/levels.test.mjs
//
// Every level is checked against the rule book (entity counts per sector must
// match sector.spawn exactly, because scoring.js caps each counter at what the
// sector spawns) and against the physics contract, with a conservative
// reachability search. A level that looks fine but cannot be finished, hides
// a scoring item nobody can reach, or can trap Nova somewhere with no way on,
// fails here instead of in somebody's evening.
//
// No dependencies: node:test, node:assert and the level modules themselves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEVELS } from './levels/index.js';

const rulebook = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../data/rulebook.json', import.meta.url)), 'utf8'),
);

// The world for each gate, in rulebook.sectors order (docs/ARCHITECTURE.md, "Look").
const WORLDS = ['crystal', 'rigs', 'biodome', 'datacity', 'engineering', 'station'];

const TERRAIN = '.#=~%S><Umv';
const ENTITIES = 'PGCohicdbtrgx';
const SOLID = '#S><';
// Things that stand on the floor rather than float.
const GROUNDED = 'PGCcdbtgx';
const SPAWN_CHAR = {
  cores: 'o', humanPods: 'h', siPods: 'i', stranded: 'c', discord: 'd',
  anomalies: 'b', satellites: 't', shortcuts: 'r',
};

// ---------------------------------------------------------------------------
// Physics contract (tiles and seconds). The engine keeps the same numbers as
// named constants in physics.js; these are the promises the levels are
// designed to.
export const CONTRACT = {
  gravity: 60,
  runSpeed: 11,
  accelTime: 0.35,
  jumpApex: 4,
  hopApex: 1.5,
  glideFall: 3,
  glideGap: 9,
  springApex: 9,
  updraftLift: 6,
};

// The search credits Nova with 10% less than the contract promises (lower
// jumps, slower runs, heavier gravity, faster glide fall), because the engine
// only has to land within ~10% of it. A level that passes here stays
// finishable anywhere inside that tolerance.
const WEAK = 0.9;
const SIM = {
  dt: 1 / 60,
  gravity: CONTRACT.gravity / WEAK,
  vmax: CONTRACT.runSpeed * WEAK,
  accel: (CONTRACT.runSpeed * WEAK) / (CONTRACT.accelTime / WEAK),
  // Variable jump height: a short hop, a half jump and a full jump.
  apexes: [CONTRACT.hopApex, (CONTRACT.hopApex + CONTRACT.jumpApex * WEAK) / 2, CONTRACT.jumpApex * WEAK],
  glideFall: CONTRACT.glideFall / WEAK,
  // No single airborne leg is credited with more than the contract's glide
  // gap, however high the launch: springs and long falls included.
  maxAirTravel: CONTRACT.glideGap,
  springApex: CONTRACT.springApex * WEAK,
  updraftLift: CONTRACT.updraftLift * WEAK,
  // Nova's body box, a little generous so tight squeezes fail here first.
  w: 0.8,
  h: 1.8,
  // Held run speed as a fraction of the top speed, for in-air steering.
  fracs: [1 / 3, 2 / 3, 1],
  maxTime: 4,
};
SIM.airAccel = SIM.accel * 0.75;

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Map model

function count(rows, ch) {
  let n = 0;
  for (const r of rows) for (const c of r) if (c === ch) n++;
  return n;
}

function findAll(rows, ch) {
  const out = [];
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) if (r[x] === ch) out.push({ x, y });
  });
  return out;
}

/**
 * A queryable view of one level. With secrets: false, false walls count as
 * solid (the route to the gate must never need one). With avoidRed: true,
 * red shortcut cores are treated as walls (every one must be avoidable).
 */
export function makeMap(level, { secrets = true, avoidRed = false } = {}) {
  const rows = level.rows;
  const H = rows.length;
  const W = rows[0].length;
  // Out of bounds: left, right and top are solid, the bottom is a pit.
  const ch = (x, y) => (y >= H ? '.' : x < 0 || x >= W || y < 0 ? '#' : rows[y][x]);
  const solid = (x, y) => {
    const c = ch(x, y);
    return SOLID.includes(c) || (!secrets && c === '%');
  };

  // Moving platforms sweep their whole span; the search treats every swept
  // cell as a one-way floor and lets Nova ride between any two of them.
  const swept = new Set();
  const rides = [];
  const platforms = [];
  for (const { x, y } of findAll(rows, 'm')) {
    let a = x;
    let b = x;
    for (let k = 1; k <= 8 && ch(x - k, y) === '.'; k++) a = x - k;
    for (let k = 1; k <= 8 && ch(x + k, y) === '.'; k++) b = x + k;
    const cells = [];
    for (let c = a; c <= b; c++) {
      swept.add(y * W + c);
      cells.push({ x: c, y: y - 1 });
    }
    rides.push(cells);
    platforms.push({ kind: 'm', x, y, a, b, endA: ch(a - 1, y), endB: ch(b + 1, y), reachA: x - a, reachB: b - x });
  }
  for (const { x, y } of findAll(rows, 'v')) {
    const clear = (yy) => yy >= 0 && yy < H && ch(x, yy) === '.' && !SOLID.includes(ch(x - 1, yy)) && !SOLID.includes(ch(x + 1, yy));
    let a = y;
    let b = y;
    for (let k = 1; k <= 6 && clear(y - k); k++) a = y - k;
    for (let k = 1; k <= 6 && clear(y + k); k++) b = y + k;
    const cells = [];
    for (let r = a; r <= b; r++) {
      for (let c = x - 1; c <= x + 1; c++) {
        swept.add(r * W + c);
        cells.push({ x: c, y: r - 1 });
      }
    }
    rides.push(cells);
    platforms.push({ kind: 'v', x, y, a, b, endA: ch(x, a - 1), endB: ch(x, b + 1), reachA: y - a, reachB: b - y });
  }

  const oneWay = (x, y) => {
    const c = ch(x, y);
    return c === '=' || c === '~' || (y >= 0 && y < H && x >= 0 && x < W && swept.has(y * W + x));
  };
  const floor = (x, y) => solid(x, y) || oneWay(x, y);
  const hazard = (x, y) => {
    const c = ch(x, y);
    return c === 'x' || (avoidRed && c === 'r');
  };
  const passable = (x, y) => !solid(x, y) && !hazard(x, y);
  const standable = (x, y) =>
    x >= 0 && x < W && y >= 1 && y < H - 1 && passable(x, y) && passable(x, y - 1) && floor(x, y + 1);

  // Updraft groups: 4-connected runs of 'U'.
  const groupOf = new Int32Array(W * H).fill(-1);
  const groups = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (rows[y][x] !== 'U' || groupOf[y * W + x] >= 0) continue;
      const g = { cells: [], cols: new Set(), lowest: y, top: y };
      const stack = [[x, y]];
      groupOf[y * W + x] = groups.length;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        g.cells.push([cx, cy]);
        g.cols.add(cx);
        g.lowest = Math.max(g.lowest, cy);
        g.top = Math.min(g.top, cy);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H && rows[ny][nx] === 'U' && groupOf[ny * W + nx] < 0) {
            groupOf[ny * W + nx] = groups.length;
            stack.push([nx, ny]);
          }
        }
      }
      groups.push(g);
    }
  }

  const map = { rows, W, H, ch, solid, oneWay, floor, hazard, passable, standable, rides, platforms, groups, groupOf };

  // Body box helpers: (px, py) is the centre of Nova's feet.
  map.blocked = (px, py) => {
    const x0 = Math.floor(px - SIM.w / 2);
    const x1 = Math.floor(px + SIM.w / 2 - EPS);
    const y0 = Math.floor(py - SIM.h);
    const y1 = Math.floor(py - EPS);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (solid(x, y)) return true;
    return false;
  };
  map.cellsAt = (px, py, out) => {
    const x0 = Math.floor(px - SIM.w / 2);
    const x1 = Math.floor(px + SIM.w / 2 - EPS);
    const y0 = Math.floor(py - SIM.h);
    const y1 = Math.floor(py - EPS);
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) out.push(y * W + x);
    }
    return out;
  };
  map.hurts = (px, py) => {
    const x0 = Math.floor(px - SIM.w / 2);
    const x1 = Math.floor(px + SIM.w / 2 - EPS);
    const y0 = Math.floor(py - SIM.h);
    const y1 = Math.floor(py - EPS);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (hazard(x, y)) return true;
    return false;
  };
  map.updraftAt = (px, py) => {
    const x0 = Math.floor(px - SIM.w / 2);
    const x1 = Math.floor(px + SIM.w / 2 - EPS);
    const y0 = Math.floor(py - SIM.h);
    const y1 = Math.floor(py - EPS);
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
        const g = groupOf[y * W + x];
        if (g >= 0) return g;
      }
    }
    return -1;
  };
  // First floor top the feet cross between py and ny, as [column, row].
  map.landing = (px, py, ny) => {
    const x0 = Math.floor(px - SIM.w / 2);
    const x1 = Math.floor(px + SIM.w / 2 - EPS);
    for (let r = Math.ceil(py - EPS); r <= Math.floor(ny); r++) {
      let best = -1;
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || x >= W) continue;
        if (floor(x, r) && (best < 0 || Math.abs(x + 0.5 - px) < Math.abs(best + 0.5 - px))) best = x;
      }
      if (best >= 0) return [best, r];
    }
    return null;
  };

  // Hover positions inside each updraft, from its lowest tile up to the lift cap.
  map.hovers = [];
  groups.forEach((g, gi) => {
    g.hoverIds = [];
    const bottom = g.lowest + 1;
    const highest = Math.max(g.top + 0.05, bottom - SIM.updraftLift);
    // Half-tile steps from the bottom, plus the lift cap itself.
    const heights = [];
    for (let feet = bottom; feet > highest + EPS; feet -= 0.5) heights.push(feet);
    heights.push(highest);
    for (const x of g.cols) {
      for (const feet of heights) {
        const px = x + 0.5;
        if (map.blocked(px, feet)) continue;
        g.hoverIds.push(W * H + map.hovers.length);
        map.hovers.push({ group: gi, px, py: feet });
      }
    }
  });
  return map;
}

// One airborne leg: integrate the body under the (weakened) contract until it
// lands, enters an updraft while gliding, falls out of the map or touches a
// hazard. Returns null for the last two.
function fly(map, s) {
  let { px, py, vx, vy } = s;
  let speed = s.speed;
  const x0 = px;
  const touched = [];
  const { dt } = SIM;
  for (let t = 0; t < SIM.maxTime; t += dt) {
    const target = s.dir * speed;
    if (vx < target) vx = Math.min(target, vx + SIM.airAccel * dt);
    else if (vx > target) vx = Math.max(target, vx - SIM.airAccel * dt);
    let nx = px + vx * dt;
    if (Math.abs(nx - x0) > SIM.maxAirTravel) {
      nx = x0 + Math.sign(nx - x0) * SIM.maxAirTravel;
      vx = 0;
      speed = 0;
    }
    if (nx !== px && map.blocked(nx, py)) {
      nx = nx > px
        ? Math.floor(nx + SIM.w / 2 - EPS) - SIM.w / 2 - 1e-4
        : Math.floor(nx - SIM.w / 2) + 1 + SIM.w / 2 + 1e-4;
      if (map.blocked(nx, py)) nx = px;
      vx = 0;
    }
    vy += SIM.gravity * dt;
    if (s.glide && vy > SIM.glideFall) vy = SIM.glideFall;
    if (vy > 30) vy = 30;
    let ny = py + vy * dt;
    if (vy < 0) {
      if (map.blocked(nx, ny)) {
        ny = Math.floor(ny - SIM.h) + 1 + SIM.h + 1e-4;
        if (map.blocked(nx, ny)) ny = py;
        vy = 0;
      }
    } else {
      const hit = map.landing(nx, py, ny);
      if (hit) {
        map.cellsAt(nx, hit[1], touched);
        if (map.hurts(nx, hit[1])) return null;
        return { kind: 'land', x: hit[0], y: hit[1] - 1, touched };
      }
    }
    px = nx;
    py = ny;
    if (map.hurts(px, py)) return null;
    map.cellsAt(px, py, touched);
    if (s.glide && vy >= 0) {
      const g = map.updraftAt(px, py);
      if (g >= 0 && g !== s.ignoreGroup) return { kind: 'updraft', group: g, touched };
    }
    if (py - SIM.h > map.H + 1) return null;
  }
  return null;
}

function runup(map, x, y, dir) {
  let k = 0;
  while (k < 3 && map.standable(x - dir * (k + 1), y)) k++;
  return Math.min(SIM.vmax, Math.sqrt(2 * SIM.accel * k));
}

/**
 * Breadth-first search over everywhere Nova can stand (plus hover positions
 * in updrafts), with edges found by flying the weakened contract: walks,
 * walk-offs, three jump heights in every direction at three held speeds,
 * with and without glide, spring launches, one-way drops and platform rides.
 */
export function explore(level, opts = {}) {
  const map = makeMap(level, opts);
  const { W, H } = map;
  const total = W * H + map.hovers.length;
  const seen = new Uint8Array(total);
  const touched = new Uint8Array(W * H);
  const edges = new Map();
  const nodeTouches = new Map(); // node -> cells touched by its own moves (for chain checks)
  const rideOf = new Map();
  for (const cells of map.rides) {
    const ids = cells.filter((c) => map.standable(c.x, c.y)).map((c) => c.y * W + c.x);
    for (const id of ids) rideOf.set(id, ids);
  }

  const startPos = findAll(map.rows, 'P')[0];
  const start = startPos.y * W + startPos.x;
  const queue = [start];
  seen[start] = 1;

  const expand = (id) => {
    const out = new Set();
    const mine = [];
    const add = (res) => {
      if (!res) return;
      for (const c of res.touched) mine.push(c);
      if (res.kind === 'land') out.add(res.y * W + res.x);
      else for (const h of map.groups[res.group].hoverIds) out.add(h);
    };
    const launch = (px, py, vy, dirs, glides, ignoreGroup, rx, ry) => {
      for (const dir of dirs) {
        for (const frac of dir ? SIM.fracs : [0]) {
          const speed = frac * SIM.vmax;
          const vx = rx === undefined ? 0 : dir * Math.min(speed, runup(map, rx, ry, dir));
          for (const glide of glides) add(fly(map, { px, py, vx, vy, dir, speed, glide, ignoreGroup }));
        }
      }
    };

    if (id >= W * H) {
      const hv = map.hovers[id - W * H];
      map.cellsAt(hv.px, hv.py, mine);
      // Holding glide rides the updraft up to its cap; letting go sinks.
      for (const h of map.groups[hv.group].hoverIds) if (h !== id) out.add(h);
      launch(hv.px, hv.py, 0, [-1, 1], [true, false], hv.group);
      launch(hv.px, hv.py, 0, [0], [false], hv.group);
      return { out, mine };
    }

    const x = id % W;
    const y = (id - x) / W;
    map.cellsAt(x + 0.5, y + 1, mine);
    const under = map.ch(x, y + 1);

    if (under === 'S') {
      launch(x + 0.5, y + 1, -Math.sqrt(2 * SIM.gravity * SIM.springApex), [-1, 0, 1], [false, true], -1, x, y);
      return { out, mine };
    }
    // Boosters only ever send Nova one way.
    const dirs = under === '>' ? [1] : under === '<' ? [-1] : [-1, 1];
    for (const dir of dirs) {
      const nx = x + dir;
      if (!map.passable(nx, y) || !map.passable(nx, y - 1)) continue;
      if (map.standable(nx, y)) {
        out.add(y * W + nx);
        continue;
      }
      const run = Math.max(runup(map, x, y, dir), SIM.vmax / 3);
      for (const speed of [0, run]) {
        for (const glide of [false, true]) {
          add(fly(map, { px: nx + 0.5, py: y + 1, vx: dir * speed, vy: 0, dir: speed ? dir : 0, speed, glide, ignoreGroup: -1 }));
        }
      }
    }
    for (const apex of SIM.apexes) {
      launch(x + 0.5, y + 1, -Math.sqrt(2 * SIM.gravity * apex), under === '>' || under === '<' ? dirs : [-1, 0, 1], [false, true], -1, x, y);
    }
    if (under === '=') {
      for (const glide of [false, true]) add(fly(map, { px: x + 0.5, py: y + 1.05, vx: 0, vy: 0, dir: 0, speed: 0, glide, ignoreGroup: -1 }));
    }
    for (const r of rideOf.get(id) || []) if (r !== id) out.add(r);
    return { out, mine };
  };

  while (queue.length) {
    const id = queue.shift();
    const { out, mine } = expand(id);
    edges.set(id, out);
    nodeTouches.set(id, mine);
    for (const c of mine) touched[c] = 1;
    for (const t of out) {
      if (!seen[t]) {
        seen[t] = 1;
        queue.push(t);
      }
    }
  }
  return { map, seen, edges, touched, nodeTouches, start };
}

/** Nodes from which the gate can still be reached (reverse search from the gate). */
function canFinish(result, gateCell) {
  const rev = new Map();
  for (const [from, outs] of result.edges) {
    for (const to of outs) {
      if (!rev.has(to)) rev.set(to, []);
      rev.get(to).push(from);
    }
  }
  const ok = new Set();
  const queue = [];
  for (const [id, cells] of result.nodeTouches) {
    if (cells.includes(gateCell)) {
      ok.add(id);
      queue.push(id);
    }
  }
  while (queue.length) {
    const id = queue.shift();
    for (const p of rev.get(id) || []) {
      if (!ok.has(p)) {
        ok.add(p);
        queue.push(p);
      }
    }
  }
  return ok;
}

/** Tarjan's strongly connected components over the explored graph. */
function components(edges) {
  const index = new Map();
  const low = new Map();
  const comp = new Map();
  const stack = [];
  const onStack = new Set();
  let next = 0;
  let count = 0;
  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    const work = [[root, [...(edges.get(root) || [])], 0]];
    index.set(root, next);
    low.set(root, next);
    next++;
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, outs] = frame;
      if (frame[2] < outs.length) {
        const w = outs[frame[2]++];
        if (!edges.has(w)) continue;
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next);
          next++;
          stack.push(w);
          onStack.add(w);
          work.push([w, [...(edges.get(w) || [])], 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === index.get(v)) {
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.set(w, count);
          } while (w !== v);
          count++;
        }
      }
    }
  }
  return { comp, count };
}

/**
 * Can every human (h) and SI (i) pod be collected in one alternating chain?
 * Pods are credited to the strongly connected region Nova is in when one of
 * her moves touches them; regions are visited in an order the explored graph
 * allows, and inside a region pods can be taken in any order.
 */
export function perfectChainPossible(result) {
  const { map, edges, nodeTouches } = result;
  const pods = [];
  map.rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) if (r[x] === 'h' || r[x] === 'i') pods.push({ cell: y * map.W + x, kind: r[x] === 'h' ? 1 : 2 });
  });
  if (pods.length === 0) return true;
  const { comp, count: n } = components(edges);
  const avail = Array.from({ length: n }, () => 0);
  for (const [id, cells] of nodeTouches) {
    const set = new Set(cells);
    pods.forEach((p, i) => {
      if (set.has(p.cell)) avail[comp.get(id)] |= 1 << i;
    });
  }
  const dag = Array.from({ length: n }, () => new Set());
  for (const [from, outs] of edges) {
    for (const to of outs) {
      const a = comp.get(from);
      const b = comp.get(to);
      if (b !== undefined && a !== b) dag[a].add(b);
    }
  }
  const all = (1 << pods.length) - 1;
  const seen = new Set();
  const startComp = comp.get(result.start);
  const queue = [[startComp, 0, 0]];
  seen.add(`${startComp}:0:0`);
  while (queue.length) {
    const [c, mask, last] = queue.shift();
    if (mask === all) return true;
    const push = (c2, m2, l2) => {
      const k = `${c2}:${m2}:${l2}`;
      if (!seen.has(k)) {
        seen.add(k);
        queue.push([c2, m2, l2]);
      }
    };
    pods.forEach((p, i) => {
      if (avail[c] & (1 << i) && !(mask & (1 << i)) && p.kind !== last) push(c, mask | (1 << i), p.kind);
    });
    for (const c2 of dag[c]) push(c2, mask, last);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests

// The levels are only as finishable as the engine is faithful to the contract,
// so check physics.js (read-only) while it is there: every promised number
// within ~10%, and Nova's body no bigger than the box the search assumes.
test('engine physics stays inside the contract the levels are built for', async (t) => {
  let P;
  try {
    P = await import('./physics.js');
  } catch {
    t.skip('physics.js is not present');
    return;
  }
  const promised = {
    MAX_RUN: CONTRACT.runSpeed,
    GRAVITY: CONTRACT.gravity,
    JUMP_APEX: CONTRACT.jumpApex,
    SHORT_HOP_APEX: CONTRACT.hopApex,
    GLIDE_MAX_FALL: CONTRACT.glideFall,
    SPRING_APEX: CONTRACT.springApex,
    UPDRAFT_MAX_RISE: CONTRACT.updraftLift,
  };
  for (const [name, want] of Object.entries(promised)) {
    if (typeof P[name] !== 'number') {
      t.diagnostic(`physics.js does not export ${name}; not checked`);
      continue;
    }
    assert.ok(Math.abs(P[name] - want) <= want * 0.1 + 1e-9, `${name} is ${P[name]}, the contract says ${want} (±10%)`);
  }
  if (typeof P.BODY_W === 'number') assert.ok(P.BODY_W <= SIM.w, `BODY_W ${P.BODY_W} is wider than the searched ${SIM.w}`);
  if (typeof P.BODY_H === 'number') assert.ok(P.BODY_H <= SIM.h, `BODY_H ${P.BODY_H} is taller than the searched ${SIM.h}`);
});

test('one level per rule book sector, in order', () => {
  assert.equal(LEVELS.length, rulebook.sectors.length);
  LEVELS.forEach((lv, i) => {
    assert.equal(lv.sectorId, rulebook.sectors[i].id, `level ${i + 1} sectorId`);
    assert.equal(lv.world, WORLDS[i], `level ${i + 1} world`);
  });
});

LEVELS.forEach((level, li) => {
  const sector = rulebook.sectors.find((s) => s.id === level.sectorId);
  const label = `G${li + 1} ${level.name}`;

  test(`${label}: metadata and shape`, () => {
    assert.ok(sector, `unknown sector ${level.sectorId}`);
    assert.equal(typeof level.name, 'string');
    assert.ok(level.name.length > 0);
    assert.ok(Number.isFinite(level.music?.bpm) && level.music.bpm >= 60 && level.music.bpm <= 220, 'music.bpm');
    assert.equal(typeof level.music?.key, 'string');
    const { rows } = level;
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 18 && rows.length <= 28, `height ${rows.length} outside 18-28`);
    const w = rows[0].length;
    assert.ok(w >= 250 && w <= 400, `width ${w} outside 250-400`);
    rows.forEach((r, y) => assert.equal(r.length, w, `row ${y} is ${r.length} wide, expected ${w}`));
    rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) {
        assert.ok(TERRAIN.includes(r[x]) || ENTITIES.includes(r[x]), `illegal '${r[x]}' at ${x},${y}`);
      }
    });
  });

  test(`${label}: entity counts match the rule book`, () => {
    const { rows } = level;
    assert.equal(count(rows, 'P'), 1, 'exactly one start');
    assert.equal(count(rows, 'G'), 1, 'exactly one gate');
    assert.ok(count(rows, 'C') >= 1, 'at least one checkpoint');
    for (const [key, ch] of Object.entries(SPAWN_CHAR)) {
      assert.equal(count(rows, ch), sector.spawn[key], `'${ch}' count vs spawn.${key}`);
    }
    assert.equal(count(rows, 'g') + count(rows, 'x'), sector.spawn.drift, "'g' + 'x' vs spawn.drift");
  });

  test(`${label}: placement`, () => {
    const map = makeMap(level);
    const { rows } = level;
    const { ch } = map;
    rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) {
        const c = r[x];
        if (!ENTITIES.includes(c)) continue;
        // The tile under an entity is empty space, so it can never be inside a wall.
        assert.ok(!map.solid(x, y), `${c} at ${x},${y} sits in a solid tile`);
        if (GROUNDED.includes(c)) {
          assert.ok(map.floor(x, y + 1), `${c} at ${x},${y} needs a floor beneath it`);
          assert.ok(!map.solid(x, y - 1), `${c} at ${x},${y} needs headroom`);
        }
      }
    });
    const [gate] = findAll(rows, 'G');
    assert.equal(ch(gate.x, gate.y + 1), '#', 'the gate stands on solid ground');
    for (const k of [1, 2]) assert.equal(ch(gate.x, gate.y - k), '.', 'the gate archway needs open space above');
    // Spikes sit on solid ground in the open, never where a jump lands. Every
    // floor is entered over an edge (a gap, a drop or a jump up), and a
    // full-speed jump with the contract's numbers comes down up to ~10.6 tiles
    // past it, so a spike sits at least SPIKE_CLEAR tiles into its floor (the
    // levels run left to right). The map's own left edge is not a landing.
    const SPIKE_CLEAR = 11;
    for (const s of findAll(rows, 'x')) {
      assert.equal(ch(s.x, s.y + 1), '#', `spike at ${s.x},${s.y} sits on solid ground`);
      for (const d of [-2, -1, 1, 2]) {
        assert.ok(map.standable(s.x + d, s.y), `spike at ${s.x},${s.y} needs walkable floor two tiles either side`);
      }
      let start = s.x;
      while (start - 1 >= 0 && (map.standable(start - 1, s.y) || ch(start - 1, s.y) === 'x')) start--;
      if (start > 0) {
        assert.ok(s.x - start >= SPIKE_CLEAR, `spike at ${s.x},${s.y} is only ${s.x - start} tiles past the edge at x=${start}: a full-speed landing`);
      }
    }
    // Glitch-bots patrol a real platform and leave room to jump over them.
    for (const g of findAll(rows, 'g')) {
      let run = 1;
      for (let d = 1; map.standable(g.x - d, g.y) || ch(g.x - d, g.y) === 'g'; d++) run++;
      for (let d = 1; map.standable(g.x + d, g.y) || ch(g.x + d, g.y) === 'g'; d++) run++;
      assert.ok(run >= 4, `glitch-bot at ${g.x},${g.y} patrols only ${run} tiles`);
      for (let k = 1; k <= 4; k++) assert.ok(!map.solid(g.x, g.y - k), `glitch-bot at ${g.x},${g.y} needs 4 tiles of headroom`);
    }
    // Boosters fling Nova: keep hazards off the runway they throw her down.
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        const c = rows[y][x];
        if ((c !== '>' && c !== '<') || rows[y][x + (c === '>' ? 1 : -1)] === c) continue;
        const dir = c === '>' ? 1 : -1;
        for (let k = 1; k <= 12; k++) {
          for (let up = 1; up <= 2; up++) {
            const e = ch(x + dir * k, y - up);
            assert.ok(e !== 'x' && e !== 'g', `hazard ${k} tiles past the booster at ${x},${y}`);
          }
        }
      }
    }
    // Moving platforms: an empty track that ends at a wall (or the travel
    // limit) and room for the three-tile platform.
    for (const p of map.platforms) {
      const at = `${p.kind} at ${p.x},${p.y}`;
      // A horizontal platform is three tiles wide around its marker, so it
      // needs a free tile on each side; a lift may start at either end.
      if (p.kind === 'm') assert.ok(p.reachA >= 1 && p.reachB >= 1, `${at} has no room for its three tiles`);
      else assert.ok(p.reachA + p.reachB >= 2, `${at} has no room to travel`);
      const limit = p.kind === 'm' ? 8 : 6;
      assert.ok(SOLID.includes(p.endA) || p.reachA === limit, `${at}: track must end at a solid tile, found '${p.endA}'`);
      assert.ok(SOLID.includes(p.endB) || p.reachB === limit || (p.kind === 'v' && p.b === rows.length - 1),
        `${at}: track must end at a solid tile, found '${p.endB}'`);
    }
  });

  test(`${label}: checkpoints every ~80-120 tiles`, () => {
    const marks = [...findAll(level.rows, 'P'), ...findAll(level.rows, 'C'), ...findAll(level.rows, 'G')]
      .map((p) => p.x)
      .sort((a, b) => a - b);
    for (let i = 1; i < marks.length; i++) {
      assert.ok(marks[i] - marks[i - 1] <= 130, `${marks[i] - marks[i - 1]} tiles between respawn points at x=${marks[i - 1]} and x=${marks[i]}`);
    }
  });

  test(`${label}: the gate is reachable without secrets or shortcuts`, () => {
    const main = explore(level, { secrets: false, avoidRed: true });
    const { W } = main.map;
    const [gate] = findAll(level.rows, 'G');
    assert.ok(main.touched[gate.y * W + gate.x], 'gate unreachable on the main route');
    for (const c of findAll(level.rows, 'C')) {
      assert.ok(main.touched[c.y * W + c.x], `checkpoint at ${c.x},${c.y} is off the main route`);
    }
  });

  test(`${label}: every scoring entity is reachable and nothing traps Nova`, () => {
    const full = explore(level);
    const { W } = full.map;
    const missing = [];
    level.rows.forEach((r, y) => {
      for (let x = 0; x < r.length; x++) {
        if ('ohicdbtrCG'.includes(r[x]) && !full.touched[y * W + x]) missing.push(`${r[x]}@${x},${y}`);
      }
    });
    assert.deepEqual(missing, [], 'unreachable entities');
    // Entities Nova must stand beside (beacons, terminals, capsules) and
    // critters she must reach with the pulse are on floor she can stand on.
    for (const ch of 'bctd') {
      for (const e of findAll(level.rows, ch)) {
        assert.ok(full.seen[e.y * W + e.x], `${ch} at ${e.x},${e.y}: Nova cannot stand there`);
      }
    }
    const [gate] = findAll(level.rows, 'G');
    const ok = canFinish(full, gate.y * W + gate.x);
    const stuck = [];
    for (const id of full.edges.keys()) {
      if (!ok.has(id)) stuck.push(id < full.map.W * full.map.H ? `${id % W},${Math.floor(id / W)}` : `updraft#${id}`);
    }
    assert.deepEqual(stuck.slice(0, 10), [], `${stuck.length} places with no way on to the gate`);
  });

  if (sector.mechanic === 'chain') {
    test(`${label}: a perfect alternating chain is possible, and takes care`, () => {
      assert.ok(perfectChainPossible(explore(level)), 'no order collects every pod alternately');
      const order = findAll(level.rows, 'h').concat(findAll(level.rows, 'i')).sort((a, b) => a.x - b.x);
      const kinds = order.map((p) => level.rows[p.y][p.x]);
      assert.ok(kinds.some((k, i) => i > 0 && k === kinds[i - 1]), 'a plain left-to-right sweep should not already be a perfect chain');
    });
  }
});
