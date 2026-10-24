// Rendering. The world is drawn at a low internal resolution (about 480×270,
// adapted to the screen's aspect) into an offscreen canvas, then scaled up by
// a whole number of device pixels with nearest-neighbour sampling, so every
// game pixel is a crisp square. Only the visible part of the baked level is
// blitted each frame.

import { TILE } from './physics.js';
import { makeCanvas, Pix, rgba, mix, bayer, glow } from './paint.js';
import { drawBackground } from './backgrounds.js';
import { bakeLevel, drawAnimatedTiles, drawUpdrafts, drawFalseWalls } from './tiles.js';
import {
  novaFrame, gemFrames, podSprite, shortcutFrames, critterFrames, calmFrames, botFrames, spikeSprite,
  beaconSprite, terminalSprite, capsuleSprite, crewSprite, checkpointSprite, gateSprite,
} from './sprites.js';
import { circle } from './particles.js';
import { groundBelow } from './level.js';

// A colour grade per world: a vertical wash laid over the finished frame in
// soft-light, light from above and shade below, so each world has one light
// source and depth instead of an evenly lit picture. [top, bottom, strength].
// Station shades its pale hull floor; engineering gains contrast between the
// lamps and the deck. Kept gentle so hazards stay as readable as before.
const GRADE = {
  crystal: ['#ff9cf0', '#1c0638', 0.34],
  rigs: ['#8fb0ff', '#7a2a10', 0.3],
  biodome: ['#fff6c8', '#0f4a44', 0.3],
  datacity: ['#ff7ad8', '#03213f', 0.32],
  engineering: ['#ffd08a', '#160802', 0.4],
  station: ['#d8eeff', '#2a2450', 0.42],
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.dctx = canvas.getContext('2d', { alpha: false });
    this.low = makeCanvas(480, 270);
    this.ctx = this.low.getContext('2d');
    this.W = 480;
    this.H = 270;
    this.k = 1;
    this.baked = null;
    this.bakedFor = null;
    this.vignette = null;
    this.grade = null;
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || window.innerWidth);
    const cssH = Math.max(1, rect.height || window.innerHeight);
    const devW = Math.max(1, Math.round(cssW * dpr));
    const devH = Math.max(1, Math.round(cssH * dpr));
    // Landscape: about 270 internal rows. Portrait: about 16 tiles across.
    const k = devW >= devH ? Math.max(1, Math.round(devH / 270)) : Math.max(1, Math.round(devW / 260));
    const W = Math.ceil(devW / k);
    const H = Math.ceil(devH / k);
    if (this.canvas.width !== devW || this.canvas.height !== devH) {
      this.canvas.width = devW;
      this.canvas.height = devH;
    }
    if (W !== this.W || H !== this.H) {
      this.low.width = W;
      this.low.height = H;
      this.W = W;
      this.H = H;
      this.vignette = null;
    }
    this.k = k;
    this.ctx.imageSmoothingEnabled = false;
    this.dctx.imageSmoothingEnabled = false;
  }

  present() {
    const d = this.dctx;
    d.imageSmoothingEnabled = false;
    d.drawImage(this.low, 0, 0, this.W * this.k, this.H * this.k);
  }

  vignetteCanvas() {
    if (this.vignette) return this.vignette;
    const p = new Pix(this.W, this.H);
    const dark = rgba('#000000', 70);
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const nx = (x / this.W) * 2 - 1;
        const ny = (y / this.H) * 2 - 1;
        const d = nx * nx * 0.6 + ny * ny * 0.9;
        if (d > 0.75 && bayer(x, y) < (d - 0.75) * 1.4) p.d[y * this.W + x] = dark;
      }
    }
    this.vignette = p.toCanvas();
    return this.vignette;
  }

  /** The world's colour grade as a 1-pixel-wide strip, rebuilt when the
   * world or the view height changes, stretched across the frame. */
  gradeCanvas(world) {
    const key = `${world}|${this.H}`;
    if (this.grade && this.grade.key === key) return this.grade;
    const [top, bottom, strength] = GRADE[world] || GRADE.crystal;
    const c = makeCanvas(1, this.H);
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, this.H);
    grad.addColorStop(0, top);
    grad.addColorStop(0.45, mix(top, '#808080', 0.75));
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 1, this.H);
    this.grade = { key, canvas: c, strength };
    return this.grade;
  }

  drawGrade(ctx, world) {
    const grade = this.gradeCanvas(world);
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = grade.strength;
    ctx.drawImage(grade.canvas, 0, 0, this.W, this.H);
    ctx.restore();
  }

  /** Title backdrop: a world's parallax drifting by. */
  drawBackdrop(world, time) {
    const ctx = this.ctx;
    drawBackground(ctx, world, time * 24, 0, this.W, this.H, this.H, 0.3, time);
    this.drawGrade(ctx, world);
    ctx.drawImage(this.vignetteCanvas(), 0, 0);
  }

  drawRun(run, alpha, time) {
    const ctx = this.ctx;
    const cam = run.camera;
    cam.setView(this.W, this.H);
    if (this.bakedFor !== run) {
      this.baked = bakeLevel(run.lv, run.world, run.palette.accent);
      this.bakedFor = run;
      if (!run.cameraReady) {
        cam.snap(run.player);
        run.cameraReady = true;
      }
    }
    const v = cam.view(alpha);
    const ox = v.x;
    const oy = v.y;
    const W = this.W;
    const H = this.H;
    const lv = run.lv;
    const mapW = lv.w * TILE;
    const mapH = lv.h * TILE;
    const progress = Math.min(1, Math.max(0, (ox + W / 2) / mapW));

    drawBackground(ctx, run.world, ox, oy, W, H, mapH, progress, time);
    drawUpdrafts(ctx, lv, ox, oy, W, H, time, run.palette.light);

    // Baked level, clipped to the map.
    const sx = Math.max(0, ox);
    const sy = Math.max(0, oy);
    const sw = Math.min(mapW, ox + W) - sx;
    const sh = Math.min(mapH, oy + H) - sy;
    if (sw > 0 && sh > 0) ctx.drawImage(this.baked.canvas, sx, sy, sw, sh, sx - ox, sy - oy, sw, sh);
    drawAnimatedTiles(ctx, lv, run.world, ox, oy, W, H, time, run.fx);
    this.drawPlatforms(ctx, run, alpha, ox, oy);

    this.drawEntities(ctx, run, ox, oy, time, false);
    this.drawPlayer(ctx, run, alpha, ox, oy, time);
    drawFalseWalls(ctx, lv, ox, oy);
    this.drawEntities(ctx, run, ox, oy, time, true);
    run.particles.draw(ctx, ox, oy);
    this.drawGrade(ctx, run.world);
    this.drawLights(ctx, run, ox, oy, time);

    if (run.fx.flash > 0) {
      ctx.globalAlpha = Math.min(0.35, run.fx.flash);
      ctx.fillStyle = run.fx.flashColor;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(this.vignetteCanvas(), 0, 0);
  }

  drawPlatforms(ctx, run, alpha, ox, oy) {
    const plat = platformSprite(run.world);
    for (const p of run.lv.platforms) {
      const x = p.prevX + (p.x - p.prevX) * alpha;
      const y = p.prevY + (p.y - p.prevY) * alpha;
      const px = Math.round((x - p.w / 2) * TILE - ox);
      const py = Math.round(y * TILE - oy);
      if (px > this.W || px + 48 < 0 || py > this.H || py + 12 < 0) continue;
      ctx.drawImage(plat, px, py);
      // Thruster glow flickers under the platform.
      ctx.fillStyle = Math.floor(run.time * 20) % 2 ? '#9ff6ff' : '#ffffff';
      ctx.fillRect(px + 8, py + 9, 2, 1);
      ctx.fillRect(px + 38, py + 9, 2, 1);
    }
  }

  drawPlayer(ctx, run, alpha, ox, oy, time) {
    const pl = run.player;
    const x = pl.prevX + (pl.x - pl.prevX) * alpha;
    const y = pl.prevY + (pl.y - pl.prevY) * alpha;
    // Drawn before the blink check, so it also marks where Nova is while she flickers.
    if (pl.alive && run.state !== 'gate') this.drawShadow(ctx, run, x, y, ox, oy);
    if (pl.invuln > 0 && pl.alive && Math.floor(pl.invuln * 14) % 2 === 1) return;
    const fr = novaFrame(pl, time);
    let sx = pl.sx;
    let sy = pl.sy;
    if (run.state === 'gate') {
      const k = Math.max(0, 1 - run.stateT * 1.1);
      sx *= k;
      sy *= k;
      if (k <= 0.02) return;
    }
    const w = Math.round(32 * sx);
    const h = Math.round(32 * sy);
    const px = Math.round(x * TILE - ox - w / 2);
    // Feet are at row 30 of the 32-px frame.
    const py = Math.round(y * TILE - oy - (30 / 32) * h);
    if (pl.assistT > 0 || pl.boostT > 0) {
      // Speed afterimage.
      ctx.globalAlpha = 0.3;
      ctx.drawImage(fr, px - Math.sign(pl.vx) * 6, py, w, h);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(fr, px, py, w, h);
    if (!pl.alive) {
      // Hull breached: sparks around Nova.
      ctx.fillStyle = Math.floor(time * 20) % 2 ? '#ffb547' : '#ff6b8b';
      ctx.fillRect(px + 6 + Math.floor(Math.random() * 20), py + 8 + Math.floor(Math.random() * 16), 1, 1);
    }
  }

  /** A contact shadow on the surface below Nova: it sets her on the ground
   * and, in the air, shows where she will land. It narrows and fades with
   * height, widens with her landing squash, and is absent over a pit. */
  drawShadow(ctx, run, x, y, ox, oy) {
    const lv = run.lv;
    const pl = run.player;
    let ground = pl.onGround ? y : -1;
    if (ground < 0) {
      const tx = Math.floor(x);
      if (tx >= 0 && tx < lv.w) {
        const row = groundBelow(lv, tx, Math.max(-1, Math.floor(y) - 1));
        if (row >= 0 && row >= y - 0.05) ground = row;
      }
      for (const p of lv.platforms) {
        if (Math.abs(x - p.x) <= p.w / 2 && p.y >= y - 0.05 && (ground < 0 || p.y < ground)) ground = p.y;
      }
    }
    if (ground < 0) return;
    const h = ground - y;
    if (h > 7) return;
    const k = 1 - Math.max(0, h) / 7;
    const w = Math.max(4, Math.round(16 * (0.5 + 0.5 * k) * pl.sx));
    const sx = Math.round(x * TILE - ox - w / 2);
    const sy = Math.round(ground * TILE - oy);
    ctx.globalAlpha = 0.1 + 0.32 * k;
    ctx.fillStyle = '#000000';
    ctx.fillRect(sx + 2, sy - 1, w - 4, 1);
    ctx.fillRect(sx, sy, w, 1);
    ctx.fillRect(sx + 2, sy + 1, w - 4, 1);
    ctx.globalAlpha = 1;
  }

  drawEntities(ctx, run, ox, oy, time, front) {
    const W = this.W;
    const H = this.H;
    const pal = run.palette;
    const mod = run.module;
    for (const e of run.entities) {
      const cx = e.x * TILE - ox;
      const cy = e.y * TILE - oy;
      if (cx < -60 || cx > W + 60 || cy < -90 || cy > H + 90) continue;
      const isFront = e.kind === 'critter' || e.kind === 'glitch-bot' || e.kind === 'spike';
      if (isFront !== front) continue;
      switch (e.kind) {
        case 'gem': {
          if (!e.active) break;
          const fr = gemFrames(pal.gem);
          const f = fr[Math.floor(e.t * 10) % fr.length];
          const bob = Math.round(Math.sin(e.t * 3) * 1.5);
          ctx.drawImage(f, Math.round(cx - 6), Math.round(cy - 6 + bob));
          break;
        }
        case 'human-pod':
        case 'si-pod': {
          if (!e.active) break;
          const s = podSprite(e.kind);
          const bob = Math.round(Math.sin(e.t * 2.4 + e.tx) * 2);
          ctx.drawImage(s, Math.round(cx - 7), Math.round(cy - 7 + bob));
          break;
        }
        case 'shortcut': {
          if (!e.active) break;
          const fr = shortcutFrames();
          const s = fr[Math.floor(e.t * 6) % 2];
          const bob = Math.round(Math.sin(e.t * 4) * 1.5);
          ctx.drawImage(s, Math.round(cx - 8), Math.round(cy - 8 + bob));
          break;
        }
        case 'beacon': {
          const s = beaconSprite(mod.color, !e.active);
          const bx = Math.round(cx - 9);
          const by = Math.round(e.ground * TILE - oy - 30);
          ctx.drawImage(s, bx, by);
          const rcx = Math.round(cx);
          const rcy = Math.round(e.ground * TILE - oy - 18);
          if (e.active) {
            // Scan ring: a faint full circle, filled clockwise with progress.
            ctx.fillStyle = mod.color;
            ctx.globalAlpha = 0.25 + 0.15 * Math.sin(time * 4);
            circle(ctx, rcx, rcy, 16);
            ctx.globalAlpha = 1;
            if (e.progress > 0) arc(ctx, rcx, rcy, 16, e.progress, '#ffffff');
          } else {
            ctx.fillStyle = mod.color;
            ctx.globalAlpha = 0.6;
            circle(ctx, rcx, rcy - Math.round(Math.sin(time * 2) * 2), 12);
            ctx.globalAlpha = 1;
          }
          break;
        }
        case 'terminal': {
          // A due terminal flashes amber; reviewed ones turn green.
          const state = !e.active ? 'done' : e.due ? 'due' : 'idle';
          const flashOff = state === 'due' && Math.floor(time * 5) % 3 === 2;
          const s = terminalSprite(flashOff ? 'idle' : state);
          ctx.drawImage(s, Math.round(cx - 9), Math.round(e.ground * TILE - oy - 26));
          if (e.active && e.progress > 0) bar(ctx, Math.round(cx - 8), Math.round(e.ground * TILE - oy - 32), 16, e.progress, '#ffb547');
          break;
        }
        case 'capsule': {
          const s = capsuleSprite(!e.active);
          const bx = Math.round(cx - 9);
          const by = Math.round(e.ground * TILE - oy - 28);
          ctx.drawImage(s, bx, by);
          if (e.active && e.progress > 0) bar(ctx, bx + 1, by - 6, 16, e.progress, '#ffcf7a');
          if (!e.active && e.freedT !== undefined && e.freedT < 1.4) {
            // The freed crew member beams up to safety.
            const k = e.freedT / 1.4;
            ctx.globalAlpha = 1 - k;
            ctx.fillStyle = '#fff3c0';
            ctx.fillRect(Math.round(cx - 3), 0, 6, by + 6);
            ctx.drawImage(crewSprite(), Math.round(cx - 5), Math.round(by - 4 - k * 60));
            ctx.globalAlpha = 1;
          }
          break;
        }
        case 'critter': {
          if (e.calm) {
            const fr = calmFrames();
            ctx.drawImage(fr[Math.floor(e.calmT * 4) % 2], Math.round(cx - 7), Math.round(cy - 7));
          } else {
            const fr = critterFrames();
            const set = e.dir < 0 ? fr.left : fr.right;
            ctx.drawImage(set[Math.floor(e.t * 8) % 2], Math.round(cx - 9), Math.round(e.feet * TILE - oy - 16));
          }
          break;
        }
        case 'glitch-bot': {
          const fr = botFrames();
          const stunned = e.stunT > 0;
          const s = stunned ? (e.dir < 0 ? fr.stunLeft : fr.stunRight) : (e.dir < 0 ? fr.left : fr.right)[Math.floor(e.t * 8) % 2];
          const bx = Math.round(cx - 9);
          const by = Math.round(e.feet * TILE - oy - 17);
          const glitch = !stunned && (e.t % 1.3) < 0.12;
          if (glitch) {
            // A brief horizontal tear: the bot's signature glitch.
            ctx.drawImage(s, 0, 0, 18, 7, bx + 2, by, 18, 7);
            ctx.drawImage(s, 0, 7, 18, 11, bx - 1, by + 7, 18, 11);
          } else ctx.drawImage(s, bx, by);
          if (stunned && Math.floor(time * 10) % 2) {
            ctx.fillStyle = '#66e1ff';
            ctx.fillRect(bx + 2 + Math.floor(Math.random() * 14), by - 2, 1, 1);
          }
          break;
        }
        case 'spike':
          ctx.drawImage(spikeSprite(), Math.round(e.tx * TILE - ox), Math.round(e.ty * TILE - oy));
          break;
        case 'checkpoint': {
          const lit = !e.active;
          const s = checkpointSprite(lit, pal.accent);
          ctx.drawImage(s, Math.round(cx - 7), Math.round(e.ground * TILE - oy - 34));
          break;
        }
        case 'gate': {
          const label = `G${run.levelIndex + 1}`;
          const s = gateSprite(label, mod.color);
          const gx = Math.round(cx - 36);
          const gy = Math.round(e.ground * TILE - oy - 84);
          drawPortal(ctx, gx, gy, mod.color, time, !e.active);
          ctx.drawImage(s, gx, gy);
          break;
        }
        default:
          break;
      }
    }
  }

  drawLights(ctx, run, ox, oy, time) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pal = run.palette;
    const W = this.W;
    const H = this.H;
    for (const e of run.entities) {
      const cx = e.x * TILE - ox;
      const cy = e.y * TILE - oy;
      if (cx < -40 || cx > W + 40 || cy < -60 || cy > H + 60) continue;
      let g = null;
      let r = 0;
      switch (e.kind) {
        case 'gem': if (e.active) { r = 10; g = glow(r, pal.gem[2], 0.55); } break;
        case 'si-pod': if (e.active) { r = 14; g = glow(r, '#66e1ff', 0.6); } break;
        case 'human-pod': if (e.active) { r = 14; g = glow(r, '#ffc24a', 0.6); } break;
        case 'shortcut': if (e.active) { r = 16; g = glow(r, '#ff3b4e', 0.7 + 0.2 * Math.sin(time * 8)); } break;
        case 'beacon': r = e.active ? 18 : 26; g = glow(r, run.module.color, e.active ? 0.45 : 0.8); break;
        case 'terminal': if (e.due || !e.active) { r = 14; g = glow(r, e.active ? '#ffb547' : '#2fdc8a', 0.5); } break;
        case 'checkpoint': if (!e.active) { r = 14; g = glow(r, pal.accent, 0.7); } break;
        case 'critter': if (e.calm) { r = 14; g = glow(r, '#7dffb8', 0.7); } break;
        case 'gate': r = 40; g = glow(r, run.module.color, 0.5 + 0.1 * Math.sin(time * 3)); break;
        default: break;
      }
      if (!g) continue;
      let ly = cy;
      if (e.kind === 'beacon') ly = e.ground * TILE - oy - 16;
      if (e.kind === 'checkpoint') ly = e.ground * TILE - oy - 29;
      if (e.kind === 'gate') ly = e.ground * TILE - oy - 40;
      ctx.drawImage(g, Math.round(cx - r), Math.round(ly - r));
    }
    const pl = run.player;
    if (pl.gliding || pl.state === 'jump') {
      const g = glow(8, '#ffc04a', 0.6);
      ctx.drawImage(g, Math.round(pl.x * TILE - ox - pl.facing * 7 - 8), Math.round((pl.y - 0.15) * TILE - oy - 8));
    }
    if (pl.pulseAnim > 0) {
      const g = glow(20, '#9ff6ff', pl.pulseAnim * 3);
      ctx.drawImage(g, Math.round(pl.x * TILE - ox - 20), Math.round(pl.centerY * TILE - oy - 20));
    }
    ctx.restore();
  }
}

function bar(ctx, x, y, w, p, color) {
  ctx.fillStyle = '#0a0c1e';
  ctx.fillRect(x - 1, y - 1, w + 2, 4);
  ctx.fillStyle = '#2a2f48';
  ctx.fillRect(x, y, w, 2);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.round(w * Math.min(1, p)), 2);
}

/** Pixel arc from 12 o'clock, clockwise, `p` of the full circle. */
function arc(ctx, cx, cy, r, p, color) {
  ctx.fillStyle = color;
  const n = Math.ceil(2 * Math.PI * r * 1.5 * p);
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / Math.max(1, n)) * p * Math.PI * 2;
    ctx.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r), 1, 1);
    ctx.fillRect(Math.round(cx + Math.cos(a) * (r - 1)), Math.round(cy + Math.sin(a) * (r - 1)), 1, 1);
  }
}

const portalCache = new Map();
function drawPortal(ctx, gx, gy, color, time, open) {
  const key = color;
  if (!portalCache.has(key)) {
    const frames = [];
    const cols = [mix(color, '#05030f', 0.8), mix(color, '#05030f', 0.55), color, mix(color, '#ffffff', 0.55)].map((c) => rgba(c));
    for (let f = 0; f < 8; f++) {
      const p = new Pix(72, 84);
      const cx = 36;
      const cy = 34;
      for (let y = 0; y < 84; y++) {
        for (let x = 0; x < 72; x++) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          const inside = y < cy ? Math.hypot(dx, dy) < 25.5 : Math.abs(dx) < 25.5 && y < 80;
          if (!inside) continue;
          const d = Math.hypot(dx, (y - 50) * 0.8);
          const a = Math.atan2(dy, dx);
          const v = Math.sin(d * 0.32 - (f / 8) * Math.PI * 2 + a * 2) * 0.5 + 0.5;
          const t = v * 0.85 + (1 - Math.min(1, d / 40)) * 0.35;
          const i = Math.min(3, Math.floor(t * 3 + bayer(x, y) * 0.9));
          p.set(x, y, cols[i]);
        }
      }
      frames.push(p.toCanvas());
    }
    portalCache.set(key, frames);
  }
  const fr = portalCache.get(key);
  ctx.globalAlpha = open ? 1 : 0.85;
  ctx.drawImage(fr[Math.floor(time * (open ? 18 : 10)) % 8], gx, gy);
  ctx.globalAlpha = 1;
}

const platCache = new Map();
function platformSprite(world) {
  if (platCache.has(world)) return platCache.get(world);
  const cols = {
    crystal: ['#ffd6fa', '#c044c0', '#6a2088'],
    rigs: ['#e2d6dc', '#8a7f88', '#3a3240'],
    biodome: ['#f0c27a', '#a86e3a', '#5a3418'],
    datacity: ['#e8fdff', '#2a8fb5', '#0f2a4a'],
    engineering: ['#ffe0a0', '#c97a22', '#4a3018'],
    station: ['#fff3c0', '#c3cbe0', '#6c7896'],
  }[world] || ['#ffffff', '#8b93b5', '#3a4060'];
  const p = new Pix(48, 11);
  const [a, b, c] = cols.map((h) => rgba(h));
  for (let x = 1; x < 47; x++) {
    p.set(x, 0, a);
    p.set(x, 1, b);
    p.set(x, 2, b);
    p.set(x, 3, x % 6 === 0 ? c : b);
    p.set(x, 4, c);
  }
  p.rect(0, 1, 1, 3, c);
  p.rect(47, 1, 1, 3, c);
  // Hover thrusters.
  p.rect(6, 5, 6, 3, rgba('#3a4060'));
  p.rect(36, 5, 6, 3, rgba('#3a4060'));
  p.rect(7, 5, 4, 1, rgba('#8b93b5'));
  p.rect(37, 5, 4, 1, rgba('#8b93b5'));
  p.outline(rgba('#0a0c1e'));
  const canvas = p.toCanvas();
  platCache.set(world, canvas);
  return canvas;
}
