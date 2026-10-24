// A tiny pixel-art toolkit. Every sprite, tile and backdrop in Nova Run is
// painted here at native resolution into a 32-bit buffer and cached as a
// canvas; there are no sprite files. Colours are packed ABGR (ImageData's
// little-endian layout) so a whole buffer can be written in one go.

export function rgba(hex, a = 255) {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function unpack(c) {
  return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255, (c >>> 24) & 255];
}

export function pack(r, g, b, a = 255) {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Mix two hex colours; returns a hex string. */
export function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => {
    const x = (pa >> s) & 255;
    const y = (pb >> s) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Ordered-dither threshold in [0, 1). */
export function bayer(x, y) {
  return (BAYER4[((y & 3) << 2) | (x & 3)] + 0.5) / 16;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of integer coordinates to [0, 1). */
export function hash2(x, y, s = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
export function noise(x, y, s = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s);
  const b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s);
  const d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, y, s = 0, oct = 4) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += noise(x * f, y * f, s + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Pick from a colour ramp with ordered dithering between neighbours. */
export function ramp(cols, t, x, y) {
  const n = cols.length;
  if (t <= 0) return cols[0];
  if (t >= 1) return cols[n - 1];
  const pos = t * (n - 1);
  const i = Math.floor(pos);
  return pos - i > bayer(x, y) ? cols[Math.min(n - 1, i + 1)] : cols[i];
}

export class Pix {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Uint32Array(w * h);
  }

  set(x, y, c) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.d[y * this.w + x] = c;
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.d[y * this.w + x];
  }

  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }

  /** Filled ellipse; `fn(x, y, nx, ny)` may return a colour per pixel (nx, ny in [-1, 1]). */
  ellipse(cx, cy, rx, ry, c) {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1) {
          const col = typeof c === 'function' ? c(x, y, nx, ny) : c;
          if (col) this.set(x, y, col);
        }
      }
    }
  }

  /** Filled polygon by pixel-centre test. */
  poly(pts, c) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i];
          const [xj, yj] = pts[j];
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) {
          const col = typeof c === 'function' ? c(x, y) : c;
          if (col) this.set(x, y, col);
        }
      }
    }
  }

  line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Thick line made of small squares. */
  stroke(x0, y0, x1, y1, w, c) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      this.ellipse(x, y, w / 2, w / 2, c);
    }
  }

  /** 1-px outline around every opaque pixel (4-neighbour, optionally 8). */
  outline(c, diagonal = false) {
    const src = this.d.slice();
    const W = this.w;
    const H = this.h;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (src[y * W + x]) continue;
        const o = (i, j) => i >= 0 && j >= 0 && i < W && j < H && src[j * W + i] !== 0;
        if (o(x - 1, y) || o(x + 1, y) || o(x, y - 1) || o(x, y + 1) ||
          (diagonal && (o(x - 1, y - 1) || o(x + 1, y - 1) || o(x - 1, y + 1) || o(x + 1, y + 1)))) {
          this.d[y * W + x] = c;
        }
      }
    }
  }

  /** Recolour opaque pixels: fn(x, y, c) → c. */
  map(fn) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        if (this.d[i]) this.d[i] = fn(x, y, this.d[i]);
      }
    }
  }

  blit(src, dx, dy) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const c = src.d[y * src.w + x];
        if (c) this.set(dx + x, dy + y, c);
      }
    }
  }

  toCanvas() {
    const c = makeCanvas(this.w, this.h);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(this.w, this.h);
    new Uint32Array(img.data.buffer).set(this.d);
    ctx.putImageData(img, 0, 0);
    return c;
  }
}

/** Mirror a canvas horizontally (for left-facing sprites). */
export function flipH(src) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  ctx.translate(src.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

/** A soft round glow sprite (for additive light), cached by key. Strength is
 * quantised to sixteenths: callers animate it with sin(time), and an exact
 * float key made a new canvas every frame and kept it forever (600 per 10 s
 * beside a gate). Sixteen steps bound the cache and look the same, since the
 * alpha is quantised again below. */
const glowCache = new Map();
export function glow(radius, hex, strength = 1) {
  strength = Math.round(strength * 16) / 16;
  const key = `${radius}|${hex}|${strength}`;
  if (glowCache.has(key)) return glowCache.get(key);
  const size = radius * 2;
  const p = new Pix(size, size);
  const [r, g, b] = unpack(rgba(hex));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - radius, y + 0.5 - radius) / radius;
      if (d >= 1) continue;
      // Quantised falloff keeps the glow looking pixel-art rather than airbrushed.
      const a = Math.round((1 - d) * (1 - d) * 4) / 4;
      const dither = a - Math.floor(a * 4) / 4 > bayer(x, y) * 0.25 ? 0.0625 : 0;
      const alpha = Math.min(255, Math.round((a + dither) * 200 * strength));
      if (alpha > 0) p.set(x, y, pack(r, g, b, alpha));
    }
  }
  const c = p.toCanvas();
  glowCache.set(key, c);
  return c;
}
