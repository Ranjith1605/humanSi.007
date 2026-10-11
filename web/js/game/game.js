// One flown level: map, Nova, entities, mechanics, camera and effects, plus
// the rules that tie them together (hull cells, checkpoints, pits, the gate).
// The simulation advances only through step(); `steps` counts 120 Hz steps
// from launch to the gate and becomes the sector's timeMs.

import { STEP, TILE, PLATFORM_SPEED, overlapsSolid, BODY_W, BODY_H } from './physics.js';
import { buildLevel, updatePlatforms, updateCrumble, groundBelow } from './level.js';
import { Player } from './player.js';
import { createEntities, updateEntities, entitySnapshot } from './entities.js';
import { Mechanics } from './mechanics.js';
import { Camera } from './camera.js';
import { Particles } from './particles.js';
import { worldOf } from './worlds.js';

export const HULL_CELLS = 5;
export const HULL_PER_CELL = 20;
const PULSE_RADIUS = 4.5;
const PULSE_TIME = 0.42;

export class LevelRun {
  constructor({ def, sector, module, levelIndex, rulebook, audio, reducedMotion, practice }) {
    this.def = def;
    this.sector = sector;
    this.module = module;
    this.levelIndex = levelIndex;
    this.rulebook = rulebook;
    this.audio = audio;
    this.practice = !!practice;
    this.world = def.world;
    this.palette = worldOf(def.world);
    this.lv = buildLevel(def);
    this.player = new Player();
    this.entities = createEntities(this.lv);
    this.gate = this.entities.find((e) => e.kind === 'gate');
    this.mech = new Mechanics(sector);
    this.camera = new Camera();
    this.camera.reducedMotion = reducedMotion;
    this.camera.setMap(this.lv.w, this.lv.h);
    this.particles = new Particles();
    this.particles.reduced = reducedMotion;
    this.reduced = reducedMotion;
    this.fx = { springs: new Map(), flash: 0, flashColor: '#ffffff', integrityFlash: 0 };
    this.pulses = [];
    this.time = 0;
    this.steps = 0;
    this.cells = HULL_CELLS;
    this.streak = 0;
    this.streakT = 0;
    this.bestStreak = 0;
    this.state = 'play';
    this.stateT = 0;
    this.glideSfxT = 0;
    this.secretsFound = 0;
    this.events = [];
    this.onGate = null;
    this.onHullOut = null;

    const start = this.lv.spawns.find((s) => s.kind === 'start');
    const g = groundBelow(this.lv, start.tx, start.ty);
    this.respawn = { x: start.tx + 0.5, y: g >= 0 ? g : start.ty + 1 };
    this.player.reset(this.respawn.x, this.respawn.y);
    this.player.onGround = true;
  }

  get timeMs() {
    return Math.round((this.steps * 1000) / 120);
  }

  emit = (type, d = {}) => {
    const p = this.particles;
    const a = this.audio;
    const pal = this.palette;
    const px = (v) => v * TILE;
    const sc = this.rulebook.scoring;
    switch (type) {
      case 'jump':
        a.sfx('jump');
        p.dust(px(d.x), px(d.y), 0, 4);
        break;
      case 'land':
        if (d.impact > 6) {
          a.sfx('land', { impact: d.impact });
          p.dust(px(d.x), px(d.y), 0, Math.min(8, Math.round(d.impact / 3)));
        }
        break;
      case 'step':
        p.dust(px(d.x) - d.dir * 4, px(d.y), d.dir, 1);
        break;
      case 'skid':
        p.dust(px(d.x) + d.dir * 5, px(d.y), -d.dir, 1, '#ffffff');
        break;
      case 'glide-start':
        a.sfx('glide');
        p.burst(px(d.x) - this.player.facing * 6, px(d.y) - 4, 5, ['#fff7c2', '#ffc04a'], 40, 0.25, { up: 30 });
        break;
      case 'spring':
        a.sfx('spring');
        this.fx.springs.set(d.ty * this.lv.w + d.tx, 0.25);
        p.burst(px(d.tx + 0.5), px(d.ty), 8, ['#ffb0a0', '#ffffff', '#ff4a4a'], 70, 0.4, { up: -40 });
        break;
      case 'boost':
        a.sfx('boost');
        p.burst(px(d.x), px(d.y) - 6, 8, ['#66e1ff', '#ffffff'], 50, 0.35);
        break;
      case 'drop':
        p.dust(px(d.x), px(d.y), 0, 3);
        break;
      case 'bonk':
        a.sfx('bonk');
        break;
      case 'crumble-touch':
        p.dust(px(d.tx + 0.5), px(d.ty), 0, 3, '#ffffff');
        break;
      case 'pulse':
        a.sfx('pulse');
        this.pulses.push({ x: d.x, y: d.y, r: 0, t: 0, hit: new Set() });
        p.ring(px(d.x), px(d.y), PULSE_RADIUS * TILE, '#9ff6ff', PULSE_TIME);
        p.ring(px(d.x), px(d.y), PULSE_RADIUS * TILE * 0.75, '#ffffff', PULSE_TIME * 0.8);
        p.burst(px(d.x), px(d.y), 10, ['#9ff6ff', '#ffffff', '#c58bff'], 90, 0.45);
        break;
      case 'gem':
        this.bumpStreak();
        a.sfx('gem', { streak: this.streak - 1 });
        p.burst(px(d.x), px(d.y), 9, [pal.gem[0], pal.gem[1], pal.gem[2]], 70, 0.45);
        if (this.streak >= 5 && this.streak % 5 === 0) p.popup(px(d.x), px(d.y) - 6, `X${this.streak}`, pal.gem[1]);
        break;
      case 'pod': {
        const col = d.kind === 'si-pod' ? '#66e1ff' : '#ffc24a';
        if (d.res === 'link') {
          this.bumpStreak();
          a.sfx('pod-link', { streak: this.mech.chainRun });
          p.popup(px(d.x), px(d.y), `+${sc.chainLink}`, col);
        } else if (d.res === 'break') {
          this.streak = 0;
          a.sfx('pod-break');
          p.popup(px(d.x), px(d.y), 'UNCHECKED', '#ff6b8b');
          this.camera.shake(0.25);
        } else a.sfx('pod-start');
        p.burst(px(d.x), px(d.y), 12, [col, '#ffffff'], 80, 0.5);
        break;
      }
      case 'shortcut':
        a.sfx('shortcut');
        p.popup(px(d.x), px(d.y), `+${sc.shortcutGain}`, '#ff6b6b');
        p.popup(px(d.x), px(d.y) + 9, `INTEGRITY -${sc.integrityPerShortcut}`, '#ff3b4e');
        p.burst(px(d.x), px(d.y), 14, ['#ff3b4e', '#ff9aa6', '#2a020a'], 90, 0.5);
        this.fx.flash = 0.25;
        this.fx.flashColor = '#ff3b4e';
        this.fx.integrityFlash = 1;
        this.camera.shake(0.3);
        break;
      case 'scanning':
        if (Math.floor(d.e.progress * 10) !== Math.floor((d.e.progress - STEP / 1.2) * 10)) a.sfx('tick', { p: d.e.progress });
        if (Math.random() < 0.3) p.spawn(px(d.e.x) + (Math.random() - 0.5) * 30, px(d.e.y) + 10, 0, -30, 0.5, this.module.color, 1, 0, 0, 3);
        break;
      case 'scan':
        a.sfx('scan');
        p.popup(px(d.x), px(d.y) - 10, `+${sc.scan}`, this.module.color);
        p.ring(px(d.x), px(d.y), 40, this.module.color, 0.6);
        p.burst(px(d.x), px(d.y), 18, [this.module.color, '#ffffff'], 100, 0.7);
        break;
      case 'assisting':
        if (Math.random() < 0.35) p.spawn(px(d.e.x) + (Math.random() - 0.5) * 20, px(d.e.y) + 12, 0, -40, 0.5, '#ffcf7a', 1, 0, 0, 3);
        break;
      case 'assist':
        a.sfx('assist');
        p.popup(px(d.x), px(d.y) - 14, `+${sc.assist}`, '#ffcf7a');
        p.popup(px(this.player.x), px(this.player.y) - 30, 'BOOST', '#66e1ff');
        p.burst(px(d.x), px(d.y), 20, ['#ffcf7a', '#ffffff', '#66e1ff'], 90, 0.7);
        break;
      case 'reviewing':
        if (Math.random() < 0.3) p.spawn(px(d.e.x) + (Math.random() - 0.5) * 16, px(d.e.y) - 4, 0, -24, 0.4, '#ffb547', 1, 0, 0, 3);
        break;
      case 'review':
        a.sfx('review');
        p.popup(px(d.x), px(d.y) - 14, `+${sc.review}`, '#2fdc8a');
        p.burst(px(d.x), px(d.y), 14, ['#2fdc8a', '#ffffff', '#ffb547'], 80, 0.6);
        break;
      case 'calm':
        a.sfx('calm');
        p.popup(px(d.x), px(d.y) - 8, `+${sc.harmonize}`, '#7dffb8');
        p.burst(px(d.x), px(d.y), 16, ['#7dffb8', '#ffffff', '#ff9ab4'], 70, 0.8, { kind: 3 });
        break;
      case 'stun':
        a.sfx('stun');
        p.burst(px(d.x), px(d.y), 8, ['#66e1ff', '#ffffff'], 60, 0.4);
        break;
      default:
        break;
    }
  };

  bumpStreak() {
    this.streak = this.streakT > 0 ? this.streak + 1 : 1;
    this.streakT = 2.2;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
  }

  /** Damage from a hazard at fromX. */
  hurt(fromX) {
    if (this.state !== 'play') return;
    if (!this.player.hurt(fromX)) return;
    this.cells = Math.max(0, this.cells - 1);
    this.streak = 0;
    this.audio.sfx('hurt');
    this.camera.shake(0.55);
    this.fx.flash = 0.18;
    this.fx.flashColor = '#ff3b4e';
    this.particles.burst(this.player.x * TILE, this.player.centerY * TILE, 12, ['#ff6b8b', '#ffffff', '#ffb547'], 90, 0.4);
    if (this.cells <= 0) this.hullOut();
  }

  checkpoint(e) {
    this.respawn = { x: e.x, y: e.ground };
    this.audio.sfx('checkpoint');
    this.particles.popup(e.x * TILE, (e.y - 1.2) * TILE, 'CHECKPOINT', this.palette.accent);
    this.particles.burst(e.x * TILE, (e.y - 0.8) * TILE, 16, [this.palette.accent, '#ffffff'], 80, 0.6);
    for (const o of this.entities) if (o.kind === 'checkpoint' && o !== e) o.current = false;
    e.current = true;
  }

  reachGate() {
    if (this.state !== 'play') return;
    this.state = 'gate';
    this.stateT = 0;
    this.gateSteps = this.steps;
    this.player.frozen = true;
    this.player.vx = 0;
    this.player.vy = 0;
    this.audio.sfx('gate');
    const gx = this.gate.x * TILE;
    const gy = this.gate.y * TILE;
    this.particles.burst(gx, gy, 30, [this.module.color, '#ffffff', this.palette.accent], 140, 0.9);
    this.particles.ring(gx, gy, 60, this.module.color, 0.7);
  }

  hullOut() {
    this.state = 'over';
    this.stateT = 0;
    this.player.alive = false;
    this.player.frozen = false;
    this.audio.sfx('over');
  }

  fellInPit() {
    this.cells = Math.max(0, this.cells - 1);
    this.audio.sfx('fall');
    this.streak = 0;
    if (this.cells <= 0) {
      this.hullOut();
      this.player.frozen = true;
      return;
    }
    // Respawn at the last checkpoint (or the start), never inside rock.
    let { x, y } = this.respawn;
    if (overlapsSolid(this.lv, x, y, BODY_W, BODY_H)) y -= 1;
    const facing = this.player.facing;
    this.player.reset(x, y);
    this.player.facing = facing;
    this.player.invuln = 1.0;
    this.player.onGround = false;
    this.camera.snap(this.player);
    this.particles.burst(x * TILE, (y - 0.7) * TILE, 18, ['#9ff6ff', '#ffffff'], 70, 0.6);
    this.particles.ring(x * TILE, (y - 0.7) * TILE, 28, '#9ff6ff', 0.4);
  }

  step(dt, inp) {
    const pl = this.player;
    if (this.state === 'play') {
      this.time += dt;
      this.steps++;
    } else {
      this.stateT += dt;
      inp = { left: false, right: false, down: false, jump: false, pulse: false, jumpPressed: false, pulsePressed: false };
    }
    updatePlatforms(this.lv, dt, PLATFORM_SPEED);
    pl.update(dt, inp, this.lv, this.emit);

    updateCrumble(this.lv, dt, (tx, ty) => pl.x + pl.w / 2 > tx && pl.x - pl.w / 2 < tx + 1 && pl.y > ty && pl.y - pl.h < ty + 1,
      (tx, ty) => {
        this.audio.sfx('crumble');
        this.particles.burst((tx + 0.5) * TILE, (ty + 0.2) * TILE, 8, [this.palette.accent, '#ffffff', '#3a3050'], 40, 0.6, { gravity: 300, up: -20, drag: 0.5 });
      });

    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const r = this.pulses[i];
      r.t += dt;
      r.r = PULSE_RADIUS * Math.min(1, r.t / PULSE_TIME);
      if (r.t >= PULSE_TIME) this.pulses.splice(i, 1);
    }

    if (this.state === 'play') updateEntities(this.entities, dt, this);
    else for (const e of this.entities) e.t += dt;

    // False walls fade while Nova is inside them; the first visit is a secret found.
    const lv = this.lv;
    const inside = new Set();
    for (const [sx, sy] of [[pl.x, pl.y - 0.3], [pl.x, pl.y - pl.h + 0.2]]) {
      const tx = Math.floor(sx);
      const ty = Math.floor(sy);
      if (tx >= 0 && ty >= 0 && tx < lv.w && ty < lv.h) {
        const gi = lv.falseIndex[ty * lv.w + tx];
        if (gi >= 0) inside.add(gi);
      }
    }
    lv.falseGroups.forEach((g, gi) => {
      const want = inside.has(gi) ? 1 : 0;
      g.reveal += (want - g.reveal) * Math.min(1, dt * 8);
      if (want && !g.found) {
        g.found = true;
        this.secretsFound++;
        this.audio.sfx('secret');
        this.particles.popup(pl.x * TILE, (pl.y - 2) * TILE, 'SECRET', '#ffffff');
      }
    });

    if (this.state === 'play' && pl.y - pl.h > lv.h + 0.5) this.fellInPit();

    // Thruster flutter while gliding.
    if (pl.gliding) {
      this.glideSfxT -= dt;
      if (this.glideSfxT <= 0) {
        this.glideSfxT = 0.13;
        this.audio.sfx('glide');
      }
      if (Math.random() < dt * 40) {
        this.particles.spawn(pl.x * TILE - pl.facing * 7, (pl.y - 0.35) * TILE, (Math.random() - 0.5) * 20 - pl.facing * 10, 40 + Math.random() * 30,
          0.25, Math.random() < 0.5 ? '#ffc04a' : '#fff7c2', 1, 0, 1);
      }
    } else this.glideSfxT = 0;
    if (pl.boostT > 0 && Math.random() < dt * 50) {
      this.particles.spawn(pl.x * TILE - Math.sign(pl.vx) * 6, (pl.y - 0.2 - Math.random()) * TILE, -pl.vx * 4, 0, 0.25, '#66e1ff', 1, 0, 2, 0);
    }
    if (pl.assistT > 0 && Math.random() < dt * 25) {
      this.particles.spawn(pl.x * TILE, (pl.y - Math.random() * pl.h) * TILE, -pl.vx * 3, -10, 0.35, '#ffcf7a', 1, 0, 2, 3);
    }

    for (const [k, v] of this.fx.springs) {
      const n = v - dt;
      if (n <= 0) this.fx.springs.delete(k);
      else this.fx.springs.set(k, n);
    }
    this.fx.flash = Math.max(0, this.fx.flash - dt);
    this.fx.integrityFlash = Math.max(0, this.fx.integrityFlash - dt * 1.5);
    this.streakT = Math.max(0, this.streakT - dt);
    if (this.streakT === 0) this.streak = 0;

    // Gate entry: Nova is drawn into the archway, then the overlay opens.
    if (this.state === 'gate') {
      const gx = this.gate.x;
      pl.x += (gx - pl.x) * Math.min(1, dt * 6);
      if (this.stateT > 1.0 && !this.gateFired) {
        this.gateFired = true;
        this.onGate?.();
      }
    }
    if (this.state === 'over' && this.stateT > 1.6 && !this.overFired) {
      this.overFired = true;
      this.onHullOut?.();
    }

    this.camera.update(dt, pl);
    this.particles.update(dt);
    const amb = this.palette.ambient;
    this.particles.ambient(dt, amb.kind, amb.colors, amb.rate, this.camera.x, this.camera.y, this.camera.viewW, this.camera.viewH);
  }

  /** Debug teleport: feet to (x, y) in tiles. */
  teleport(x, y) {
    const pl = this.player;
    pl.x = Number(x);
    pl.y = Number(y);
    pl.prevX = pl.x;
    pl.prevY = pl.y;
    pl.vx = 0;
    pl.vy = 0;
    pl.riding = null;
    pl.onGround = false;
    this.camera.snap(pl);
  }

  snapshot() {
    const pl = this.player;
    return {
      x: +pl.x.toFixed(3),
      y: +pl.y.toFixed(3),
      vx: +pl.vx.toFixed(3),
      vy: +pl.vy.toFixed(3),
      onGround: pl.onGround,
      state: pl.state,
      gliding: pl.gliding,
      invulnerable: pl.invuln > 0,
    };
  }

  entitySnapshots() {
    return this.entities.map(entitySnapshot);
  }
}
