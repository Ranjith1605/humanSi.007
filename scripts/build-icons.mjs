#!/usr/bin/env node
// Renders the app icons from the one source mark, web/assets/icons/icon.svg,
// so the installed app, the home-screen tile and the browser tab all show
// the same original HumanSI mark. Dev-only: the PNGs are committed and CI
// never runs this (it needs a browser).
//
//   node scripts/build-icons.mjs
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/build-icons.mjs
//
// Outputs, all in web/assets/icons/:
//
//   icon-192.png            192x192  "any": the rounded tile, transparent corners
//   icon-512.png            512x512  "any": the same, large
//   icon-maskable-512.png   512x512  "maskable": opaque and full-bleed, the mark
//                                    shrunk well inside the 40 % safe circle
//                                    because launchers crop to any shape
//   apple-touch-icon.png    180x180  opaque, full-bleed: iOS rounds the corners
//                                    itself and paints transparency black
//
// Playwright is the only dependency, and it is not a package of this
// repository: import it from wherever it is installed. The browser renders
// the SVG exactly as a visitor's browser would, which is the point.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = join(ROOT, 'web', 'assets', 'icons');
const VOID = '#04050b'; // --void in web/css/tokens.css

// scale is the mark's size relative to the canvas; opaque fills the canvas
// with the void colour, which is also the tile's own fill, so the tile edge
// disappears and only the mark shows.
const OUTPUTS = [
  { file: 'icon-192.png', size: 192, scale: 1, opaque: false },
  { file: 'icon-512.png', size: 512, scale: 1, opaque: false },
  // The ring's outer edge sits at 77 % of the half-width; at 0.8 it lands at
  // 31 % of the canvas from the centre, comfortably inside the 40 % circle.
  { file: 'icon-maskable-512.png', size: 512, scale: 0.8, opaque: true },
  { file: 'apple-touch-icon.png', size: 180, scale: 0.88, opaque: true },
];

async function loadChromium() {
  const from = process.env.PLAYWRIGHT_MODULE || 'playwright';
  const spec = from.startsWith('/') || from.startsWith('.') ? pathToFileURL(resolve(from)).href : from;
  try {
    return (await import(spec)).chromium;
  } catch (err) {
    console.error(`build-icons: cannot load Playwright from "${from}" (${err.message}).`);
    console.error('Install it (npm i -g playwright && npx playwright install chromium) and point');
    console.error('PLAYWRIGHT_MODULE at its index.mjs if Node cannot resolve it.');
    process.exit(1);
  }
}

/** Width, height and colour type straight from the PNG header. */
function pngInfo(buf) {
  const sig = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== sig) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

function page(svg, { size, scale, opaque }) {
  const px = Math.round(size * scale);
  return `<!doctype html><html><head><style>
    html, body { margin: 0; width: ${size}px; height: ${size}px; overflow: hidden;
                 background: ${opaque ? VOID : 'transparent'}; }
    body { display: grid; place-items: center; }
    svg { display: block; width: ${px}px; height: ${px}px; }
  </style></head><body>${svg}</body></html>`;
}

const svg = readFileSync(join(ICONS, 'icon.svg'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const chromium = await loadChromium();
const browser = await chromium.launch();
try {
  for (const out of OUTPUTS) {
    const ctx = await browser.newContext({ viewport: { width: out.size, height: out.size }, deviceScaleFactor: 1 });
    const tab = await ctx.newPage();
    await tab.setContent(page(svg, out));
    const png = await tab.screenshot({ type: 'png', omitBackground: !out.opaque });
    await ctx.close();
    const info = pngInfo(png);
    if (info.width !== out.size || info.height !== out.size) {
      throw new Error(`${out.file}: rendered ${info.width}x${info.height}, want ${out.size}x${out.size}`);
    }
    writeFileSync(join(ICONS, out.file), png);
    console.log(`build-icons: ${out.file}  ${info.width}x${info.height}  ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
