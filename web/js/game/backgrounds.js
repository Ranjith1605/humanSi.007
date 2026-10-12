// Parallax backdrops: a dithered sky plus three or four painted layers per
// world, each a horizontally seamless strip that scrolls at its own rate, and
// a few animated overlays (light shafts, rain, steam, star trails, warning
// lights). Painted once per world with the pixel toolkit.

import { Pix, rgba, bayer, hash2, mulberry32, ramp, mix, unpack, pack } from './paint.js';

const LW = 768;
const LH = 300;
const C = (h) => rgba(h);

/** A Pix whose x coordinate wraps, so shapes cross the seam cleanly. */
class WPix extends Pix {
  set(x, y, c) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (y < 0 || y >= this.h) return;
    x = ((x % this.w) + this.w) % this.w;
    this.d[y * this.w + x] = c;
  }
}

/** Value noise that repeats every `period` lattice cells along x. */
function pnoise(x, y, period, s) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (i) => ((i % period) + period) % period;
  const a = hash2(w(xi), yi, s);
  const b = hash2(w(xi + 1), yi, s);
  const c = hash2(w(xi), yi + 1, s);
  const d = hash2(w(xi + 1), yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function pfbm(x, y, period, s, oct = 4) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    sum += pnoise(x * f, y * f, period * f, s + i * 13) * amp;
    n += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / n;
}

// ------------------------------------------------------------- skies ----

const SKY = {
  crystal: ['#06020e', '#0f0520', '#1a0832', '#280c44', '#371154', '#46165e'],
  rigs: ['#020207', '#05050d', '#0a0915', '#120e1d', '#1d1322', '#2a1820'],
  biodome: ['#1f5a9a', '#2c74b4', '#3f92c8', '#62b2d6', '#92d2e0', '#c4ecdc'],
  datacity: ['#02040c', '#050b1c', '#08142e', '#0c2142', '#113256', '#18486a'],
  engineering: ['#080402', '#120804', '#1c0e06', '#28140a', '#351b0c', '#44230e'],
  station: ['#010106', '#02040c', '#040918', '#071026', '#0b1834', '#102244'],
};

const HAZE = {
  crystal: '#3a1458',
  rigs: '#1a1422',
  biodome: '#8ccfd8',
  datacity: '#10304e',
  engineering: '#3a200c',
  station: '#0b1834',
};

const STARS = { crystal: 0.004, rigs: 0.006, biodome: 0, datacity: 0.0015, engineering: 0, station: 0.007 };

const skyCache = new Map();
export function skyCanvas(world, w, h) {
  const key = `${world}|${w}|${h}`;
  if (skyCache.has(key)) return skyCache.get(key);
  const cols = SKY[world].map(C);
  const p = new Pix(w, h);
  const star = C('#ffffff');
  const star2 = C(world === 'crystal' ? '#ffb8f4' : '#bfe6ff');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = Math.pow(y / Math.max(1, h - 1), 0.9);
      let c = ramp(cols, t, x, y);
      const r = hash2(x, y, 7);
      if (r < STARS[world]) c = r < STARS[world] * 0.3 ? star : star2;
      p.d[y * w + x] = c;
    }
  }
  if (world === 'biodome') {
    // The dome's frame: faint lattice arcs across the sky.
    const line = C('#8cc4e0');
    for (let k = -2; k < 6; k++) {
      const cx = (k * w) / 3;
      for (let x = 0; x < w; x++) {
        const y = Math.round(h * 0.15 + Math.pow((x - cx) / w, 2) * h * 1.4);
        if (y >= 0 && y < h && x % 3 === 0) p.set(x, y, line);
      }
    }
    for (let x = 0; x < w; x += 96) for (let y = 0; y < h * 0.6; y += 3) p.set(x + Math.round(y * 0.08), y, line);
  }
  const c = p.toCanvas();
  if (skyCache.size > 12) skyCache.clear();
  skyCache.set(key, c);
  return c;
}

// ------------------------------------------------------------ helpers ----

function spire(p, x, base, w, h, body, edge, tip) {
  p.poly([[x - w, base], [x - w * 0.7, base - h * 0.75], [x, base - h], [x + w * 0.7, base - h * 0.75], [x + w, base]], (px, py) => {
    if (px < x - w * 0.5 && py < base - 2) return edge;
    return body;
  });
  if (tip) {
    for (let j = 0; j < 4; j++) p.set(x, base - h + j, tip);
  }
}

function tower(p, rnd, x, base, w, h, body, edge, wins) {
  for (let y = base - h; y < LH; y++) {
    for (let i = 0; i < w; i++) {
      let c = body;
      if (i === 0) c = edge;
      const wy = y - (base - h);
      if (wins && i > 1 && i < w - 2 && wy > 3 && wy % 4 === 0 && i % 3 === 0 && hash2(x + i, y, 33) < 0.45) {
        c = wins[Math.floor(hash2(x + i, y, 35) * wins.length)];
      }
      p.set(x + i, y, c);
    }
  }
  // Antenna or roof step.
  if (rnd() < 0.5) p.rect(x + Math.floor(w / 2), base - h - 6, 1, 6, edge);
  else p.rect(x + 2, base - h - 3, w - 4, 3, body);
}

function girderTower(p, x, base, w, h, col, light) {
  for (let y = base - h; y < LH; y++) {
    p.set(x, y, col);
    p.set(x + w, y, col);
    const ly = (y - (base - h)) % w;
    p.set(x + ly, y, col);
    p.set(x + w - ly, y, col);
    if (ly === 0) for (let i = 0; i <= w; i++) p.set(x + i, y, col);
  }
  if (light) {
    p.rect(x + Math.floor(w / 2) - 1, base - h - 3, 3, 3, light);
  }
}

function gear(p, cx, cy, r, teeth, col, hole) {
  for (let y = Math.floor(cy - r - 4); y <= cy + r + 4; y++) {
    for (let x = Math.floor(cx - r - 4); x <= cx + r + 4; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const tooth = Math.cos(a * teeth) > 0.3 ? 4 : 0;
      if (d <= r + tooth && d > r * 0.35) p.set(x, y, col);
      else if (d <= r * 0.35 && hole) p.set(x, y, hole);
    }
  }
}

// --------------------------------------------------------- per world ----

function layersFor(world) {
  const rnd = mulberry32(world.length * 7919 + 13);
  const L = [];
  // Atmospheric perspective: farther layers are pulled towards the haze
  // colour, so the playfield always reads in front of the backdrop.
  const haze = unpack(C(HAZE[world]));
  const add = (fx, fy, paint, fog = 0) => {
    const p = new WPix(LW, LH);
    paint(p);
    if (fog > 0) {
      p.map((x, y, c) => {
        const [r, g, b, a] = unpack(c);
        return pack(Math.round(r + (haze[0] - r) * fog), Math.round(g + (haze[1] - g) * fog), Math.round(b + (haze[2] - b) * fog), a);
      });
    }
    L.push({ canvas: p.toCanvas(), fx, fy });
  };

  switch (world) {
    case 'crystal': {
      add(0.05, 0.03, (p) => {
        const cols = [0, C('#3a1258'), C('#5c1c78'), C('#8a2a90'), C('#c04aa8'), C('#ff8ad8')];
        for (let y = 0; y < LH; y++) {
          for (let x = 0; x < LW; x++) {
            const n = pfbm(x / 96, y / 64, LW / 96, 3, 5);
            const band = 1 - Math.abs(y / LH - 0.42) * 2.2;
            const v = n * 0.9 + band * 0.45 - 0.35;
            if (v <= 0.18) continue;
            p.set(x, y, ramp(cols, Math.min(1, (v - 0.18) * 1.6), x, y) || 0);
          }
        }
      });
      add(0.18, 0.08, (p) => {
        for (let k = 0; k < 16; k++) {
          const x = rnd() * LW;
          const h = 70 + rnd() * 140;
          spire(p, x, LH, 10 + rnd() * 16, h, C('#22093a'), C('#3c1462'), rnd() < 0.5 ? C('#ff7ae0') : 0);
        }
        p.rect(0, LH - 30, LW, 30, C('#22093a'));
      }, 0.35);
      add(0.36, 0.16, (p) => {
        // Cave ceiling teeth.
        for (let x = 0; x < LW; x++) {
          const h = 10 + pfbm(x / 40, 1, LW / 40, 5, 3) * 40 + (hash2(x >> 3, 1, 9) < 0.15 ? 30 : 0);
          for (let y = 0; y < h; y++) p.set(x, y, y > h - 2 ? C('#4a1a6e') : C('#150624'));
        }
        // Crystal clusters glowing on the cave floor.
        for (let k = 0; k < 9; k++) {
          const cx = rnd() * LW;
          const base = LH - 30 - rnd() * 20;
          const n = 3 + Math.floor(rnd() * 3);
          for (let j = 0; j < n; j++) {
            const x = cx + (j - n / 2) * (5 + rnd() * 4);
            const h = 14 + rnd() * 34 * (1 - Math.abs(j - n / 2) / n);
            const w = 3 + rnd() * 3;
            const lean = (j - n / 2) * 2.5;
            p.poly([[x - w, base], [x - w + lean * 0.6, base - h * 0.8], [x + lean, base - h], [x + w + lean * 0.6, base - h * 0.8], [x + w, base]], (px, py) => {
              if (px < x + lean * 0.3 - 0.5) return py < base - h * 0.75 ? C('#ffd6fa') : C('#c044c0');
              return py < base - h * 0.75 ? C('#ff7ae0') : C('#7a2a90');
            });
          }
        }
        for (let x = 0; x < LW; x++) {
          const h = 18 + pfbm(x / 30, 3, LW / 30, 6, 3) * 34;
          for (let y = LH - h; y < LH; y++) p.set(x, y, C('#1a0730'));
        }
      }, 0.4);
      add(0.62, 0.3, (p) => {
        for (let k = 0; k < 7; k++) {
          const x = rnd() * LW;
          spire(p, x, LH, 8 + rnd() * 10, 30 + rnd() * 50, C('#0c0316'), C('#2a0c44'), 0);
        }
      });
      break;
    }
    case 'rigs': {
      add(0.04, 0.02, (p) => {
        for (let k = 0; k < 9; k++) {
          const cx = rnd() * LW;
          const cy = 20 + rnd() * 160;
          const r = 6 + rnd() * 26;
          p.ellipse(cx, cy, r, r * 0.9, (x, y, nx, ny) => {
            const d = nx * 0.6 + ny * 0.7;
            const crater = hash2(Math.floor(x / 4), Math.floor(y / 4), 17) < 0.12;
            if (crater) return C('#2a1610');
            return d > 0.35 ? C('#2e1a14') : d < -0.4 ? C('#7a4a32') : C('#4a2c1e');
          });
        }
      }, 0.15);
      add(0.16, 0.06, (p) => {
        for (let k = 0; k < 9; k++) {
          const x = Math.floor(rnd() * LW);
          girderTower(p, x, LH - 40 - rnd() * 120, 8 + Math.floor(rnd() * 3) * 2, 120 + rnd() * 80, C('#1c1e2c'), C('#ff3b3b'));
        }
        // Short scaffold decks between the towers.
        for (let k = 0; k < 4; k++) {
          const y = 120 + Math.floor(rnd() * 120);
          const x = rnd() * LW;
          const len = 40 + rnd() * 60;
          for (let i = 0; i < len; i++) {
            p.set(x + i, y, C('#2a2e40'));
            p.set(x + i, y + 4, C('#1c1e2c'));
            if (i % 8 < 1) for (let j = 0; j < 4; j++) p.set(x + i, y + j, C('#1c1e2c'));
            else p.set(x + i, y + 1 + ((i % 8) >> 1) % 3, C('#1c1e2c'));
          }
        }
      }, 0.3);
      add(0.34, 0.14, (p) => {
        // Hanging cables and hooks.
        for (let k = 0; k < 10; k++) {
          const x = Math.floor(rnd() * LW);
          const len = 30 + rnd() * 120;
          for (let y = 0; y < len; y++) p.set(x, y, C('#2a2430'));
          p.rect(x - 3, len, 7, 3, C('#5a3a2a'));
          p.rect(x + 2, len + 3, 2, 4, C('#5a3a2a'));
        }
        for (let x = 0; x < LW; x++) {
          const h = 20 + pfbm(x / 50, 2, LW / 50, 8, 3) * 40;
          for (let y = LH - h; y < LH; y++) p.set(x, y, y < LH - h + 2 ? C('#4a2c22') : C('#160f14'));
        }
      }, 0.12);
      add(0.6, 0.28, (p) => {
        for (let k = 0; k < 3; k++) {
          const x = Math.floor(rnd() * LW);
          girderTower(p, x, LH - 10 - rnd() * 30, 14, 60, C('#08070c'), 0);
        }
      });
      break;
    }
    case 'biodome': {
      add(0.05, 0.03, (p) => {
        for (const [base, amp, col, top, s] of [[205, 36, '#6ab79a', '#a8dcc4', 1], [238, 40, '#4a9a72', '#7cc8a0', 2]]) {
          for (let x = 0; x < LW; x++) {
            const h = base - pfbm(x / 110, s, LW / 110, s * 5, 4) * amp * 2;
            for (let y = Math.floor(h); y < LH; y++) p.set(x, y, y < h + 1 ? C(top) : C(col));
          }
        }
      }, 0.2);
      add(0.2, 0.08, (p) => {
        // Water with sparkles at the bottom.
        for (let y = LH - 46; y < LH; y++) {
          for (let x = 0; x < LW; x++) {
            const sp = hash2(x >> 2, y, 41) < 0.04 && y % 3 === 0;
            p.set(x, y, sp ? C('#e8fcff') : y < LH - 44 ? C('#a8ecf8') : ramp([C('#4ab8d8'), C('#2a8ab8'), C('#1a6a9a')], (y - LH + 46) / 46, x, y));
          }
        }
        // Rounded trees on the far shore.
        for (let k = 0; k < 22; k++) {
          const x = rnd() * LW;
          const base = LH - 46;
          const r = 12 + rnd() * 18;
          p.rect(x - 1, base - r, 3, r, C('#5a3a22'));
          p.ellipse(x, base - r - r * 0.4, r, r * 0.8, (px, py, nx, ny) => {
            const d = nx * 0.5 + ny * 0.8;
            if (hash2(px >> 1, py >> 1, 43) < 0.05) return C('#9aff8a');
            return d > 0.3 ? C('#1f7a3a') : d < -0.5 ? C('#5ad86a') : C('#2e9a4a');
          });
        }
      }, 0.12);
      add(0.42, 0.18, (p) => {
        // Big fern fronds rising from the bottom.
        for (let k = 0; k < 9; k++) {
          const x = rnd() * LW;
          const h = 60 + rnd() * 70;
          const lean = (rnd() - 0.5) * 50;
          for (let i = 0; i < h; i++) {
            const t = i / h;
            const cx = x + lean * t * t;
            const y = LH - i;
            p.set(cx, y, C('#14502a'));
            const leaf = (1 - t) * 14 + 2;
            if (i % 5 === 0) {
              for (let j = 0; j < leaf; j++) {
                p.set(cx - j, y - j * 0.4, C('#1a6a34'));
                p.set(cx + j, y - j * 0.4, C('#1a6a34'));
              }
            }
          }
        }
        for (let x = 0; x < LW; x++) {
          const h = 10 + pfbm(x / 26, 5, LW / 26, 12, 3) * 26;
          for (let y = LH - h; y < LH; y++) p.set(x, y, C('#0f4022'));
        }
      });
      add(0.7, 0.32, (p) => {
        // Hanging vines from the dome's top.
        for (let k = 0; k < 12; k++) {
          const x = rnd() * LW;
          const len = 20 + rnd() * 70;
          for (let y = 0; y < len; y++) {
            const sx = x + Math.sin(y / 9 + k) * 2;
            p.set(sx, y, C('#0e3a1e'));
            if (y % 7 === 3) { p.set(sx + 1, y, C('#1a6a34')); p.set(sx + 2, y + 1, C('#1a6a34')); }
          }
        }
      });
      break;
    }
    case 'datacity': {
      const wins = [C('#66e1ff'), C('#2a8fb5'), C('#ff6bd5'), C('#2a6a9a')];
      add(0.06, 0.03, (p) => {
        let x = 0;
        while (x < LW) {
          const w = 14 + Math.floor(rnd() * 22);
          tower(p, rnd, x, LH - 70 - rnd() * 120, w, 0, C('#0a1630'), C('#12224a'), [C('#1f5a8a'), C('#2a3a6a')]);
          x += w + Math.floor(rnd() * 6);
        }
      }, 0.3);
      add(0.2, 0.08, (p) => {
        let x = 0;
        while (x < LW) {
          const w = 20 + Math.floor(rnd() * 26);
          const top = LH - 60 - rnd() * 150;
          tower(p, rnd, x, top, w, 0, C('#0c1c3a'), C('#24508a'), wins);
          if (rnd() < 0.55) {
            // Neon sign: a vertical glowing strip (never horizontal, so it
            // cannot be mistaken for a platform).
            const col = rnd() < 0.5 ? C('#ff6bd5') : C('#66e1ff');
            const sx = x + 3 + Math.floor(rnd() * Math.max(1, w - 8));
            const sy = top + 8 + Math.floor(rnd() * 30);
            const sh = 18 + Math.floor(rnd() * 26);
            p.rect(sx, sy, 4, sh, col);
            for (let j = 2; j < sh - 2; j += 4) p.rect(sx + 1, sy + j, 2, 2, C('#ffffff'));
          }
          x += w + 4 + Math.floor(rnd() * 20);
        }
      }, 0.12);
      add(0.4, 0.16, (p) => {
        // Sky bridges (dim, so they never read as platforms) and a near tower row.
        for (let k = 0; k < 3; k++) {
          const y = 40 + Math.floor(rnd() * 90);
          const x = rnd() * LW;
          const len = 90 + rnd() * 140;
          for (let i = 0; i < len; i++) {
            p.set(x + i, y, C('#1f5a8a'));
            p.set(x + i, y + 1, C('#0a1630'));
            p.set(x + i, y + 2, C('#0a1630'));
          }
        }
        let x = 0;
        while (x < LW) {
          const w = 30 + Math.floor(rnd() * 30);
          tower(p, rnd, x, LH - 30 - rnd() * 60, w, 0, C('#060e20'), C('#66e1ff'), [C('#123a5e'), C('#ff6bd5')]);
          x += w + 30 + Math.floor(rnd() * 60);
        }
      });
      break;
    }
    case 'engineering': {
      add(0.05, 0.03, (p) => {
        for (let k = 0; k < 7; k++) {
          gear(p, rnd() * LW, 40 + rnd() * 200, 18 + rnd() * 30, 8 + Math.floor(rnd() * 6), C('#24130a'), C('#1a0e06'));
        }
      }, 0.15);
      add(0.18, 0.07, (p) => {
        // Tanks with amber rim light.
        for (let k = 0; k < 6; k++) {
          const x = rnd() * LW;
          const w = 30 + rnd() * 30;
          const top = LH - 80 - rnd() * 110;
          for (let y = Math.floor(top); y < LH; y++) {
            for (let i = 0; i < w; i++) {
              const nx = (i / w) * 2 - 1;
              p.set(x + i, y, nx < -0.8 ? C('#8a5a22') : nx > 0.6 ? C('#1e1108') : C('#2e1a0c'));
            }
          }
          p.ellipse(x + w / 2, top, w / 2, 6, C('#3a2210'));
          for (let i = 0; i < w; i += 2) p.set(x + i, top + 18, C('#5a3a18'));
        }
      }, 0.2);
      add(0.36, 0.15, (p) => {
        // Pipe runs.
        const pipe = (x0, y0, len, horiz) => {
          for (let i = 0; i < len; i++) {
            for (let j = 0; j < 8; j++) {
              const c = j === 1 ? C('#e8a04a') : j === 0 || j === 7 ? C('#2a1608') : j > 5 ? C('#5a3410') : C('#8a5a22');
              if (horiz) p.set(x0 + i, y0 + j, c); else p.set(x0 + j, y0 + i, c);
            }
            if (i % 40 === 0) {
              for (let j = -1; j < 9; j++) {
                if (horiz) { p.set(x0 + i, y0 + j, C('#c98a3a')); p.set(x0 + i + 1, y0 + j, C('#5a3410')); }
                else { p.set(x0 + j, y0 + i, C('#c98a3a')); p.set(x0 + j, y0 + i + 1, C('#5a3410')); }
              }
            }
          }
        };
        for (let k = 0; k < 5; k++) pipe(rnd() * LW, 30 + Math.floor(rnd() * 180), 160 + rnd() * 260, true);
        for (let k = 0; k < 6; k++) pipe(rnd() * LW, Math.floor(rnd() * 120), 80 + rnd() * 200, false);
        for (let x = 0; x < LW; x++) {
          const h = 16 + ((x >> 5) % 3) * 8;
          for (let y = LH - h; y < LH; y++) p.set(x, y, y === LH - h ? C('#ffb547') : C('#1c0f06'));
        }
      }, 0.38);
      add(0.64, 0.3, (p) => {
        // Conveyor belt with crates near the bottom.
        const y = LH - 44;
        for (let x = 0; x < LW; x++) {
          p.set(x, y, C('#3a2410'));
          p.set(x, y + 1, (x >> 2) % 2 ? C('#120a04') : C('#5a3a18'));
          p.set(x, y + 2, C('#120a04'));
          if (x % 24 < 2) for (let j = 3; j < 44; j++) p.set(x, y + j, C('#0e0804'));
        }
        for (let k = 0; k < 8; k++) {
          const x = rnd() * LW;
          const s = 10 + Math.floor(rnd() * 8);
          p.rect(x, y - s, s, s, C('#0e0804'));
          p.rect(x + 1, y - s + 1, s - 2, 1, C('#3a2410'));
        }
      });
      break;
    }
    case 'station': {
      add(0.12, 0.05, (p) => {
        // Distant station modules with solar wings, high in the sky.
        for (let k = 0; k < 4; k++) {
          const x = rnd() * LW;
          const y = 24 + rnd() * 90;
          const w = 34 + rnd() * 30;
          p.rect(x, y, w, 12, C('#5a6488'));
          p.rect(x, y, w, 2, C('#a6b0ca'));
          p.rect(x, y + 10, w, 2, C('#3a4266'));
          for (let i = 4; i < w; i += 6) p.set(x + i, y + 5, C('#ffe9b0'));
          const pw = 34 + rnd() * 30;
          for (const side of [-1, 1]) {
            const px0 = side < 0 ? x - pw - 5 : x + w + 5;
            p.rect(side < 0 ? x - 5 : x + w, y + 5, 5, 2, C('#a6b0ca'));
            for (let i = 0; i < pw; i++) {
              for (let j = -6; j < 18; j++) {
                const grid = i % 6 === 0 || (j + 6) % 6 === 0;
                p.set(px0 + i, y + j, grid ? C('#8a7a3a') : C('#1a2a5a'));
              }
            }
          }
        }
      }, 0.4);
      add(0.34, 0.14, (p) => {
        // Antenna masts and docking spires rising from below.
        for (let k = 0; k < 7; k++) {
          const x = Math.floor(rnd() * LW);
          const h = 60 + rnd() * 120;
          const w = 4 + Math.floor(rnd() * 3) * 2;
          for (let y = LH - h; y < LH; y++) {
            for (let i = 0; i < w; i++) p.set(x + i, y, i === 0 ? C('#a6b0ca') : C('#3a4266'));
            if ((y - (LH - h)) % 10 === 0) p.rect(x - 2, y, w + 4, 2, C('#c99a2e'));
          }
          p.rect(x + w / 2 - 1, LH - h - 8, 2, 8, C('#a6b0ca'));
          p.rect(x + w / 2 - 2, LH - h - 10, 4, 2, C('#ffcf7a'));
          // A pod halfway up.
          if (rnd() < 0.6) {
            const py = LH - h * 0.6;
            p.ellipse(x + w / 2, py, 9, 6, (px, py2, nx, ny) => (nx < -0.4 ? C('#e6ebf7') : ny > 0.4 ? C('#3a4266') : C('#8e98b4')));
            p.rect(x + w / 2 - 5, py - 1, 10, 1, C('#66e1ff'));
          }
        }
        for (let x = 0; x < LW; x++) {
          const h = 12 + ((x >> 6) % 2) * 8;
          for (let y = LH - h; y < LH; y++) p.set(x, y, y < LH - h + 1 ? C('#8e98b4') : C('#1e2440'));
        }
      }, 0.3);
      break;
    }
    default:
      break;
  }
  return L;
}

const layerCache = new Map();
export function backgroundLayers(world) {
  if (!layerCache.has(world)) layerCache.set(world, layersFor(world));
  return layerCache.get(world);
}

let planetCache = null;
function planetCanvas() {
  if (planetCache) return planetCache;
  const R = 112;
  const p = new Pix(R * 2 + 16, R * 2 + 16);
  const c0 = R + 8;
  const night = '#060c22';
  for (let y = 0; y < p.h; y++) {
    for (let x = 0; x < p.w; x++) {
      const dx = (x + 0.5 - c0) / R;
      const dy = (y + 0.5 - c0) / R;
      const d = Math.hypot(dx, dy);
      if (d > 1.06) continue;
      // Light from the upper left.
      const z = d <= 1 ? Math.sqrt(1 - d * d) : 0;
      const light = d <= 1 ? Math.max(0, dx * -0.55 + dy * -0.45 + z * 0.7) : Math.max(0, dx * -0.6 + dy * -0.5);
      if (d > 1) {
        // Atmosphere halo, dithered.
        if (light > 0.05 && bayer(x, y) < (1.06 - d) * 14 * Math.min(1, light * 2)) p.set(x, y, C('#6fc4ff'));
        continue;
      }
      // Sphere mapping, so features curve with the surface.
      const u = Math.atan2(dx, z) * 2.4;
      const v = Math.asin(dy) * 2.4;
      const land = pfbm(u * 1.7 + 9, v * 1.7 + 9, 1000, 71, 5);
      const cloud = pfbm(u * 2.6 + 3, v * 5.5 + 3, 1000, 73, 4);
      let col;
      if (land > 0.57) col = land > 0.69 ? '#c8b47a' : land > 0.63 ? '#6a9a4a' : '#3f8f58';
      else col = land > 0.53 ? '#3a8ad8' : '#2458b8';
      if (cloud > 0.6 || (cloud > 0.565 && bayer(x, y) < (cloud - 0.565) / 0.035)) col = '#f2f6ff';
      // Terminator: quantised light bands with dithering between them.
      const l = light + (bayer(x, y) - 0.5) * 0.12;
      if (l < 0.12) col = mix(col, night, 0.85);
      else if (l < 0.25) col = mix(col, night, 0.55);
      else if (l < 0.4) col = mix(col, night, 0.25);
      if (d > 0.95) col = mix(col, '#8fd8ff', 0.45);
      p.set(x, y, C(mix(col, '#0b1834', 0.18)));
    }
  }
  planetCache = p.toCanvas();
  return planetCache;
}

// ------------------------------------------------------------ drawing ----

/**
 * Draw sky and parallax layers. `camX`, `camY` are the view origin in
 * internal pixels; `mapH` is the map height in pixels; `progress` is how far
 * along the level the view is (0..1), used by the rising planet.
 */
export function drawBackground(ctx, world, camX, camY, vw, vh, mapH, progress, time) {
  ctx.drawImage(skyCanvas(world, vw, vh), 0, 0);
  const lift = Math.max(0, mapH - vh - camY); // how far above the map's floor the view is
  if (world === 'station') {
    const pc = planetCanvas();
    const px = Math.round(vw * 0.62 - pc.width / 2 - camX * 0.02);
    // The planet rises as the level progresses.
    const py = Math.round(vh - 70 - progress * 140 + lift * 0.03);
    ctx.drawImage(pc, px, py);
  }
  for (const L of backgroundLayers(world)) {
    const x = -Math.round((camX * L.fx) % LW);
    const y = Math.round(vh - LH + lift * L.fy);
    for (let k = x - LW; k < vw; k += LW) if (k + LW > 0) ctx.drawImage(L.canvas, k, y);
    // Below a layer (tall views looking up), continue its bottom colour.
  }
  drawOverlays(ctx, world, camX, camY, vw, vh, time);
}

function drawOverlays(ctx, world, camX, camY, vw, vh, time) {
  if (world === 'biodome') {
    // Sunlight shafts through the dome.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#fff6c8';
    for (let k = 0; k < 4; k++) {
      const base = ((k * 260 - camX * 0.12) % 1040 + 1040) % 1040 - 200;
      const a = 0.05 + 0.025 * Math.sin(time * 0.6 + k);
      ctx.globalAlpha = a;
      for (let y = 0; y < vh; y += 2) {
        const x = base + y * 0.45;
        ctx.fillRect(Math.round(x), y, 26 + k * 6, 2);
      }
    }
    ctx.restore();
  } else if (world === 'rigs') {
    // Blinking warning lights on the scaffolds (drawn on the far layers' grid).
    if (Math.floor(time * 1.5) % 2 === 0) {
      ctx.fillStyle = '#ff3b3b';
      ctx.globalAlpha = 0.35;
      for (let k = 0; k < 6; k++) {
        const x = ((k * 173 - camX * 0.16) % LW + LW) % LW;
        ctx.fillRect(Math.round(x), Math.round(vh * 0.25 + (k % 3) * 30), 2, 2);
      }
      ctx.globalAlpha = 1;
    }
  } else if (world === 'station') {
    // Slow star trails.
    ctx.fillStyle = '#ffffff';
    for (let k = 0; k < 14; k++) {
      const sp = 8 + (k % 5) * 6;
      const x = vw - ((time * sp + k * 97 + camX * 0.03) % (vw + 60));
      const y = (k * 53) % Math.max(1, Math.floor(vh * 0.6));
      ctx.globalAlpha = 0.25 + (k % 3) * 0.12;
      ctx.fillRect(Math.round(x), y, 6 + (k % 4) * 5, 1);
    }
    ctx.globalAlpha = 1;
  } else if (world === 'crystal') {
    // Distant nebula twinkles.
    ctx.fillStyle = '#ffd6fa';
    for (let k = 0; k < 10; k++) {
      const tw = Math.sin(time * 2 + k * 1.7);
      if (tw < 0.6) continue;
      const x = ((k * 211 - camX * 0.05) % vw + vw) % vw;
      const y = (k * 37) % Math.max(1, Math.floor(vh * 0.5));
      ctx.fillRect(Math.round(x), y, 1, 1);
      if (tw > 0.9) {
        ctx.fillRect(Math.round(x) - 1, y, 3, 1);
        ctx.fillRect(Math.round(x), y - 1, 1, 3);
      }
    }
  }
}

