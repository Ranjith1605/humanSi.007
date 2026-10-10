// Per-world tilesets. Solid ground is painted per pixel in world coordinates,
// so textures (facets, plates, soil, glass grids, panels) run continuously
// across tiles instead of repeating a 16×16 stamp. The static part of a level
// is baked once into one large canvas when the level loads; only the few
// animated tiles (springs, boosters, updrafts, crumbling and false walls) are
// drawn per frame.

import { T, TILE, looksSolid } from './physics.js';
import { Pix, rgba, makeCanvas, bayer, hash2, noise, mix } from './paint.js';

const C = (h) => rgba(h);

// ------------------------------------------------------- solid painters ----

function crystalSolid(wx, wy, e) {
  const P = crystalSolid.P || (crystalSolid.P = {
    deep: C('#1c0d31'), base: C('#2a1546'), mid: C('#381c5c'), light: C('#4e2c7e'), line: C('#61399a'),
    r0: C('#ffd6fa'), r1: C('#ff7ae0'), r2: C('#c044c0'), r3: C('#7a2a90'), out: C('#10061c'), speck: C('#ff8ae8'), speck2: C('#ffd6fa'),
  });
  const rimT = 3 + Math.floor(hash2(wx >> 2, 7) * 3);
  if (e.top < rimT + 2) {
    if (e.top === 0) return P.r0;
    if (e.top === 1) return P.r1;
    if (e.top < rimT) return e.top === 2 ? P.r2 : bayer(wx, wy) > 0.5 ? P.r2 : P.r3;
    return bayer(wx, wy) > 0.35 ? P.r3 : P.mid;
  }
  if (e.left === 0 || e.right === 0 || e.bottom === 0) return P.out;
  if (e.left === 1) return P.line;
  const u = wx * 0.8 + wy * 0.6;
  const v = -wx * 0.6 + wy * 0.8;
  const cu = Math.floor(u / 11);
  const cv = Math.floor(v / 8);
  if (u - cu * 11 < 1 || v - cv * 8 < 1) return e.top > 40 ? P.base : P.line;
  const h = hash2(cu, cv, 3);
  if (hash2(wx, wy, 9) < 0.005) return P.speck2;
  if (hash2(wx >> 1, wy >> 1, 5) < 0.008) return P.speck;
  const deep = e.top > 30 ? 1 : 0;
  if (h < 0.33) return deep ? P.deep : P.base;
  if (h < 0.7) return deep ? P.base : P.mid;
  return deep ? P.mid : P.light;
}

function rigsSolid(wx, wy, e) {
  const P = rigsSolid.P || (rigsSolid.P = {
    plate: C('#4e4552'), plateL: C('#716675'), plateD: C('#2c2632'), rivet: C('#b09c8e'), rivetD: C('#1e1a22'),
    rust: C('#8a4a2a'), rust2: C('#6a3222'), red: C('#e83a3a'), redL: C('#ff7a6a'), dark: C('#241a20'), hi: C('#ffc2b0'), out: C('#140f16'),
  });
  if (e.top === 0) return P.hi;
  if (e.top <= 4) {
    if (e.top === 4) return P.out;
    return ((wx + e.top) >> 2) & 1 ? (e.top === 1 ? P.redL : P.red) : P.dark;
  }
  if (e.left === 0 || e.right === 0 || e.bottom === 0) return P.out;
  const lx = wx & 15;
  const ly = wy & 15;
  if (lx === 0 || ly === 0) return P.plateL;
  if (lx === 15 || ly === 15) return P.plateD;
  if ((lx === 3 || lx === 12) && (ly === 3 || ly === 12)) return P.rivet;
  if ((lx === 3 || lx === 12) && (ly === 4 || ly === 13)) return P.rivetD;
  const n = noise(wx / 9, wy / 9, 11) * 0.7 + noise(wx / 3, wy / 3, 12) * 0.3;
  if (n > 0.66) return bayer(wx, wy) > 0.4 ? P.rust : P.rust2;
  if (ly === 7 || ly === 8) return P.plateD;
  return P.plate;
}

function biodomeSolid(wx, wy, e) {
  const P = biodomeSolid.P || (biodomeSolid.P = {
    soil: C('#5c3b24'), soilD: C('#462c1a'), soilL: C('#76502f'), peb: C('#9a7a56'), pebD: C('#33200f'), root: C('#2e1c0e'),
    g0: C('#c8ff7a'), g1: C('#78e24c'), g2: C('#40b840'), g3: C('#258a3a'), g4: C('#175a2a'), out: C('#24160a'),
  });
  const gt = 4 + Math.floor(hash2(wx, 31) * 3);
  if (e.top < gt) {
    if (e.top === 0) return hash2(wx, 2) < 0.55 ? P.g0 : P.g1;
    if (e.top === 1) return P.g1;
    if (e.top === gt - 1) return P.g4;
    return bayer(wx, wy) > 0.5 ? P.g2 : P.g3;
  }
  if (e.left === 0 || e.right === 0 || e.bottom === 0) return P.out;
  const n = noise(wx / 7, wy / 5, 21);
  if (Math.abs(noise(wx / 9, wy / 4, 27) - 0.5) < 0.018) return P.root;
  if (hash2(wx >> 1, wy >> 1, 23) < 0.025) return (wx & 1) ? P.peb : P.pebD;
  if (n > 0.68) return P.soilL;
  if (n < 0.3 || e.top > 36) return bayer(wx, wy) > 0.5 ? P.soilD : P.soil;
  return P.soil;
}

function datacitySolid(wx, wy, e) {
  const P = datacitySolid.P || (datacitySolid.P = {
    glass: C('#0f1c36'), glassL: C('#17294c'), glassD: C('#0a1226'), grid: C('#1c3a68'), win: C('#66e1ff'), win2: C('#ff6bd5'), winD: C('#2a6a9a'),
    n0: C('#e8fdff'), n1: C('#66e1ff'), n2: C('#2a8fb5'), out: C('#050a18'),
  });
  if (e.top === 0) return P.n0;
  if (e.top === 1) return P.n1;
  if (e.top === 2) return P.n2;
  if (e.top === 3) return bayer(wx, wy) > 0.5 ? P.n2 : P.glassL;
  if (e.left === 0 || e.right === 0) return P.n2;
  if (e.bottom === 0) return P.winD;
  const lx = wx & 7;
  const ly = wy & 7;
  if (lx === 0 || ly === 0) return P.grid;
  const cell = hash2(wx >> 3, wy >> 3, 41);
  if (ly >= 3 && ly <= 4 && lx >= 2 && lx <= 5) {
    if (cell < 0.22) return P.win;
    if (cell < 0.27) return P.win2;
    if (cell < 0.45) return P.winD;
  }
  return e.top > 26 ? (bayer(wx, wy) > 0.6 ? P.glassD : P.glass) : P.glass;
}

function engineeringSolid(wx, wy, e) {
  const P = engineeringSolid.P || (engineeringSolid.P = {
    m: C('#4a3420'), mL: C('#6c4c2c'), mD: C('#2c1e10'), bolt: C('#d8964a'), boltD: C('#24160a'),
    t0: C('#ffe0a0'), t1: C('#ffb547'), t2: C('#c97a22'), hole: C('#1a1008'), out: C('#140c04'), stain: C('#3a2614'),
  });
  if (e.top === 0) return P.t0;
  if (e.top === 1) return P.t1;
  if (e.top === 2 || e.top === 3) return wx % 3 === 0 ? P.hole : P.t2;
  if (e.top === 4) return P.mD;
  if (e.left === 0 || e.right === 0 || e.bottom === 0) return P.out;
  if (e.left === 1) return P.mL;
  const ly = wy & 7;
  if (ly === 0) return P.mL;
  if (ly === 7) return P.mD;
  if ((wx & 15) === 3 && ly === 3) return P.bolt;
  if ((wx & 15) === 3 && ly === 4) return P.boltD;
  if (noise(wx / 10, wy / 6, 51) > 0.64) return bayer(wx, wy) > 0.5 ? P.stain : P.m;
  return P.m;
}

function stationSolid(wx, wy, e) {
  const P = stationSolid.P || (stationSolid.P = {
    p: C('#c3cbe0'), pL: C('#e6ebf7'), pD: C('#8e98b4'), seam: C('#6c7896'), deep: C('#a6b0ca'), light: C('#66e1ff'),
    g0: C('#fff3c0'), g1: C('#ffcf7a'), g2: C('#b8862a'), out: C('#4a5274'),
  });
  if (e.top === 0) return P.g0;
  if (e.top === 1) return P.g1;
  if (e.top === 2) return P.g2;
  if (e.left === 0 || e.right === 0 || e.bottom === 0) return P.out;
  const row = Math.floor(wy / 8);
  const lx = (wx + (row & 1 ? 8 : 0)) & 15;
  const ly = wy & 7;
  if (lx === 0 || ly === 0) return P.seam;
  if (lx === 8 && ly === 4 && hash2((wx + (row & 1 ? 8 : 0)) >> 4, row, 61) < 0.15) return P.light;
  if (ly === 1 || lx === 1) return P.pL;
  if (ly === 7) return P.pD;
  if (e.top > 28) return bayer(wx, wy) > 0.5 ? P.deep : P.p;
  return P.p;
}

const SOLID = {
  crystal: crystalSolid,
  rigs: rigsSolid,
  biodome: biodomeSolid,
  datacity: datacitySolid,
  engineering: engineeringSolid,
  station: stationSolid,
};

// ------------------------------------------------------ thin platforms ----

const ONEWAY = {
  crystal: ['#ffd6fa', '#ff7ae0', '#a03ab8', '#6a2088', '#3a1050'],
  rigs: ['#e2d6dc', '#a0949c', '#5e5460', '#3a3240', '#1e1a22'],
  biodome: ['#f0c27a', '#c4874a', '#9a6232', '#6a4020', '#3a220e'],
  datacity: ['#e8fdff', '#66e1ff', '#2a6aa0', '#1a3a66', '#0a1a33'],
  engineering: ['#ffe0a0', '#ffb547', '#b8701e', '#6c4c2c', '#2c1e10'],
  station: ['#fff3c0', '#ffcf7a', '#e6ebf7', '#a6b0ca', '#5a6488'],
};

const CRUMBLE = {
  crystal: ['#ffe8fc', '#f0a0e6', '#b868c0', '#7a3a88'],
  rigs: ['#c49a7a', '#9a6a4a', '#6e4430', '#3a2418'],
  biodome: ['#f0e08a', '#c8b05a', '#9a8238', '#5e4c1c'],
  datacity: ['#ffd0f4', '#ff6bd5', '#8a2a8a', '#3a0a4a'],
  engineering: ['#d8b07a', '#a8783a', '#6e4a1e', '#3a240e'],
  station: ['#ffffff', '#d4dae8', '#ff8a7a', '#6c7896'],
};

function paintOneway(world, capL, capR, seed) {
  const [c0, c1, c2, c3, c4] = ONEWAY[world].map(C);
  const p = new Pix(16, 16);
  for (let x = 0; x < 16; x++) {
    if ((capL && x === 0) || (capR && x === 15)) {
      p.rect(x, 1, 1, 4, c4);
      continue;
    }
    p.set(x, 0, c0);
    p.set(x, 1, c1);
    p.set(x, 2, c2);
    p.set(x, 3, world === 'engineering' && x % 3 === 0 ? c4 : c2);
    p.set(x, 4, c3);
    p.set(x, 5, c4);
  }
  // Under-side detail per world.
  const r = (i) => hash2(seed, i, 77);
  if (world === 'crystal') {
    for (let k = 0; k < 2; k++) {
      const x = 2 + Math.floor(r(k) * 12);
      const len = 2 + Math.floor(r(k + 9) * 4);
      for (let j = 0; j < len; j++) p.set(x, 6 + j, j === len - 1 ? c1 : c3);
    }
  } else if (world === 'rigs') {
    for (let x = 0; x < 16; x++) {
      const d = (x % 6);
      if (d === 0 || d === 5) for (let j = 6; j < 9; j++) p.set(x, j, c3);
      if (d === 1 || d === 4) p.set(x, 7, c3);
      if (d === 2 || d === 3) p.set(x, 8, c3);
    }
  } else if (world === 'biodome') {
    if (r(1) < 0.6) {
      const x = 3 + Math.floor(r(2) * 10);
      const len = 3 + Math.floor(r(3) * 6);
      for (let j = 0; j < len; j++) p.set(x + (j % 3 === 2 ? 1 : 0), 6 + j, j === len - 1 ? C('#c8ff7a') : C('#3fb83e'));
    }
    p.set(7, 2, c4);
    p.set(8, 2, c4);
  } else if (world === 'datacity') {
    p.set(4, 3, C('#66e1ff'));
    p.set(11, 3, C('#ff6bd5'));
  } else if (world === 'engineering') {
    p.rect(7, 6, 2, 4, c3);
  } else if (world === 'station') {
    p.set(8, 3, C('#66e1ff'));
  }
  return p;
}

export function paintCrumble(world, crack) {
  const [c0, c1, c2, c3] = CRUMBLE[world].map(C);
  const p = new Pix(16, 16);
  for (let x = 0; x < 16; x++) {
    p.set(x, 0, c0);
    for (let y = 1; y < 5; y++) p.set(x, y, (x + y) % 5 === 0 ? c2 : c1);
    p.set(x, 5, c3);
  }
  // Cracks.
  const k = C('#120818');
  const lines = [[3, 0, 5, 5], [9, 0, 7, 3], [7, 3, 8, 5], [13, 1, 12, 5]];
  for (const [a, b, c, d] of lines) p.line(a, b, c, d, k);
  if (crack) for (let x = 1; x < 16; x += 3) p.set(x, 2 + (x % 2), k);
  return p;
}

// --------------------------------------------------------- decorations ----

function deco(world, r, accent) {
  const p = new Pix(16, 16);
  const pick = Math.floor(r * 6);
  switch (world) {
    case 'crystal': {
      const cols = [C('#ffd6fa'), C('#ff7ae0'), C('#b04ac8'), C('#5a2080')];
      const shards = pick < 3 ? [[5, 7, 2], [8, 11, 2.5], [11, 6, 2]] : [[7, 9, 2.5], [10, 5, 1.5]];
      for (const [x, hgt, w] of shards) {
        p.poly([[x - w, 16], [x, 16 - hgt], [x + w, 16]], (px) => (px < x ? cols[0] : px < x + 1 ? cols[1] : cols[2]));
      }
      p.outline(cols[3]);
      break;
    }
    case 'rigs': {
      if (pick < 3) {
        p.rect(6, 11, 4, 5, C('#3a3240'));
        p.rect(7, 9, 2, 2, C('#ff3b3b'));
        p.set(7, 9, C('#ffb0a0'));
      } else {
        p.rect(2, 13, 12, 3, C('#5e5460'));
        p.rect(2, 13, 12, 1, C('#a0949c'));
        p.rect(4, 10, 2, 3, C('#5e5460'));
      }
      p.outline(C('#140f16'));
      break;
    }
    case 'biodome': {
      const g = [C('#c8ff7a'), C('#78e24c'), C('#40b840')];
      for (let k = 0; k < 5; k++) {
        const x = 3 + k * 2.5;
        const hgt = 3 + ((k * 7 + pick) % 5);
        p.line(x, 16, x + (k % 2 ? 1 : -1), 16 - hgt, g[k % 3]);
      }
      if (pick % 2 === 0) {
        const fx = 4 + pick * 1.5;
        const petal = pick < 3 ? C('#ff8ac8') : C('#ffe066');
        p.set(fx, 9, petal); p.set(fx + 1, 10, petal); p.set(fx - 1, 10, petal); p.set(fx, 11, petal);
        p.set(fx, 10, C('#fff8d0'));
        p.line(fx, 12, fx, 16, C('#40b840'));
      }
      break;
    }
    case 'datacity': {
      if (pick < 3) {
        p.rect(7, 8, 2, 8, C('#1c3a68'));
        p.rect(6, 6, 4, 2, C('#66e1ff'));
        p.set(7, 6, C('#e8fdff'));
      } else {
        p.line(8, 16, 8, 6, C('#2a4a7a'));
        p.set(8, 5, C('#ff6bd5'));
        p.set(8, 4, C('#ffd0f4'));
      }
      p.outline(C('#050a18'));
      break;
    }
    case 'engineering': {
      if (pick < 3) {
        p.rect(3, 12, 10, 4, C('#6c4c2c'));
        p.rect(3, 12, 10, 1, C('#c98a3a'));
        p.ellipse(8, 9.5, 2.5, 2.5, C('#c43a2a'));
        p.set(7, 8, C('#ff8a6a'));
      } else {
        p.rect(6, 7, 4, 9, C('#8a6a3a'));
        p.rect(6, 7, 1, 9, C('#d8a04a'));
        p.rect(5, 6, 6, 2, C('#4a3420'));
      }
      p.outline(C('#140c04'));
      break;
    }
    case 'station': {
      if (pick < 3) {
        p.rect(6, 12, 4, 4, C('#8e98b4'));
        p.rect(7, 10, 2, 2, C(accent));
      } else {
        p.line(9, 16, 9, 7, C('#a6b0ca'));
        p.line(9, 8, 12, 6, C('#a6b0ca'));
        p.set(12, 5, C('#ffcf7a'));
      }
      p.outline(C('#4a5274'));
      break;
    }
    default:
      break;
  }
  return p;
}

function hangDeco(world, r) {
  const p = new Pix(16, 16);
  const x = 3 + Math.floor(r * 10);
  const len = 3 + Math.floor(hash2(x, 5, 91) * 8);
  const cols = {
    crystal: [C('#7a2a90'), C('#ff7ae0')],
    rigs: [C('#2c2632'), C('#5e5460')],
    biodome: [C('#2e9a3e'), C('#78e24c')],
    datacity: [C('#1c3a68'), C('#66e1ff')],
    engineering: [C('#3a2614'), C('#ffb547')],
    station: [C('#8e98b4'), C('#66e1ff')],
  }[world];
  if (world === 'crystal') {
    p.poly([[x - 2, 0], [x, len], [x + 2, 0]], (px) => (px < x ? cols[1] : cols[0]));
  } else {
    for (let j = 0; j < len; j++) p.set(x + (world === 'biodome' && j % 4 === 3 ? 1 : 0), j, j === len - 1 ? cols[1] : cols[0]);
  }
  return p;
}

// --------------------------------------------------------- level bake ----

/**
 * Bake the static part of a level: autotiled ground, one-way platforms and
 * decorations. False walls get their own small canvases so they can fade.
 */
export function bakeLevel(lv, world, accent) {
  const W = lv.w * TILE;
  const H = lv.h * TILE;
  const img = new Pix(W, H);
  const paint = SOLID[world] || SOLID.crystal;
  const at = (x, y) => (x < 0 || x >= lv.w || y < 0 ? T.SOLID : y >= lv.h ? T.EMPTY : lv.tiles[y * lv.w + x]);
  const solidish = (x, y) => {
    const c = at(x, y);
    return looksSolid(c) && c !== T.SPRING;
  };
  // Distance (px) from a pixel to the exposed face in each direction, capped.
  const depth = (tx, ty, dx, dy) => {
    let k = 0;
    while (k < 4 && solidish(tx + dx * (k + 1), ty + dy * (k + 1))) k++;
    return k;
  };
  const paintTile = (tx, ty, target, ox, oy) => {
    const kTop = depth(tx, ty, 0, -1);
    const kBot = depth(tx, ty, 0, 1);
    const kL = depth(tx, ty, -1, 0);
    const kR = depth(tx, ty, 1, 0);
    // The map's own edges are walls, not faces: no rim along them.
    const topEdge = ty === 0;
    const e = { top: 0, bottom: 0, left: 0, right: 0 };
    const expTop = kTop === 0 && !topEdge;
    const expL = kL === 0 && tx > 0;
    const expR = kR === 0 && tx < lv.w - 1;
    const expB = kBot === 0;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        // Rounded outer corners.
        if (expTop && expL && x + y < 2) continue;
        if (expTop && expR && 15 - x + y < 2) continue;
        if (expB && expL && x + 15 - y < 2) continue;
        if (expB && expR && 30 - x - y < 2) continue;
        e.top = topEdge && kTop === 0 ? 99 : kTop * 16 + y;
        e.bottom = kBot * 16 + (15 - y);
        e.left = tx === 0 && kL === 0 ? 99 : kL * 16 + x;
        e.right = tx === lv.w - 1 && kR === 0 ? 99 : kR * 16 + (15 - x);
        if (!expB) e.bottom = 99;
        if (!expL && tx > 0 && kL >= 4) e.left = 99;
        if (!expR && kR >= 4) e.right = 99;
        const c = paint(tx * 16 + x, ty * 16 + y, e);
        if (c) target.set(ox + x, oy + y, c);
      }
    }
  };

  for (let ty = 0; ty < lv.h; ty++) {
    for (let tx = 0; tx < lv.w; tx++) {
      const c = lv.tiles[ty * lv.w + tx];
      if (c === T.SOLID || c === T.BOOST_R || c === T.BOOST_L) paintTile(tx, ty, img, tx * 16, ty * 16);
      else if (c === T.ONEWAY) {
        const p = paintOneway(world, at(tx - 1, ty) !== T.ONEWAY, at(tx + 1, ty) !== T.ONEWAY, tx * 31 + ty);
        img.blit(p, tx * 16, ty * 16);
      }
    }
  }

  // Decorations on exposed tops and hanging from exposed undersides.
  const occupied = new Set(lv.spawns.map((s) => s.ty * lv.w + s.tx));
  for (const p of lv.platforms) occupied.add(Math.round(p.homeY) * lv.w + Math.floor(p.homeX));
  for (let ty = 1; ty < lv.h; ty++) {
    for (let tx = 0; tx < lv.w; tx++) {
      const c = lv.tiles[ty * lv.w + tx];
      if (c !== T.SOLID) continue;
      const above = at(tx, ty - 1);
      const r = hash2(tx, ty, 101);
      if (above === T.EMPTY && !occupied.has((ty - 1) * lv.w + tx) && r < 0.2) {
        img.blit(deco(world, hash2(tx, ty, 103), accent), tx * 16, (ty - 1) * 16);
      }
      const below = at(tx, ty + 1);
      if (ty + 1 < lv.h && below === T.EMPTY && !occupied.has((ty + 1) * lv.w + tx) && r > 0.86) {
        img.blit(hangDeco(world, hash2(tx, ty, 107)), tx * 16, (ty + 1) * 16);
      }
    }
  }

  // Updraft vents on the ground under each column.
  for (const z of lv.updrafts) {
    if (at(z.x0, z.bottom) === T.SOLID || at(z.x0, z.bottom) === T.ONEWAY) {
      const p = new Pix(16, 4);
      p.rect(1, 0, 14, 3, C('#2a2f44'));
      for (let x = 2; x < 14; x += 2) p.set(x, 1, C('#9ff6ff'));
      img.blit(p, z.x0 * 16, z.bottom * 16 - 3);
    }
  }

  const canvas = img.toCanvas();

  // False walls: painted like rock, but on their own canvas per group.
  for (const g of lv.falseGroups) {
    const gw = (g.maxX - g.minX + 1) * 16;
    const gh = (g.maxY - g.minY + 1) * 16;
    const gp = new Pix(gw, gh);
    for (const j of g.cells) {
      const tx = j % lv.w;
      const ty = (j / lv.w) | 0;
      paintTile(tx, ty, gp, (tx - g.minX) * 16, (ty - g.minY) * 16);
    }
    g.canvas = gp.toCanvas();
  }

  return { canvas, world };
}

// -------------------------------------------------------- animated tiles ----

const animCache = new Map();
function anim(key, fn) {
  if (!animCache.has(key)) animCache.set(key, fn());
  return animCache.get(key);
}

function springFrames() {
  return anim('spring', () => [0, 1, 2].map((f) => {
    const p = new Pix(16, 16);
    const base = C('#3a4060');
    p.rect(1, 10, 14, 6, base);
    p.rect(1, 10, 14, 1, C('#8b93b5'));
    p.rect(3, 13, 2, 2, C('#ffcf7a'));
    p.rect(11, 13, 2, 2, C('#ffcf7a'));
    const top = [1, 4, 6][f];
    const coil = C('#d4dbf2');
    const coilD = C('#7a84a8');
    for (let y = top + 3; y < 10; y++) {
      const zig = (y - top) % 3;
      p.rect(4 + zig, y, 8 - zig * 2 + 1, 1, zig === 1 ? coilD : coil);
    }
    p.rect(2, top, 12, 3, C('#ff4a4a'));
    p.rect(2, top, 12, 1, C('#ffb0a0'));
    p.rect(2, top + 2, 12, 1, C('#a81e2a'));
    p.outline(C('#0a0c1e'));
    return p.toCanvas();
  }));
}

function boosterFrames(dir) {
  return anim(`boost${dir}`, () => {
    const out = [];
    for (let f = 0; f < 8; f++) {
      const p = new Pix(16, 6);
      p.rect(0, 0, 16, 6, C('#140c2a'));
      p.rect(0, 0, 16, 1, C('#3a2a6a'));
      for (let k = -1; k < 3; k++) {
        const x0 = ((k * 8 + f * dir * 2) % 16 + 16) % 16;
        for (let j = 0; j < 4; j++) {
          const dx = dir > 0 ? (j < 2 ? j : 3 - j) : (j < 2 ? 1 - j : j - 2);
          const col = j === 1 || j === 2 ? C('#ffffff') : C('#66e1ff');
          p.set((x0 + dx) % 16, 1 + j, col);
          p.set((x0 + dx + 1) % 16, 1 + j, C('#66e1ff'));
        }
      }
      out.push(p.toCanvas());
    }
    return out;
  });
}

function crumbleCanvas(world, crack) {
  return anim(`crumble|${world}|${crack}`, () => paintCrumble(world, crack).toCanvas());
}

/**
 * Draw the animated tiles that fall inside the view. `ox`, `oy` is the view
 * origin in internal pixels.
 */
export function drawAnimatedTiles(ctx, lv, world, ox, oy, vw, vh, time, fx) {
  const tx0 = Math.max(0, Math.floor(ox / TILE));
  const ty0 = Math.max(0, Math.floor(oy / TILE));
  const tx1 = Math.min(lv.w - 1, Math.floor((ox + vw) / TILE));
  const ty1 = Math.min(lv.h - 1, Math.floor((oy + vh) / TILE));
  const springs = springFrames();
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const c = lv.tiles[ty * lv.w + tx];
      const sx = tx * TILE - ox;
      const sy = ty * TILE - oy;
      if (c === T.SPRING) {
        const k = fx.springs.get(ty * lv.w + tx) || 0;
        const f = k > 0.12 ? 2 : k > 0 ? 1 : 0;
        ctx.drawImage(springs[f === 2 ? 2 : f === 1 ? 0 : 1 - 1], sx, sy);
      } else if (c === T.BOOST_R || c === T.BOOST_L) {
        const fr = boosterFrames(c === T.BOOST_R ? 1 : -1);
        ctx.drawImage(fr[Math.floor(time * 16) % 8], sx, sy);
      } else if (c === T.CRUMBLE) {
        const s = lv.crumble.get(ty * lv.w + tx);
        if (!s) ctx.drawImage(crumbleCanvas(world, false), sx, sy);
        else if (s.phase === 'shake') {
          const j = Math.floor(time * 40) % 2 ? 1 : -1;
          ctx.drawImage(crumbleCanvas(world, true), sx + j, sy + (s.t < 0.2 ? 1 : 0));
        } else if (s.phase === 'back') {
          ctx.globalAlpha = 1 - s.t / 0.3;
          ctx.drawImage(crumbleCanvas(world, false), sx, sy);
          ctx.globalAlpha = 1;
        }
      }
    }
  }
}

/** Updraft columns: drifting streaks, drawn additively. */
export function drawUpdrafts(ctx, lv, ox, oy, vw, vh, time, color) {
  for (const z of lv.updrafts) {
    const x = z.x0 * TILE - ox;
    if (x < -TILE || x > vw) continue;
    const top = z.liftTop * TILE - oy;
    const bottom = z.bottom * TILE - oy;
    if (bottom < 0 || top > vh) continue;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.08;
    ctx.fillRect(x + 2, Math.round(top), 12, Math.round(bottom - top));
    ctx.globalAlpha = 0.55;
    for (let k = 0; k < 7; k++) {
      const ph = (time * (1.1 + k * 0.13) + k * 0.37) % 1;
      const y = bottom - ph * (bottom - top);
      const sx = x + 2 + ((k * 5 + Math.floor(time * 3 + k)) % 12);
      ctx.fillRect(sx, Math.round(y), 1, 4 + (k % 3));
    }
    ctx.globalAlpha = 1;
  }
}

export function drawFalseWalls(ctx, lv, ox, oy) {
  for (const g of lv.falseGroups) {
    if (!g.canvas) continue;
    const x = g.minX * TILE - ox;
    const y = g.minY * TILE - oy;
    if (x > ctx.canvas.width || y > ctx.canvas.height || x + g.canvas.width < 0 || y + g.canvas.height < 0) continue;
    ctx.globalAlpha = 1 - g.reveal * 0.7;
    ctx.drawImage(g.canvas, x, y);
    ctx.globalAlpha = 1;
  }
}

export { mix };
