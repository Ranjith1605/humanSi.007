// Everything in a level that is not terrain or Nova: gems, pods, crew
// capsules, critters, beacons, terminals, shortcut cores, glitch-bots, spikes,
// checkpoints and the gate. Positions are in tiles; `x`/`y` is the entity's
// visual centre. Each entity resolves at most once, which is what keeps the
// sector counters inside their caps.

import { isSolidCode, T } from './physics.js';
import { groundBelow } from './level.js';

const SCAN_TIME = 1.2;
const ASSIST_TIME = 1.5;
const REVIEW_TIME = 1.2;
const STUN_TIME = 2.0;
const TERMINAL_CYCLE = 3.2;
const TERMINAL_DUE = 2.0;

/** Visual heights (tiles) of things that stand on the ground. */
const STAND = { capsule: 1.6, beacon: 1.75, terminal: 1.5, checkpoint: 2, gate: 5, critter: 0.8, 'glitch-bot': 0.9 };

export function createEntities(lv) {
  const list = [];
  let id = 0;
  let terminalIndex = 0;
  const terminalCount = lv.spawns.filter((s) => s.kind === 'terminal').length;
  for (const s of lv.spawns) {
    if (s.kind === 'start') continue;
    const e = { id: `${s.kind}-${id++}`, kind: s.kind, tx: s.tx, ty: s.ty, x: s.tx + 0.5, y: s.ty + 0.5, active: true, t: Math.random() * 10, progress: 0 };
    const ground = groundBelow(lv, s.tx, s.ty);
    const g = ground >= 0 ? ground : s.ty + 1;
    e.ground = g;
    if (STAND[s.kind] !== undefined) {
      e.y = g - STAND[s.kind] / 2;
    }
    switch (s.kind) {
      case 'critter':
      case 'glitch-bot': {
        const span = patrolSpan(lv, s.tx, g);
        e.minX = span[0] + 0.45;
        e.maxX = span[1] + 1 - 0.45;
        e.dir = Math.random() < 0.5 ? -1 : 1;
        e.speed = s.kind === 'critter' ? 1.7 : 2.3;
        e.stunT = 0;
        e.calm = false;
        e.feet = g;
        break;
      }
      case 'spike':
        e.y = s.ty + 0.75;
        break;
      case 'terminal':
        e.order = terminalIndex++;
        e.phase = (e.order * TERMINAL_CYCLE) / Math.max(1, terminalCount);
        e.due = false;
        break;
      case 'gate':
        e.gateX = s.tx + 0.5;
        break;
      default:
        break;
    }
    list.push(e);
  }
  return list;
}

/** Walkable span along the ground row: no wall in the way and floor underneath. */
function patrolSpan(lv, tx, groundRow) {
  const walk = (x) => {
    if (x < 0 || x >= lv.w) return false;
    const body = lv.tiles[(groundRow - 1) * lv.w + x];
    if (groundRow - 1 >= 0 && isSolidCode(body)) return false;
    if (groundRow >= lv.h) return false;
    const floor = lv.tiles[groundRow * lv.w + x];
    return isSolidCode(floor) || floor === T.ONEWAY;
  };
  let l = tx;
  while (walk(l - 1) && tx - l < 40) l--;
  let r = tx;
  while (walk(r + 1) && r - tx < 40) r++;
  return [l, r];
}

function near(p, e, rx, ry) {
  return Math.abs(p.x - e.x) < rx && Math.abs(p.centerY - e.y) < ry;
}

function touches(p, cx, cy, hw, hh) {
  return p.x + p.w / 2 > cx - hw && p.x - p.w / 2 < cx + hw && p.y > cy - hh && p.y - p.h < cy + hh;
}

/**
 * Advance every entity one step and resolve contacts with Nova.
 * `g` is the running level (game.js): player, mech, emit, pulses, hurt, checkpoint, gate.
 */
export function updateEntities(list, dt, g) {
  const p = g.player;
  for (const e of list) {
    e.t += dt;
    switch (e.kind) {
      case 'gem':
        if (e.active && touches(p, e.x, e.y, 0.5, 0.55)) {
          e.active = false;
          if (g.mech.core()) g.emit('gem', { x: e.x, y: e.y, e });
        }
        break;
      case 'human-pod':
      case 'si-pod':
        if (e.active && touches(p, e.x, e.y, 0.5, 0.55)) {
          e.active = false;
          const res = g.mech.pod(e.kind === 'human-pod' ? 'human' : 'si');
          g.emit('pod', { x: e.x, y: e.y, kind: e.kind, res, e });
        }
        break;
      case 'shortcut':
        if (e.active && touches(p, e.x, e.y, 0.45, 0.5)) {
          e.active = false;
          if (g.mech.shortcut()) g.emit('shortcut', { x: e.x, y: e.y, e });
        }
        break;
      case 'beacon':
        if (e.active) {
          if (near(p, e, 2.1, 2.4) && p.alive) {
            e.progress += dt / SCAN_TIME;
            if (e.progress >= 1) {
              e.progress = 1;
              e.active = false;
              if (g.mech.scan()) g.emit('scan', { x: e.x, y: e.y, e });
            } else g.emit('scanning', { e });
          } else e.progress = Math.max(0, e.progress - dt * 0.5);
        }
        break;
      case 'capsule':
        if (e.active) {
          if (near(p, e, 1.8, 1.8) && p.alive) {
            e.progress += dt / ASSIST_TIME;
            if (e.progress >= 1) {
              e.progress = 1;
              e.active = false;
              e.freedT = 0;
              if (g.mech.assist()) {
                p.speedBoost();
                g.emit('assist', { x: e.x, y: e.y, e });
              }
            } else g.emit('assisting', { e });
          } else e.progress = Math.max(0, e.progress - dt * 0.5);
        } else if (e.freedT !== undefined) e.freedT += dt;
        break;
      case 'terminal': {
        if (!e.active) break;
        const c = (g.time + e.phase) % TERMINAL_CYCLE;
        e.due = c < TERMINAL_DUE;
        if (e.due && near(p, e, 1.9, 2.0) && p.alive) {
          e.progress += dt / REVIEW_TIME;
          if (e.progress >= 1) {
            e.progress = 1;
            e.active = false;
            e.due = false;
            if (g.mech.review()) g.emit('review', { x: e.x, y: e.y, e });
          } else g.emit('reviewing', { e });
        }
        break;
      }
      case 'critter':
        if (!e.calm) {
          patrol(e, dt);
          hitByPulse(e, g, () => {
            e.calm = true;
            e.active = false;
            e.calmT = 0;
            e.baseY = e.y;
            if (g.mech.harmonize()) g.emit('calm', { x: e.x, y: e.y, e });
          });
          if (!e.calm && touches(p, e.x, e.y, 0.42, 0.38)) g.hurt(e.x, e);
        } else {
          e.calmT += dt;
          // Calmed critters become small friendly lights that bob in place.
          e.y = e.baseY - Math.min(0.9, e.calmT * 1.5) + Math.sin(e.calmT * 3) * 0.12;
        }
        break;
      case 'glitch-bot':
        if (e.stunT > 0) {
          e.stunT -= dt;
          e.active = e.stunT <= 0;
        } else patrol(e, dt);
        hitByPulse(e, g, () => {
          e.stunT = STUN_TIME;
          e.active = false;
          g.emit('stun', { x: e.x, y: e.y, e });
        });
        if (e.stunT <= 0 && touches(p, e.x, e.y, 0.42, 0.42)) g.hurt(e.x, e);
        break;
      case 'spike':
        if (touches(p, e.x, e.y, 0.36, 0.22)) g.hurt(e.x, e);
        break;
      case 'checkpoint':
        if (e.active && touches(p, e.x, e.y, 0.6, 1.0)) {
          e.active = false;
          g.checkpoint(e);
        }
        break;
      case 'gate':
        if (e.active && touches(p, e.x, e.y, 1.2, 2.5)) {
          e.active = false;
          g.reachGate(e);
        }
        break;
      default:
        break;
    }
  }
}

function patrol(e, dt) {
  if (e.maxX - e.minX < 0.05) return;
  e.x += e.dir * e.speed * dt;
  if (e.x <= e.minX) { e.x = e.minX; e.dir = 1; }
  if (e.x >= e.maxX) { e.x = e.maxX; e.dir = -1; }
}

function hitByPulse(e, g, apply) {
  for (const ring of g.pulses) {
    if (ring.hit.has(e.id)) continue;
    const dx = e.x - ring.x;
    const dy = e.y - ring.y;
    if (dx * dx + dy * dy <= ring.r * ring.r) {
      ring.hit.add(e.id);
      apply();
      return;
    }
  }
}

/** Public snapshot for the debug API (tiles). */
export function entitySnapshot(e) {
  const out = { id: e.id, kind: e.kind, x: +e.x.toFixed(3), y: +e.y.toFixed(3), active: e.active };
  if (e.progress) out.progress = +e.progress.toFixed(3);
  if (e.kind === 'terminal') out.due = e.due;
  if (e.kind === 'critter') out.calm = e.calm;
  if (e.kind === 'glitch-bot') out.stunned = e.stunT > 0;
  return out;
}
