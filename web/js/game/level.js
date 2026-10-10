// Level parsing and validation. A level module is plain data (string rows plus
// a character legend, see the level format contract); this file turns it into
// the runtime map the physics and entities use, and checks it against the rule
// book before anyone flies it. A level whose entity counts differ from its
// sector's `spawn` must never be played silently: the score caps come from
// `spawn`, so a mismatch would make a perfect run impossible or invalid.

import { T, PLATFORM_H_MAX, PLATFORM_V_MAX, PLATFORM_WIDTH, UPDRAFT_MAX_RISE, CRUMBLE_DELAY, CRUMBLE_RESPAWN, isSolidCode } from './physics.js';

export const WORLD_IDS = ['crystal', 'rigs', 'biodome', 'datacity', 'engineering', 'station'];

const TERRAIN = {
  '.': T.EMPTY,
  '#': T.SOLID,
  '=': T.ONEWAY,
  '~': T.CRUMBLE,
  '%': T.FALSE,
  S: T.SPRING,
  '>': T.BOOST_R,
  '<': T.BOOST_L,
  U: T.UPDRAFT,
};

/** Entity characters → entity kind (the tile underneath is empty space). */
export const ENTITY_KINDS = {
  P: 'start',
  G: 'gate',
  C: 'checkpoint',
  o: 'gem',
  h: 'human-pod',
  i: 'si-pod',
  c: 'capsule',
  d: 'critter',
  b: 'beacon',
  t: 'terminal',
  r: 'shortcut',
  g: 'glitch-bot',
  x: 'spike',
};

const PLATFORM_CHARS = { m: 'h', v: 'v' };

/** Count what a level spawns, in the rule book's `spawn` vocabulary. */
export function countSpawn(rows) {
  const n = {};
  for (const row of rows) for (const ch of row) n[ch] = (n[ch] || 0) + 1;
  const c = (ch) => n[ch] || 0;
  return {
    counts: {
      cores: c('o'),
      humanPods: c('h'),
      siPods: c('i'),
      stranded: c('c'),
      discord: c('d'),
      anomalies: c('b'),
      satellites: c('t'),
      shortcuts: c('r'),
      drift: c('g') + c('x'),
    },
    starts: c('P'),
    gates: c('G'),
    checkpoints: c('C'),
    chars: n,
  };
}

/**
 * Check every level against the rule book. Returns a list of human-readable
 * problems (empty when all is well).
 */
export function validateLevels(levels, rulebook) {
  const problems = [];
  if (!Array.isArray(levels)) return ['levels/index.js must export LEVELS as an array'];
  if (levels.length !== rulebook.sectors.length) {
    problems.push(`LEVELS has ${levels.length} levels; the rule book defines ${rulebook.sectors.length} sectors`);
  }
  rulebook.sectors.forEach((sector, i) => {
    const lv = levels[i];
    const at = `Level ${i + 1} (${sector.id})`;
    if (!lv || typeof lv !== 'object') {
      problems.push(`${at}: missing`);
      return;
    }
    if (lv.sectorId !== sector.id) problems.push(`${at}: sectorId is "${lv.sectorId}", expected "${sector.id}"`);
    if (!WORLD_IDS.includes(lv.world)) problems.push(`${at}: unknown world "${lv.world}"`);
    if (!Array.isArray(lv.rows) || lv.rows.length === 0) {
      problems.push(`${at}: rows missing`);
      return;
    }
    const width = lv.rows[0].length;
    if (lv.rows.some((r) => typeof r !== 'string' || r.length !== width)) problems.push(`${at}: rows are not all the same length`);
    const known = new Set([...Object.keys(TERRAIN), ...Object.keys(ENTITY_KINDS), ...Object.keys(PLATFORM_CHARS)]);
    const sc = countSpawn(lv.rows);
    for (const ch of Object.keys(sc.chars)) {
      if (!known.has(ch)) problems.push(`${at}: unknown tile character "${ch}"`);
    }
    if (sc.starts !== 1) problems.push(`${at}: needs exactly one P (found ${sc.starts})`);
    if (sc.gates !== 1) problems.push(`${at}: needs exactly one G (found ${sc.gates})`);
    if (sc.checkpoints < 1) problems.push(`${at}: needs at least one checkpoint C`);
    for (const [k, want] of Object.entries(sector.spawn)) {
      const got = sc.counts[k];
      if (got !== want) problems.push(`${at}: ${k} is ${got}, the rule book's spawn says ${want}`);
    }
  });
  return problems;
}

/** Parse a level module into the runtime map. */
export function buildLevel(def) {
  const rows = def.rows;
  const h = rows.length;
  const w = rows[0].length;
  const tiles = new Uint8Array(w * h);
  const spawns = [];
  const platformMarks = [];
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      if (ch in TERRAIN) {
        tiles[y * w + x] = TERRAIN[ch];
      } else if (ch in ENTITY_KINDS) {
        spawns.push({ kind: ENTITY_KINDS[ch], tx: x, ty: y, ch });
      } else if (ch in PLATFORM_CHARS) {
        platformMarks.push({ axis: PLATFORM_CHARS[ch], tx: x, ty: y });
      }
    }
  }

  const lv = {
    def,
    w,
    h,
    tiles,
    spawns,
    platforms: [],
    updrafts: [],
    falseGroups: [],
    crumble: new Map(),
    crumbleIntact(tx, ty) {
      const s = this.crumble.get(ty * w + tx);
      return !s || s.phase !== 'gone';
    },
  };

  // Moving platforms travel across the empty span of their row (horizontal)
  // or column (vertical), up to a fixed maximum each way.
  const free = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    const c = tiles[y * w + x];
    return c === T.EMPTY || c === T.UPDRAFT;
  };
  for (const m of platformMarks) {
    const p = {
      axis: m.axis,
      w: PLATFORM_WIDTH,
      homeX: m.tx + 0.5,
      homeY: m.ty,
      x: m.tx + 0.5,
      y: m.ty,
      prevX: m.tx + 0.5,
      prevY: m.ty,
      min: 0,
      max: 0,
      t: 0,
      dx: 0,
      dy: 0,
    };
    if (m.axis === 'h') {
      let l = 0;
      while (l < PLATFORM_H_MAX && free(m.tx - 2 - l, m.ty)) l++;
      let r = 0;
      while (r < PLATFORM_H_MAX && free(m.tx + 2 + r, m.ty)) r++;
      p.min = p.homeX - l;
      p.max = p.homeX + r;
    } else {
      let u = 0;
      while (u < PLATFORM_V_MAX && free(m.tx, m.ty - 1 - u)) u++;
      let d = 0;
      while (d < PLATFORM_V_MAX && free(m.tx, m.ty + 1 + d)) d++;
      p.min = p.homeY - u;
      p.max = p.homeY + d;
    }
    // Start at home, heading towards the longer side first.
    const span = p.max - p.min;
    p.span = span;
    p.t = span > 0 ? ((m.axis === 'h' ? p.homeX : p.homeY) - p.min) / span : 0;
    p.dir = 1;
    lv.platforms.push(p);
  }

  // Updraft zones: each contiguous vertical run of U tiles lifts a gliding
  // Nova up to at most UPDRAFT_MAX_RISE tiles above its lowest tile.
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (tiles[y * w + x] === T.UPDRAFT) {
        const top = y;
        while (y < h && tiles[y * w + x] === T.UPDRAFT) y++;
        const bottom = y; // one past the lowest U tile
        lv.updrafts.push({ x0: x, x1: x + 1, tileTop: top, bottom, liftTop: bottom - UPDRAFT_MAX_RISE });
      } else y++;
    }
  }

  // False walls form groups that are revealed together when Nova steps inside.
  const seen = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (tiles[i] !== T.FALSE || seen[i]) continue;
    const cells = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      cells.push(j);
      const x = j % w;
      const y = (j / w) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (!seen[k] && tiles[k] === T.FALSE) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (const j of cells) {
      const x = j % w, y = (j / w) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    lv.falseGroups.push({ cells, minX, minY, maxX, maxY, reveal: 0, found: false, canvas: null });
  }
  lv.falseIndex = new Int32Array(w * h).fill(-1);
  lv.falseGroups.forEach((g, gi) => g.cells.forEach((j) => { lv.falseIndex[j] = gi; }));

  return lv;
}

/** Advance moving platforms; records each one's displacement for carrying riders. */
export function updatePlatforms(lv, dt, speed) {
  for (const p of lv.platforms) {
    p.prevX = p.x;
    p.prevY = p.y;
    if (p.span <= 0) {
      p.dx = 0;
      p.dy = 0;
      continue;
    }
    // Eased ping-pong: smooth stops at both ends, constant average speed.
    p.t += (p.dir * speed * dt) / p.span;
    if (p.t >= 1) { p.t = 1; p.dir = -1; }
    if (p.t <= 0) { p.t = 0; p.dir = 1; }
    const e = p.t - Math.sin(2 * Math.PI * p.t) / (2 * Math.PI);
    const pos = p.min + e * p.span;
    if (p.axis === 'h') p.x = pos;
    else p.y = pos;
    p.dx = p.x - p.prevX;
    p.dy = p.y - p.prevY;
  }
}

/** Crumbling tiles: shake for CRUMBLE_DELAY after first touch, vanish, then return. */
export function touchCrumble(lv, tx, ty) {
  const k = ty * lv.w + tx;
  if (!lv.crumble.has(k)) lv.crumble.set(k, { phase: 'shake', t: CRUMBLE_DELAY, tx, ty });
}

export function updateCrumble(lv, dt, isOccupied, onBreak) {
  for (const [k, s] of lv.crumble) {
    s.t -= dt;
    if (s.t > 0) continue;
    if (s.phase === 'shake') {
      s.phase = 'gone';
      s.t = CRUMBLE_RESPAWN;
      onBreak?.(s.tx, s.ty);
    } else if (s.phase === 'gone') {
      // Never respawn a tile inside Nova.
      if (isOccupied(s.tx, s.ty)) s.t = 0.2;
      else {
        s.phase = 'back';
        s.t = 0.3;
      }
    } else {
      lv.crumble.delete(k);
    }
  }
}

/** The ground row an entity standing at (tx, ty) rests on, or -1. */
export function groundBelow(lv, tx, ty) {
  for (let y = ty + 1; y < lv.h; y++) {
    const c = lv.tiles[y * lv.w + tx];
    if (isSolidCode(c) || c === T.ONEWAY || c === T.CRUMBLE) return y;
  }
  return -1;
}
