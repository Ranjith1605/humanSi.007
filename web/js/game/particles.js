// Particles: dust puffs, pickup sparkles, thruster sparks, debris, pulse
// rings, floating score pop-ups and per-world ambience. A fixed-size pool, no
// allocation per frame. Positions are internal pixels in world space.
// Reduced motion keeps the informative bits (pop-ups, rings) and drops the
// heavy decoration.

import { textSprite } from './font.js';

const MAX = 900;

export class Particles {
  constructor() {
    this.p = [];
    for (let i = 0; i < MAX; i++) this.p.push({ on: false });
    this.next = 0;
    this.rings = [];
    this.popups = [];
    this.reduced = false;
    this.ambientT = 0;
  }

  clear() {
    for (const q of this.p) q.on = false;
    this.rings.length = 0;
    this.popups.length = 0;
  }

  spawn(x, y, vx, vy, life, color, size = 1, gravity = 0, drag = 0, kind = 0) {
    const q = this.p[this.next];
    this.next = (this.next + 1) % MAX;
    q.on = true;
    q.x = x; q.y = y; q.vx = vx; q.vy = vy;
    q.life = life; q.max = life;
    q.color = color; q.size = size;
    q.g = gravity; q.drag = drag; q.kind = kind;
    return q;
  }

  burst(x, y, n, colors, speed = 60, life = 0.5, opts = {}) {
    if (this.reduced) n = Math.ceil(n / 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.spawn(x, y, Math.cos(a) * s, Math.sin(a) * s + (opts.up || 0), life * (0.6 + Math.random() * 0.6),
        colors[i % colors.length], opts.size || (Math.random() < 0.3 ? 2 : 1), opts.gravity || 0, opts.drag ?? 2.5, opts.kind || 0);
    }
  }

  dust(x, y, dir = 0, n = 5, color = '#d8d0e8') {
    if (this.reduced) n = Math.min(2, n);
    for (let i = 0; i < n; i++) {
      this.spawn(x + (Math.random() - 0.5) * 8, y - Math.random() * 2, -dir * (10 + Math.random() * 30) + (Math.random() - 0.5) * 20,
        -6 - Math.random() * 16, 0.3 + Math.random() * 0.25, color, Math.random() < 0.5 ? 2 : 1, -10, 3, 1);
    }
  }

  ring(x, y, maxR, color, life = 0.4) {
    this.rings.push({ x, y, r: 0, maxR, color, t: 0, life });
  }

  popup(x, y, text, color) {
    this.popups.push({ x, y, text, color, t: 0, life: 0.9 });
  }

  update(dt) {
    for (const q of this.p) {
      if (!q.on) continue;
      q.life -= dt;
      if (q.life <= 0) { q.on = false; continue; }
      q.vy += q.g * dt;
      const d = Math.max(0, 1 - q.drag * dt);
      q.vx *= d;
      q.vy *= d;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      r.r = r.maxR * Math.min(1, r.t / r.life) ** 0.6;
      if (r.t >= r.life) this.rings.splice(i, 1);
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const u = this.popups[i];
      u.t += dt;
      if (u.t >= u.life) this.popups.splice(i, 1);
    }
  }

  /** Per-world ambience spawned around the view. */
  ambient(dt, kind, colors, rate, ox, oy, vw, vh) {
    if (this.reduced && kind !== 'rain') return;
    this.ambientT += dt * rate * (this.reduced ? 0.3 : 1);
    while (this.ambientT >= 1) {
      this.ambientT -= 1;
      const c = colors[Math.floor(Math.random() * colors.length)];
      const x = ox + Math.random() * vw;
      const y = oy + Math.random() * vh;
      switch (kind) {
        case 'rain':
          this.spawn(ox + Math.random() * (vw + 80), oy - 10, -40, 260 + Math.random() * 80, 1.4, c, 1, 0, 0, 2);
          break;
        case 'motes':
          this.spawn(x, y, (Math.random() - 0.5) * 6, -4 - Math.random() * 6, 2.5 + Math.random() * 2, c, 1, 0, 0, 3);
          break;
        case 'pollen':
          this.spawn(x, y, 6 + Math.random() * 8, (Math.random() - 0.5) * 6, 3 + Math.random() * 2, c, 1, 0, 0, 3);
          break;
        case 'sparks':
          this.spawn(x, oy - 4, (Math.random() - 0.5) * 20, 30 + Math.random() * 40, 1.6, c, 1, 40, 0, 0);
          break;
        case 'embers':
          this.spawn(x, oy + vh + 4, (Math.random() - 0.5) * 10, -20 - Math.random() * 20, 3, c, 1, 0, 0, 3);
          break;
        case 'twinkle':
          this.spawn(x, y, 0, 0, 0.6 + Math.random() * 0.6, c, 1, 0, 0, 4);
          break;
        default:
          break;
      }
    }
  }

  draw(ctx, ox, oy) {
    for (const q of this.p) {
      if (!q.on) continue;
      const x = Math.round(q.x - ox);
      const y = Math.round(q.y - oy);
      if (x < -8 || y < -8 || x > ctx.canvas.width + 8 || y > ctx.canvas.height + 8) continue;
      const t = q.life / q.max;
      ctx.fillStyle = q.color;
      if (q.kind === 1) {
        // Dust: fades out.
        ctx.globalAlpha = Math.min(1, t * 1.5) * 0.8;
        ctx.fillRect(x, y, q.size, q.size);
      } else if (q.kind === 2) {
        ctx.globalAlpha = 0.45;
        ctx.fillRect(x, y, 1, 4);
      } else if (q.kind === 3) {
        ctx.globalAlpha = Math.sin(t * Math.PI) * 0.8;
        ctx.fillRect(x, y, q.size, q.size);
      } else if (q.kind === 4) {
        ctx.globalAlpha = Math.sin(t * Math.PI);
        ctx.fillRect(x, y, 1, 1);
        if (t > 0.4 && t < 0.6) {
          ctx.fillRect(x - 1, y, 3, 1);
          ctx.fillRect(x, y - 1, 1, 3);
        }
      } else {
        ctx.globalAlpha = t < 0.3 ? t / 0.3 : 1;
        const s = t > 0.6 ? q.size : 1;
        ctx.fillRect(x, y, s, s);
      }
    }
    ctx.globalAlpha = 1;
    for (const r of this.rings) {
      const a = 1 - r.t / r.life;
      const cx = Math.round(r.x - ox);
      const cy = Math.round(r.y - oy);
      ctx.fillStyle = r.color;
      ctx.globalAlpha = a;
      circle(ctx, cx, cy, Math.round(r.r));
      circle(ctx, cx, cy, Math.round(r.r) - 1);
      ctx.globalAlpha = a * 0.45;
      circle(ctx, cx, cy, Math.round(r.r * 0.7));
    }
    ctx.globalAlpha = 1;
    for (const u of this.popups) {
      const s = textSprite(u.text, u.color);
      const rise = Math.min(1, u.t / 0.35);
      const y = Math.round(u.y - oy - 6 - rise * 12);
      ctx.globalAlpha = u.t > u.life - 0.25 ? (u.life - u.t) / 0.25 : 1;
      ctx.drawImage(s, Math.round(u.x - ox - s.width / 2), y);
    }
    ctx.globalAlpha = 1;
  }
}

/** Pixel-exact circle outline (midpoint algorithm), so rings stay crisp. */
export function circle(ctx, cx, cy, r) {
  if (r <= 0) return;
  let x = r;
  let y = 0;
  let err = 1 - r;
  while (x >= y) {
    ctx.fillRect(cx + x, cy + y, 1, 1);
    ctx.fillRect(cx + y, cy + x, 1, 1);
    ctx.fillRect(cx - y, cy + x, 1, 1);
    ctx.fillRect(cx - x, cy + y, 1, 1);
    ctx.fillRect(cx - x, cy - y, 1, 1);
    ctx.fillRect(cx - y, cy - x, 1, 1);
    ctx.fillRect(cx + y, cy - x, 1, 1);
    ctx.fillRect(cx + x, cy - y, 1, 1);
    y++;
    if (err < 0) err += 2 * y + 1;
    else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
}
