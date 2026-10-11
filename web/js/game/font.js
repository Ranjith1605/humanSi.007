// A 3×5 pixel font for numbers and short words drawn inside the game world
// (pickup pop-ups, the gate keystone). Wider letters use 5 columns.

import { Pix, rgba } from './paint.js';

const G = {
  0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['##.', '..#', '.#.', '#..', '###'],
  3: ['##.', '..#', '.#.', '..#', '##.'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '##.'],
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  '-': ['...', '...', '###', '...', '...'],
  '!': ['#', '#', '#', '.', '#'],
  '.': ['.', '.', '.', '.', '#'],
  ' ': ['..', '..', '..', '..', '..'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  ':': ['.', '#', '.', '#', '.'],
};

function glyph(ch) {
  return G[ch] || G[ch.toUpperCase()] || G[' '];
}

export function textWidth(s) {
  let w = 0;
  for (const ch of s) w += glyph(ch)[0].length + 1;
  return Math.max(0, w - 1);
}

const cache = new Map();

/** Render text to a cached canvas with a 1-px dark outline. */
export function textSprite(s, hex, outline = '#0a0c1e') {
  const key = `${s}|${hex}|${outline}`;
  if (cache.has(key)) return cache.get(key);
  const w = textWidth(s) + 2;
  const p = new Pix(w, 7);
  const c = rgba(hex);
  let x = 1;
  for (const ch of s) {
    const g = glyph(ch);
    for (let y = 0; y < 5; y++) {
      for (let i = 0; i < g[y].length; i++) if (g[y][i] === '#') p.set(x + i, y + 1, c);
    }
    x += g[0].length + 1;
  }
  if (outline) p.outline(rgba(outline), true);
  const canvas = p.toCanvas();
  if (cache.size > 300) cache.clear();
  cache.set(key, canvas);
  return canvas;
}

/** Paint text straight into a Pix buffer (for baked sprites). */
export function paintText(p, s, x, y, col) {
  for (const ch of s) {
    const g = glyph(ch);
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < g[j].length; i++) if (g[j][i] === '#') p.set(x + i, y + j, col);
    }
    x += g[0].length + 1;
  }
}

