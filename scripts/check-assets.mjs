#!/usr/bin/env node
// Checks that every local reference in the site resolves to a file in the
// repository, so a renamed asset or a typo in an import fails CI instead of
// showing up as a 404 for a visitor.
//
//   node scripts/check-assets.mjs        exit 0 when everything resolves, 1 otherwise
//
// What it reads, in web/**:
//   .html  src, href, srcset, poster, og:image/twitter:image content and
//          a meta refresh target
//   .css   url(...) and @import
//   .js / .mjs
//          static imports and re-exports, import('...') with a literal,
//          new URL('...', import.meta.url), and string literals that name a
//          site file the page loads at runtime ('assets/...', 'data/...',
//          'css/...', 'js/...', '*.html'), which resolve against web/ because
//          every page lives there. A template literal such as
//          `assets/video/briefing-${shape}.webm` must match at least one file.
// External URLs (http:, https:, //, data:, mailto:, blob:) and in-page
// fragments are skipped: they are not files in this repository.
//
// Standard library only, like the rest of the tooling.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const ALL = walk(WEB);
const ALL_REL = ALL.map((p) => relative(WEB, p).split(sep).join('/'));
const problems = [];
let checked = 0;

const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u);

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Resolve one reference found in `file` against `base` and record a miss. */
function check(file, text, index, ref, base) {
  let u = ref.trim();
  if (!u || u.startsWith('#') || isExternal(u)) return;
  u = u.split('#')[0].split('?')[0];
  if (!u) return;
  checked++;
  let target;
  try {
    target = u.startsWith('/') ? join(WEB, decodeURIComponent(u)) : resolve(base, decodeURIComponent(u));
  } catch {
    problems.push(`${relative(ROOT, file)}:${lineOf(text, index)}  ${ref}  (not a valid path)`);
    return;
  }
  let ok = existsSync(target);
  // A directory reference is fine when it has an index.html, as a server serves it.
  if (ok && statSync(target).isDirectory()) ok = existsSync(join(target, 'index.html'));
  if (!ok) problems.push(`${relative(ROOT, file)}:${lineOf(text, index)}  ${ref}  ->  ${relative(ROOT, target)} is missing`);
}

/** A template literal path: each ${...} matches one path segment's worth of text. */
function checkTemplate(file, text, index, tpl) {
  const parts = tpl.split(/\$\{[^}]*\}/);
  const re = new RegExp(`^${parts.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);
  checked++;
  if (!ALL_REL.some((p) => re.test(p))) {
    problems.push(`${relative(ROOT, file)}:${lineOf(text, index)}  \`${tpl}\`  matches no file under web/`);
  }
}

function scanHTML(file, text) {
  const base = dirname(file);
  const attr = /\s(src|href|poster)\s*=\s*(["'])(.*?)\2/gis;
  for (const m of text.matchAll(attr)) check(file, text, m.index, m[3], base);
  for (const m of text.matchAll(/\ssrcset\s*=\s*(["'])(.*?)\1/gis)) {
    for (const cand of m[2].split(',')) check(file, text, m.index, cand.trim().split(/\s+/)[0], base);
  }
  const meta = /<meta\s[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*content\s*=\s*["']([^"']+)["']/gi;
  for (const m of text.matchAll(meta)) check(file, text, m.index, m[1], base);
  const refresh = /<meta\s[^>]*http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*?url\s*=\s*([^"']+)["']/gi;
  for (const m of text.matchAll(refresh)) check(file, text, m.index, m[1], base);
}

function scanCSS(file, text) {
  const base = dirname(file);
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  for (const m of noComments.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) check(file, text, m.index, m[2], base);
  for (const m of noComments.matchAll(/@import\s+(["'])([^"']+)\1/g)) check(file, text, m.index, m[2], base);
}

function scanJS(file, text) {
  const base = dirname(file);
  // Blank out comments first so commented-out examples are not checked.
  // Strings are kept as they are; a "//" inside a URL string survives because
  // the line-comment pattern only starts after whitespace or at a line start.
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[\s;{}()])\/\/[^\n]*/g, (c, lead) => lead + ' '.repeat(c.length - lead.length));
  const specifiers = [
    /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?(["'])([^"']+)\1/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+(["'])([^"']+)\1/g,
    /\bimport\(\s*(["'])([^"']+)\1\s*\)/g,
    /\bnew\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const re of specifiers) {
    for (const m of code.matchAll(re)) {
      const spec = m[2];
      if (spec.startsWith('node:')) continue;
      // Bare specifiers would need a package; this project has none.
      if (!spec.startsWith('.') && !spec.startsWith('/')) {
        problems.push(`${relative(ROOT, file)}:${lineOf(text, m.index)}  ${spec}  (bare import: no packages are allowed)`);
        continue;
      }
      check(file, text, m.index, spec, base);
    }
  }
  const sitePath = /(["'])((?:assets|data|css|js)\/[^"'\s]+|[\w-]+\.html)\1/g;
  for (const m of code.matchAll(sitePath)) check(file, text, m.index, m[2], WEB);
  for (const m of code.matchAll(/`((?:assets|data|css|js)\/[^`\s]*)`/g)) {
    if (m[1].includes('${')) checkTemplate(file, text, m.index, m[1]);
    else check(file, text, m.index, m[1], WEB);
  }
}

for (const file of ALL) {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  if (!['html', 'css', 'js', 'mjs'].includes(ext)) continue;
  const text = readFileSync(file, 'utf8');
  if (ext === 'html') scanHTML(file, text);
  else if (ext === 'css') scanCSS(file, text);
  else scanJS(file, text);
}

// The root redirect page for GitHub Pages points into web/.
const rootIndex = join(ROOT, 'index.html');
if (existsSync(rootIndex)) scanHTML(rootIndex, readFileSync(rootIndex, 'utf8'));

if (problems.length) {
  console.error(`check-assets: ${problems.length} unresolved reference${problems.length === 1 ? '' : 's'} (${checked} checked)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-assets: all ${checked} local references resolve`);
