// Procedural sprites. Nova and every prop are painted pixel by pixel at native
// resolution, outlined, shaded from the top-left, and cached as canvases (with
// mirrored copies) the first time they are needed. All designs are original.

import { Pix, rgba, flipH, mix } from './paint.js';
import { paintText } from './font.js';

const OUT = rgba('#0a0c1e');

// ---------------------------------------------------------------- Nova ----

const N = {
  body: rgba('#2c3d82'),
  bodyD: rgba('#1b2656'),
  bodyL: rgba('#4d66c4'),
  rim: rgba('#7fb4ff'),
  belly: rgba('#f6f2e6'),
  bellyD: rgba('#cfc6b0'),
  visor: rgba('#5fe3ff'),
  visorD: rgba('#2486c2'),
  visorL: rgba('#e2fdff'),
  eye: rgba('#0c1838'),
  beak: rgba('#ffb547'),
  beakD: rgba('#d07418'),
  feet: rgba('#ff9a3c'),
  feetD: rgba('#c45f16'),
  pack: rgba('#a3aed2'),
  packD: rgba('#5d6790'),
  packL: rgba('#e3e9ff'),
  flame1: rgba('#fff7c2'),
  flame2: rgba('#ffc04a'),
  flame3: rgba('#ff5d4a'),
  ant: rgba('#a3aed2'),
  antTip: rgba('#ffcf7a'),
  hurtVisor: rgba('#ff6b8b'),
  hurtVisorD: rgba('#b8264f'),
  pulseOut: rgba('#9ff6ff'),
};

function flipper(p, sx, sy, theta, len, col, edge) {
  // theta 0 points straight down; positive swings backwards (towards -x).
  const ex = sx - Math.sin(theta) * len;
  const ey = sy + Math.cos(theta) * len;
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = sx + (ex - sx) * t;
    const y = sy + (ey - sy) * t;
    const r = 1.6 - t * 0.7;
    p.ellipse(x, y, r, r, col);
  }
  if (edge) {
    // A lighter leading edge so the flipper reads against the body.
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      p.set(sx + (ex - sx) * t - Math.cos(theta) * 1.1, sy + (ey - sy) * t - Math.sin(theta) * 1.1, edge);
    }
  }
}

function shear(p, pivotY, amount) {
  if (!amount) return p;
  const q = new Pix(p.w, p.h);
  for (let y = 0; y < p.h; y++) {
    const off = y < pivotY ? Math.round((amount * (pivotY - y)) / 10) : 0;
    for (let x = 0; x < p.w; x++) {
      const c = p.d[y * p.w + x];
      if (c) q.set(x + off, y, c);
    }
  }
  return q;
}

function paintNova(o) {
  let p = new Pix(32, 32);
  const cx = 15.5 + (o.dx || 0);
  const cy = 20 + (o.dy || 0);
  const rx = 6.6 + (o.rx || 0);
  const ry = 8.6 + (o.ry || 0);

  // Far flipper and thruster pack sit behind the body.
  if (o.far !== undefined) flipper(p, cx + 1.5, cy - 1.5, o.far, o.farLen || 6, N.bodyD, N.body);
  p.rect(Math.round(cx - 10), Math.round(cy - 5), 4, 10, N.pack);
  p.rect(Math.round(cx - 10), Math.round(cy - 5), 1, 10, N.packD);
  p.rect(Math.round(cx - 9), Math.round(cy - 5), 2, 1, N.packL);
  p.rect(Math.round(cx - 10), Math.round(cy + 5), 3, 2, N.packD);
  if (o.flame) {
    const fx = Math.round(cx - 9.5);
    const fy = Math.round(cy + 7);
    for (let i = 0; i < o.flame + 1; i++) {
      const col = i === 0 ? N.flame1 : i < o.flame ? N.flame2 : N.flame3;
      const w = i === 0 ? 3 : i < o.flame - 1 ? 2 : 1;
      p.rect(fx + (w === 3 ? -1 : w === 2 ? (i % 2) - 1 : 0), fy + i, w, 1, col);
    }
  }

  // Feet.
  for (const [fx, fy] of o.feet) {
    p.ellipse(fx, fy, 2.1, 1.25, N.feet);
    p.set(Math.floor(fx) + 1, Math.floor(fy) + 1, N.feetD);
    p.set(Math.floor(fx), Math.floor(fy) + 1, N.feetD);
  }

  // Egg-shaped body: an ellipse plus a wider base, shaded by its normal.
  const shade = (x, y, nx, ny) => {
    const d = nx * 0.55 + ny * 0.8;
    if (nx < -0.86 && ny > -0.5) return N.rim;
    if (d > 0.62) return N.bodyD;
    if (d < -0.55) return N.bodyL;
    return N.body;
  };
  p.ellipse(cx, cy, rx, ry, shade);
  p.ellipse(cx + 0.3, cy + 3.2, rx + 0.6, ry - 3.4, (x, y, nx, ny) => shade(x, y, nx * 0.9, ny * 0.6 + 0.35));

  // Belly.
  const inBody = (x, y) => {
    const a = (x + 0.5 - cx) / rx;
    const b = (y + 0.5 - cy) / ry;
    const c = (x + 0.5 - cx - 0.3) / (rx + 0.6);
    const d = (y + 0.5 - cy - 3.2) / (ry - 3.4);
    return a * a + b * b <= 1 || c * c + d * d <= 1;
  };
  p.ellipse(cx + 2.4, cy + 3, 4.4, 6, (x, y, nx, ny) => {
    if (!inBody(x, y)) return 0;
    return nx * 0.5 + ny * 0.8 > 0.55 ? N.bellyD : N.belly;
  });

  // Visor: a glass band across the face, with an eye behind it.
  const vis = o.hurt ? N.hurtVisor : N.visor;
  const visD = o.hurt ? N.hurtVisorD : N.visorD;
  const vx0 = Math.round(cx - 1);
  const vy0 = Math.round(cy - 7);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 9; x++) {
      if ((y === 0 || y === 3) && (x === 0 || x === 8)) continue;
      const px = vx0 + x;
      const py = vy0 + y;
      if (!inBody(px, py) && x < 7) continue;
      p.set(px, py, y === 3 ? visD : vis);
    }
  }
  if (!o.blink && !o.hurt) {
    p.set(vx0 + 5, vy0 + 1, N.eye);
    p.set(vx0 + 6, vy0 + 1, N.eye);
    p.set(vx0 + 5, vy0 + 2, N.eye);
    p.set(vx0 + 6, vy0 + 2, N.eye);
    p.set(vx0 + 6, vy0 + 1, N.visorL);
  } else if (o.blink) {
    p.rect(vx0 + 5, vy0 + 2, 2, 1, N.eye);
  } else {
    // Hurt: a squeezed "> <" eye.
    p.set(vx0 + 5, vy0 + 1, N.eye);
    p.set(vx0 + 6, vy0 + 2, N.eye);
    p.set(vx0 + 5, vy0 + 3, N.eye);
  }
  p.set(vx0 + 1, vy0 + 1, N.visorL);
  p.set(vx0 + 2, vy0 + 1, N.visorL);
  p.set(vx0 + 1, vy0 + 2, N.visorL);

  // Beak.
  const bx = Math.round(cx + 6);
  const by = Math.round(cy - 3);
  p.rect(bx, by, 3, 1, N.beak);
  p.rect(bx, by + 1, 2, 1, N.beakD);

  // Near flipper.
  flipper(p, cx - 0.5, cy - 1, o.near, o.nearLen || 6.5, N.bodyD, N.bodyL);

  // Antenna with a gold tip.
  const ax = Math.round(cx - 2);
  const ay = Math.round(cy - ry + 0.5);
  const tipX = ax - 1 + (o.ant || 0);
  p.line(ax, ay, tipX, ay - 3, N.ant);
  p.rect(tipX - 1, ay - 5, 2, 2, N.antTip);

  p = shear(p, Math.round(cy + 2), o.lean || 0);
  p.outline(o.pulse ? N.pulseOut : OUT);
  return p;
}

function novaPose(name, i) {
  const base = { feet: [[13.5, 29.4], [18.5, 29.4]], near: 0.25, far: undefined };
  switch (name) {
    case 'idle': {
      const b = [0, 0, 1, 1][i];
      return { ...base, dy: b, ry: -b * 0.5, near: 0.2 + b * 0.12, blink: i === 4, ant: b ? -1 : 0 };
    }
    case 'blink':
      return { ...base, blink: true };
    case 'run': {
      const ph = (i / 8) * Math.PI * 2;
      const foot = (o) => [16 + 3.6 * Math.cos(ph + o), 29.4 - Math.max(0, Math.sin(ph + o)) * 2.4];
      const bob = Math.round(Math.abs(Math.sin(ph)));
      return {
        feet: [foot(Math.PI), foot(0)],
        dy: -bob,
        near: 0.55 + 0.75 * Math.sin(ph + Math.PI),
        far: 0.55 + 0.75 * Math.sin(ph),
        lean: 2,
        ant: bob ? -2 : -1,
      };
    }
    case 'skid':
      return { feet: [[20, 29.4], [23.5, 29.4]], dx: -1, near: -1.0, far: 1.4, lean: -3, ant: 1 };
    case 'jump':
      return { feet: [[14.5, 28.4], [17.5, 27.8]], ry: 1, rx: -0.6, near: 2.35, far: 2.0, flame: i ? 3 : 2, ant: -2 };
    case 'fall':
      return { feet: [[13, 29.6], [19, 29.8]], near: 2.7 + (i ? 0.25 : 0), far: 2.25, dy: -1, ant: 1 };
    case 'glide': {
      // Flippers raised in a V and beating while the thruster flutters.
      const flap = [-0.25, 0, 0.25, 0][i];
      return { feet: [[14, 28.6], [17.5, 28.2]], near: 2.3 + flap, far: -2.3 - flap, nearLen: 8.5, farLen: 8.5, flame: [3, 2, 4, 2][i], dy: -1, ant: -2, lean: 1 };
    }
    case 'hurt':
      return { feet: [[12.5, 29.6], [19.5, 29.2]], near: i ? 2.9 : 2.5, far: i ? -0.6 : -0.3, hurt: true, dx: i ? -1 : 0, lean: -2 };
    case 'pulse':
      return { ...base, near: -1.45 - i * 0.15, far: -1.15, pulse: true, lean: 1 };
    default:
      return base;
  }
}

const NOVA_FRAMES = { idle: 4, blink: 1, run: 8, skid: 1, jump: 2, fall: 2, glide: 4, hurt: 2, pulse: 2 };
let novaCache = null;

export function novaSprites() {
  if (novaCache) return novaCache;
  novaCache = {};
  for (const [name, n] of Object.entries(NOVA_FRAMES)) {
    novaCache[name] = [];
    for (let i = 0; i < n; i++) {
      const right = paintNova(novaPose(name, i)).toCanvas();
      novaCache[name].push({ right, left: flipH(right) });
    }
  }
  return novaCache;
}

/** Which frame to show for Nova's state. */
export function novaFrame(player, time) {
  const s = novaSprites();
  const st = player.state;
  const face = player.facing < 0 ? 'left' : 'right';
  let set;
  let i = 0;
  switch (st) {
    case 'run':
      set = s.run;
      i = Math.floor(player.runPhase * 8) % 8;
      break;
    case 'idle': {
      // Blink every few seconds.
      const blink = (time % 3.4) < 0.12;
      set = blink ? s.blink : s.idle;
      i = blink ? 0 : Math.floor(player.animT * 4) % 4;
      break;
    }
    case 'glide':
      set = s.glide;
      i = Math.floor(player.animT * 14) % 4;
      break;
    case 'jump':
      set = s.jump;
      i = Math.floor(player.animT * 16) % 2;
      break;
    case 'fall':
      set = s.fall;
      i = Math.floor(player.animT * 8) % 2;
      break;
    case 'hurt':
      set = s.hurt;
      i = Math.floor(player.animT * 12) % 2;
      break;
    case 'pulse':
      set = s.pulse;
      i = player.animT < 0.1 ? 0 : 1;
      break;
    default:
      set = s[st] || s.idle;
  }
  return set[i][face];
}

/** Portrait of Nova for comms fallbacks and the title (a larger idle frame). */
export function novaPortrait() {
  return novaSprites().idle[0].right;
}

// ------------------------------------------------------------- props ----

const cache = new Map();
function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

/** Spinning gem, six frames, coloured per world. */
export function gemFrames(pal) {
  return cached(`gem|${pal.join()}`, () => {
    const [hi, light, mid, dark, deep] = pal.map((c) => rgba(c));
    const frames = [];
    for (let f = 0; f < 6; f++) {
      const a = (f / 6) * Math.PI;
      const hw = 4.2 * Math.abs(Math.cos(a)) + 1.2;
      const front = Math.cos(a) >= 0;
      const p = new Pix(12, 13);
      const cx = 6;
      p.poly([[cx, 0.5], [cx + hw, 4], [cx + hw * 0.55, 5], [cx, 12.5], [cx - hw * 0.55, 5], [cx - hw, 4]], (x, y) => {
        const left = x + 0.5 < cx;
        if (y < 4) return left === front ? hi : light;
        if (y < 5) return light;
        return left === front ? mid : dark;
      });
      if (hw > 2) {
        p.set(cx - 1, 2, hi);
        p.set(cx - 2, 3, hi);
      }
      p.outline(deep);
      frames.push(p.toCanvas());
    }
    return frames;
  });
}

function orb(p, cx, cy, r, base, light, dark, hi) {
  p.ellipse(cx, cy, r, r, (x, y, nx, ny) => {
    const d = nx * 0.6 + ny * 0.8;
    if (d > 0.45) return dark;
    if (d < -0.5) return light;
    return base;
  });
  p.set(cx - r * 0.45, cy - r * 0.5, hi);
  p.set(cx - r * 0.45 + 1, cy - r * 0.5, hi);
}

export function podSprite(kind) {
  return cached(`pod|${kind}`, () => {
    const p = new Pix(14, 14);
    if (kind === 'si-pod') {
      orb(p, 7, 7, 5.5, rgba('#3fc8f0'), rgba('#9ff0ff'), rgba('#1a6a9e'), rgba('#ffffff'));
      // A small chip glyph.
      const g = rgba('#0c2a48');
      p.rect(5, 5, 4, 4, g);
      p.rect(6, 6, 2, 2, rgba('#c8fbff'));
      for (const [x, y] of [[4, 6], [4, 8], [9, 6], [9, 8], [6, 4], [8, 4], [6, 9], [8, 9]]) p.set(x, y, g);
      p.outline(rgba('#062038'));
    } else {
      orb(p, 7, 7, 5.5, rgba('#ffc24a'), rgba('#ffe9a8'), rgba('#c27a12'), rgba('#ffffff'));
      // A simple person glyph: head and shoulders.
      const g = rgba('#5a2e06');
      p.ellipse(7, 5.2, 1.6, 1.6, g);
      p.ellipse(7, 9.6, 3, 1.8, g);
      p.outline(rgba('#3a1a02'));
    }
    return p.toCanvas();
  });
}

export function shortcutFrames() {
  return cached('shortcut', () => {
    const out = [];
    for (let f = 0; f < 2; f++) {
      const p = new Pix(16, 16);
      const red = rgba('#ff3b4e');
      const spike = f ? 7.5 : 6.5;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + 0.2;
        const len = k % 2 ? spike - 1.5 : spike;
        p.stroke(8, 8, 8 + Math.cos(a) * len, 8 + Math.sin(a) * len, 1.4, rgba('#b0122a'));
      }
      orb(p, 8, 8, 4.4, red, rgba('#ff9aa6'), rgba('#9e0a22'), rgba('#ffffff'));
      p.set(8, 8, rgba('#ffe0e4'));
      p.set(7, 8, rgba('#ffe0e4'));
      p.outline(rgba('#2a020a'));
      out.push(p.toCanvas());
    }
    return out;
  });
}

export function critterFrames() {
  return cached('critter', () => {
    const body = rgba('#ff4f7a');
    const light = rgba('#ff9ab4');
    const dark = rgba('#a81e48');
    const spike = rgba('#c42a5e');
    const make = (f) => {
      const p = new Pix(18, 16);
      const cy = f ? 9.5 : 9;
      for (const sx of [5, 9, 13]) p.poly([[sx - 2, cy - 2], [sx + (f ? 1 : 0), cy - 7.5], [sx + 2, cy - 2]], spike);
      p.ellipse(9, cy, 6.6, f ? 4.6 : 5, (x, y, nx, ny) => (nx * 0.5 + ny * 0.8 > 0.5 ? dark : nx * 0.5 + ny * 0.8 < -0.55 ? light : body));
      // Feet.
      const fd = rgba('#5a0a24');
      p.rect(f ? 5 : 6, 14, 2, 1, fd);
      p.rect(f ? 11 : 10, 14, 2, 1, fd);
      // Eyes looking ahead with cross brows.
      const w = rgba('#ffffff');
      const k = rgba('#1a0410');
      p.rect(9, cy - 2, 2, 3, w);
      p.rect(13, cy - 2, 2, 3, w);
      p.set(10, cy - 1, k); p.set(10, cy, k);
      p.set(14, cy - 1, k); p.set(14, cy, k);
      p.line(8, cy - 4, 10, cy - 3, k);
      p.line(15, cy - 4, 13, cy - 3, k);
      p.line(10, cy + 2, 13, cy + 2, k);
      p.outline(rgba('#2a0212'));
      return p.toCanvas();
    };
    const frames = [make(0), make(1)];
    return { right: frames, left: frames.map(flipH) };
  });
}

export function calmFrames() {
  return cached('calm', () => {
    const out = [];
    for (let f = 0; f < 2; f++) {
      const p = new Pix(14, 14);
      orb(p, 7, 7, f ? 5 : 5.4, rgba('#7dffb8'), rgba('#d8ffe8'), rgba('#2fb87a'), rgba('#ffffff'));
      const k = rgba('#0e5a36');
      // Content closed eyes and a small smile.
      p.set(4, 6, k); p.set(5, 5, k); p.set(6, 6, k);
      p.set(8, 6, k); p.set(9, 5, k); p.set(10, 6, k);
      p.set(6, 9, k); p.set(7, 10, k); p.set(8, 9, k);
      p.set(3, 8, rgba('#ff9ab4'));
      p.set(11, 8, rgba('#ff9ab4'));
      p.outline(rgba('#0a3a22'));
      out.push(p.toCanvas());
    }
    return out;
  });
}

export function botFrames() {
  return cached('bot', () => {
    const make = (f, stunned) => {
      const p = new Pix(18, 18);
      const steel = rgba('#8b93b5');
      const steelL = rgba('#c9cfec');
      const steelD = rgba('#4f5680');
      // Antenna.
      p.line(8, 1, 8, 3, steelD);
      p.rect(7, 0, 2, 2, stunned ? rgba('#66e1ff') : rgba('#ff3b5c'));
      // Body.
      for (let y = 3; y < 13; y++) {
        for (let x = 2; x < 15; x++) {
          if ((x === 2 || x === 14) && (y === 3 || y === 12)) continue;
          p.set(x, y, y < 5 ? steelL : y > 10 ? steelD : steel);
        }
      }
      // Face screen.
      p.rect(4, 5, 9, 5, rgba('#140a26'));
      if (stunned) {
        const c = rgba('#66e1ff');
        p.set(6, 6, c); p.set(8, 8, c); p.set(7, 7, c); p.set(9, 6, c); p.set(10, 8, c); p.set(11, 7, c);
      } else {
        p.rect(9, 6, 3, 2, rgba('#ff3b5c'));
        p.set(9, 6, rgba('#ffd0d8'));
        p.rect(5, 8, 3, 1, rgba('#3a1a5a'));
      }
      // Treads.
      const tr = rgba('#262a3e');
      p.rect(2, 13, 13, 3, tr);
      const wl = rgba('#6a7090');
      for (let x = 3 + (f ? 1 : 0); x < 15; x += 3) p.set(x, 14, wl);
      p.outline(rgba('#07081a'));
      return p.toCanvas();
    };
    const right = [make(0, false), make(1, false)];
    const stun = make(0, true);
    return { right, left: right.map(flipH), stunRight: stun, stunLeft: flipH(stun) };
  });
}

export function spikeSprite() {
  return cached('spike', () => {
    const p = new Pix(16, 16);
    const light = rgba('#e6ecff');
    const dark = rgba('#7a84a8');
    const tip = rgba('#ff6b6b');
    for (let k = 0; k < 4; k++) {
      const x0 = k * 4;
      p.poly([[x0 + 0.2, 13], [x0 + 2, 5.5], [x0 + 3.8, 13]], (x) => (x < x0 + 2 ? light : dark));
      p.set(x0 + 1, 6, tip);
      p.set(x0 + 2, 6, tip);
    }
    p.rect(0, 13, 16, 3, rgba('#3a3f5c'));
    p.rect(0, 13, 16, 1, rgba('#8b93b5'));
    p.outline(rgba('#0a0c1e'));
    return p.toCanvas();
  });
}

export function beaconSprite(color, scanned) {
  return cached(`beacon|${color}|${scanned}`, () => {
    const p = new Pix(18, 30);
    const c = rgba(scanned ? mix(color, '#ffffff', 0.35) : color);
    const cl = rgba(mix(color, '#ffffff', scanned ? 0.8 : 0.55));
    const cd = rgba(mix(color, '#000000', 0.45));
    p.poly([[9, 1], [13.5, 10], [9, 24], [4.5, 10]], (x, y) => (x < 9 ? (y < 10 ? cl : c) : y < 10 ? c : cd));
    p.line(9, 3, 9, 21, cl);
    // Pedestal.
    p.rect(3, 24, 12, 3, rgba('#3d3458'));
    p.rect(2, 27, 14, 3, rgba('#2a2240'));
    p.rect(3, 24, 12, 1, rgba('#7a6aa8'));
    p.rect(5, 22, 8, 2, rgba('#2a2240'));
    p.outline(rgba('#0a0618'));
    return p.toCanvas();
  });
}

export function terminalSprite(state) {
  return cached(`terminal|${state}`, () => {
    const p = new Pix(18, 26);
    const steel = rgba('#8b93b5');
    const steelD = rgba('#4f5680');
    const steelL = rgba('#c9cfec');
    p.rect(7, 12, 4, 11, steelD);
    p.rect(8, 12, 1, 11, steel);
    p.rect(3, 22, 12, 4, steelD);
    p.rect(3, 22, 12, 1, steel);
    p.poly([[1, 3], [17, 1], [17, 12], [1, 13]], steel);
    p.line(1, 3, 17, 1, steelL);
    const scr = state === 'due' ? rgba('#ffb547') : state === 'done' ? rgba('#2fdc8a') : rgba('#12304a');
    const ink = state === 'due' ? rgba('#7a3e00') : state === 'done' ? rgba('#0a4a2a') : rgba('#2a6a8a');
    p.poly([[3, 4.5], [15.5, 3], [15.5, 10.5], [3, 11.5]], scr);
    if (state === 'done') {
      p.line(6, 7, 8, 9, ink);
      p.line(8, 9, 12, 5, ink);
    } else {
      for (let y = 5; y < 11; y += 2) p.line(4, y + 0.5, state === 'due' ? 13 : 10, y, ink);
    }
    p.outline(rgba('#07081a'));
    return p.toCanvas();
  });
}

export function capsuleSprite(freed) {
  return cached(`capsule|${freed}`, () => {
    const p = new Pix(18, 28);
    const shell = rgba('#e6ecf8');
    const shellD = rgba('#9eaaca');
    const shellL = rgba('#ffffff');
    p.ellipse(9, 13, 6.5, 11.5, (x, y, nx, ny) => (nx > 0.55 ? shellD : nx < -0.6 ? shellL : shell));
    p.ellipse(9, 11, 4, 5.5, freed ? rgba('#d8f4ff') : rgba('#8fd0f0'));
    if (!freed) {
      // A crew member asleep behind frosted glass.
      p.ellipse(9, 9.5, 1.8, 1.8, rgba('#33405e'));
      p.ellipse(9, 14, 3.2, 2, rgba('#33405e'));
      p.set(7, 7, rgba('#ffffff'));
      p.set(11, 12, rgba('#ffffff'));
    }
    p.rect(3, 23, 12, 2, rgba('#59628a'));
    p.rect(2, 25, 14, 3, rgba('#3a4060'));
    p.rect(8, 0, 2, 2, freed ? rgba('#2fdc8a') : rgba('#ffb547'));
    p.outline(rgba('#0a0c1e'));
    return p.toCanvas();
  });
}

export function crewSprite() {
  return cached('crew', () => {
    const p = new Pix(10, 14);
    p.ellipse(5, 3.5, 2.6, 2.6, rgba('#f2f5ff'));
    p.rect(4, 3, 3, 1, rgba('#66e1ff'));
    p.ellipse(5, 9, 3, 3.5, rgba('#ffcf7a'));
    p.rect(3, 11, 2, 3, rgba('#c99a2e'));
    p.rect(6, 11, 2, 3, rgba('#c99a2e'));
    p.set(1, 6, rgba('#ffcf7a'));
    p.set(0, 5, rgba('#ffcf7a'));
    p.set(9, 5, rgba('#ffcf7a'));
    p.set(8, 6, rgba('#ffcf7a'));
    p.outline(rgba('#0a0c1e'));
    return p.toCanvas();
  });
}

export function checkpointSprite(lit, accent) {
  return cached(`cp|${lit}|${accent}`, () => {
    const p = new Pix(14, 34);
    const steel = rgba('#8b93b5');
    const steelD = rgba('#4f5680');
    p.rect(6, 9, 2, 22, steel);
    p.rect(7, 9, 1, 22, steelD);
    p.rect(3, 30, 8, 4, steelD);
    p.rect(3, 30, 8, 1, steel);
    // Lamp.
    const lamp = lit ? rgba('#ffffff') : rgba('#3a4060');
    const lampC = lit ? rgba(accent) : rgba('#262a40');
    p.ellipse(7, 5, 4, 4.5, lampC);
    p.ellipse(7, 4.5, 2, 2.2, lamp);
    p.rect(3, 8, 8, 2, steelD);
    if (lit) {
      // A small pennant.
      p.poly([[8, 11], [13.5, 13], [8, 15]], rgba(accent));
    }
    p.outline(rgba('#0a0c1e'));
    return p.toCanvas();
  });
}

export function gateSprite(label, color) {
  return cached(`gate|${label}|${color}`, () => {
    const W = 72;
    const H = 84;
    const p = new Pix(W, H);
    const m = rgba('#c9d2e4');
    const mL = rgba('#f2f5ff');
    const mD = rgba('#6c7896');
    const inlay = rgba(color);
    const inlayL = rgba(mix(color, '#ffffff', 0.6));
    const cx = W / 2;
    const cy = 34;
    // Arch: a thick ring, upper half, flowing into two pillars.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.hypot(dx, dy);
        let on = false;
        let rim = 0;
        if (y < cy) {
          on = d >= 25 && d <= 34;
          rim = d - 25;
        } else {
          const ax = Math.abs(dx);
          on = ax >= 25 && ax <= 34;
          rim = ax - 25;
        }
        if (!on) continue;
        let c = m;
        if (rim < 1.5) c = mD;
        else if (rim > 8) c = mD;
        else if (rim > 3.5 && rim < 5.5) c = inlay;
        else if (rim < 3) c = mL;
        p.set(x, y, c);
      }
    }
    // Pillar bases and capitals.
    for (const sx of [cx - 36, cx + 25]) {
      p.rect(sx, H - 6, 11, 6, mD);
      p.rect(sx, H - 6, 11, 1, mL);
      p.rect(sx + 1, cy, 9, 2, mD);
    }
    // Inlay highlights.
    for (let y = cy + 4; y < H - 8; y += 6) {
      p.set(cx - 30, y, inlayL);
      p.set(cx + 29, y, inlayL);
    }
    // Keystone with the gate label.
    p.rect(cx - 9, 0, 18, 11, mD);
    p.rect(cx - 8, 1, 16, 9, rgba('#1a2040'));
    paintText(p, label, cx - 5, 3, inlayL);
    p.outline(rgba('#0a0c1e'));
    return p.toCanvas();
  });
}

export function sparkleSprite(hex) {
  return cached(`spark|${hex}`, () => {
    const p = new Pix(7, 7);
    const c = rgba(hex);
    const w = rgba('#ffffff');
    p.rect(3, 0, 1, 7, c);
    p.rect(0, 3, 7, 1, c);
    p.set(3, 3, w);
    p.set(2, 2, c); p.set(4, 4, c); p.set(2, 4, c); p.set(4, 2, c);
    return p.toCanvas();
  });
}
