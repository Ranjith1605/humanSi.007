// Nova Run physics. The numbers below are the contract the level designers
// build against (see the level format contract shared with levels/), so each
// one is a named export and the comments say what it promises. Units are
// tiles and seconds throughout: a tile is TILE pixels at internal resolution,
// y grows downwards, a body's x is its centre and its y is its feet.

export const TILE = 16;
export const STEP_HZ = 120;
export const STEP = 1 / STEP_HZ;

// Running: top speed 11 tiles/s, reached in ~0.35 s from a standstill.
export const MAX_RUN = 11;
export const RUN_ACCEL = MAX_RUN / 0.35;
export const GROUND_FRICTION = 44;
// Turning against your momentum skids: a short, visible brake with dust.
export const SKID_DECEL = 70;
export const AIR_ACCEL = 28;
export const AIR_DRAG = 5;

// Jumping. Gravity is 60 tiles/s² while falling. While rising with the
// button held it is gentler, which is what gives the floaty 4-tile apex;
// releasing early swaps to a heavy "jump cut" gravity for a ~1.5-tile hop.
export const GRAVITY = 60;
export const JUMP_APEX = 4.0;
export const SHORT_HOP_APEX = 1.5;
export const GRAVITY_RISE_HOLD = 40;
export const JUMP_VELOCITY = Math.sqrt(2 * GRAVITY_RISE_HOLD * JUMP_APEX);
export const GRAVITY_RISE_RELEASE = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * SHORT_HOP_APEX);
export const MAX_FALL = 22;
export const COYOTE_TIME = 0.1;
export const JUMP_BUFFER = 0.12;
// Design guarantees for level builders (the engine clears at least these).
export const GAP_RUNNING_JUMP = 6;
export const GAP_GLIDE = 9;

// Flap-glide: press jump again in the air and hold it; the thruster caps the fall.
export const GLIDE_MAX_FALL = 3;

// Level toys.
export const SPRING_APEX = 9;
export const SPRING_VELOCITY = Math.sqrt(2 * GRAVITY * SPRING_APEX);
export const BOOST_SPEED = 20;
export const BOOST_DECAY = 0.8;
export const UPDRAFT_MAX_RISE = 6;
export const UPDRAFT_ACCEL = 150;
export const UPDRAFT_MAX_UP = 9;
export const CRUMBLE_DELAY = 0.5;
export const CRUMBLE_RESPAWN = 3;
export const PLATFORM_H_MAX = 8;
export const PLATFORM_V_MAX = 6;
export const PLATFORM_SPEED = 3;
export const PLATFORM_WIDTH = 3;

// Getting hurt.
export const HURT_KNOCK_UP = 4;
export const HURT_KNOCK_AWAY = 6;
export const HURT_CONTROL_LOCK = 0.28;
export const INVULN_TIME = 1.0;

// Nova's collision box, smaller than the sprite so near misses feel fair.
export const BODY_W = 0.7;
export const BODY_H = 1.4;

/** Tile codes for the parsed map. */
export const T = Object.freeze({
  EMPTY: 0,
  SOLID: 1,
  ONEWAY: 2,
  CRUMBLE: 3,
  FALSE: 4,
  SPRING: 5,
  BOOST_R: 6,
  BOOST_L: 7,
  UPDRAFT: 8,
});

export function isSolidCode(c) {
  return c === T.SOLID || c === T.SPRING || c === T.BOOST_R || c === T.BOOST_L;
}

/** Drawn as rock by the tile renderer (false walls pass for rock on purpose). */
export function looksSolid(c) {
  return isSolidCode(c) || c === T.FALSE;
}

/**
 * The map is bounded: left, right and top are walls; below the bottom row is a pit.
 * `lv` is a parsed level (see level.js).
 */
export function tileAt(lv, tx, ty) {
  if (tx < 0 || tx >= lv.w || ty < 0) return T.SOLID;
  if (ty >= lv.h) return T.EMPTY;
  return lv.tiles[ty * lv.w + tx];
}

export function solidAt(lv, tx, ty) {
  return isSolidCode(tileAt(lv, tx, ty));
}

/** A surface you can stand on from above but pass through from below. */
export function oneWayAt(lv, tx, ty) {
  const c = tileAt(lv, tx, ty);
  if (c === T.ONEWAY) return true;
  if (c === T.CRUMBLE) return lv.crumbleIntact(tx, ty);
  return false;
}

const EPS = 1e-4;

/**
 * Move a body horizontally against solid tiles. Per-step movement is always
 * well under a tile (the fastest thing, a spring launch, is ~0.27 tiles per
 * 120 Hz step), so checking the one column the leading edge enters is enough.
 * Returns true when a wall stopped the body.
 */
export function moveX(lv, b, dx) {
  if (dx === 0) return false;
  const half = b.w / 2;
  const ty0 = Math.floor(b.y - b.h + EPS);
  const ty1 = Math.floor(b.y - EPS);
  let nx = b.x + dx;
  if (dx > 0) {
    const before = Math.floor(b.x + half - EPS);
    const col = Math.floor(nx + half - EPS);
    if (col > before) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (solidAt(lv, col, ty)) {
          b.x = col - half;
          return true;
        }
      }
    }
  } else {
    const before = Math.floor(b.x - half + EPS);
    const col = Math.floor(nx - half + EPS);
    if (col < before) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (solidAt(lv, col, ty)) {
          b.x = col + 1 + half;
          return true;
        }
      }
    }
  }
  b.x = nx;
  return false;
}

/**
 * Move a body vertically. Lands on solid tiles, one-way tiles, intact crumbling
 * tiles and moving platforms (unless dropping through), and bumps its head on
 * solid tiles only. Head bumps that clip a corner by a few pixels nudge the
 * body sideways instead, so jumps past ledges do not snag.
 *
 * Returns { landed, ceiling, row, platform } where `row` is the tile row landed on.
 */
export function moveY(lv, b, dy, dropping) {
  const out = { landed: false, ceiling: false, row: -1, platform: null };
  if (dy === 0) return out;
  const half = b.w / 2;
  const x0 = Math.floor(b.x - half + EPS);
  const x1 = Math.floor(b.x + half - EPS);
  if (dy > 0) {
    const oldBot = b.y;
    const newBot = b.y + dy;
    // Moving platforms first: they can sit between tile rows.
    if (!dropping) {
      for (const p of lv.platforms) {
        const left = p.x - p.w / 2;
        const right = p.x + p.w / 2;
        if (b.x + half <= left || b.x - half >= right) continue;
        // Feet were at or above the platform's top last step and are at or below it now.
        if (oldBot <= Math.max(p.y, p.prevY) + EPS && newBot >= p.y) {
          b.y = p.y;
          out.landed = true;
          out.platform = p;
          return out;
        }
      }
    }
    const row = Math.floor(newBot);
    // Only tiles whose top was at or below the old feet can be landed on: that
    // is also exactly the one-way rule.
    if (row >= oldBot - EPS) {
      for (let tx = x0; tx <= x1; tx++) {
        if (solidAt(lv, tx, row) || (!dropping && oneWayAt(lv, tx, row))) {
          b.y = row;
          out.landed = true;
          out.row = row;
          return out;
        }
      }
    }
    b.y = newBot;
    return out;
  }
  // Moving up.
  const head = b.y - b.h;
  const newHead = head + dy;
  const row = Math.floor(newHead);
  if (row < Math.floor(head + EPS) || newHead < 0) {
    let hitL = false;
    let hitR = false;
    let hits = 0;
    for (let tx = x0; tx <= x1; tx++) {
      if (solidAt(lv, tx, row)) {
        hits++;
        if (tx === x0) hitL = true;
        if (tx === x1) hitR = true;
      }
    }
    if (hits > 0) {
      // Corner forgiveness: only one edge column clipped, by at most ~5 px.
      const NUDGE = 0.32;
      if (hits === 1 && x1 > x0) {
        if (hitL && !hitR) {
          const overlap = x0 + 1 - (b.x - half);
          if (overlap <= NUDGE && !solidAt(lv, x0 + 1, row) && !wallBetween(lv, b, x0 + 1 + half + EPS)) {
            b.x = x0 + 1 + half + EPS;
            b.y += dy;
            return out;
          }
        } else if (hitR && !hitL) {
          const overlap = b.x + half - x1;
          if (overlap <= NUDGE && !solidAt(lv, x1 - 1, row) && !wallBetween(lv, b, x1 - half - EPS)) {
            b.x = x1 - half - EPS;
            b.y += dy;
            return out;
          }
        }
      }
      b.y = row + 1 + b.h;
      out.ceiling = true;
      return out;
    }
  }
  b.y += dy;
  return out;
}

function wallBetween(lv, b, nx) {
  const half = b.w / 2;
  const ty0 = Math.floor(b.y - b.h + EPS);
  const ty1 = Math.floor(b.y - EPS);
  const xa = Math.floor(nx - half + EPS);
  const xb = Math.floor(nx + half - EPS);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = xa; tx <= xb; tx++) if (solidAt(lv, tx, ty)) return true;
  }
  return false;
}

/** True when the box overlaps any solid tile (used to keep respawns honest). */
export function overlapsSolid(lv, x, y, w, h) {
  const x0 = Math.floor(x - w / 2 + EPS);
  const x1 = Math.floor(x + w / 2 - EPS);
  const y0 = Math.floor(y - h + EPS);
  const y1 = Math.floor(y - EPS);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) if (solidAt(lv, tx, ty)) return true;
  }
  return false;
}

/** Tile codes under a body's feet when it stands on row `row` (left to right). */
export function tilesUnderfoot(lv, b, row) {
  const half = b.w / 2;
  const x0 = Math.floor(b.x - half + EPS);
  const x1 = Math.floor(b.x + half - EPS);
  const out = [];
  for (let tx = x0; tx <= x1; tx++) out.push({ tx, ty: row, code: tileAt(lv, tx, row) });
  return out;
}

/** Axis-aligned overlap between a body (centre x, feet y) and a box given by its centre. */
export function overlapBox(b, cx, cy, hw, hh) {
  return (
    b.x + b.w / 2 > cx - hw &&
    b.x - b.w / 2 < cx + hw &&
    b.y > cy - hh &&
    b.y - b.h < cy + hh
  );
}
