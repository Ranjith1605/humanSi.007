// Synergy City — world (Purpose Quarter). Builds the district the player walks:
// a legible road grid with an open central plaza, instanced low-poly buildings
// with windows that light up at night, streetlights along the main avenues, a
// distant skyline of the five other districts, and the sun/hemisphere/fog that
// the day/night clock drives through ctx.env. Everything repeated is an
// InstancedMesh so draw calls stay far under the ~300 budget; all placement is
// seeded (ctx.rng) so the city is identical every load.
import * as THREE from '../../vendor/three/three.module.js';

export function buildWorld(ctx) {
  const { scene, rng, collision, env, quality, register } = ctx;
  const low = quality === 'low';

  const world = new THREE.Group();
  world.name = 'world';
  scene.add(world);

  // --- district geometry constants (metres) -------------------------------
  const HALF = 144;          // walkable half-extent -> ~288 m square
  const PLAZA = 32;          // clear radius at the origin; the places live here
  const ACCENT = 0xc58bff;   // Purpose Quarter violet (gate colour M1)
  const SIDE = 2;            // sidewalk inset between road and building

  // Block edges on each axis. The five interior edges are roads; the outer two
  // (±HALF) are the district boundary, so there is no half-off-the-map road.
  const edges = [-144, -96, -48, 0, 48, 96, 144];
  const isRoad = (e) => e === -96 || e === -48 || e === 0 || e === 48 || e === 96;
  const roadHalf = (e) => (!isRoad(e) ? 0 : e === 0 ? 6 : 4);        // avenues (x/z=0) wider
  const edgeInset = (e) => (isRoad(e) ? roadHalf(e) + SIDE : 3);

  // Things to free on teardown so repeated loads don't leak GPU memory.
  const geometries = [];
  const materials = [];
  const textures = [];
  const track = (o) => { (o.isBufferGeometry ? geometries : o.isTexture ? textures : materials).push(o); return o; };

  // ======================================================================
  //  Ground: a big dark floor for the horizon, and a textured district plane
  //  that paints the road grid, the plaza and the glowing violet lane lines.
  // ======================================================================
  const w2p = (x, px) => ((x + HALF) / (HALF * 2)) * px;   // world metre -> texture pixel
  const m2p = (m, px) => (m / (HALF * 2)) * px;            // world length -> pixels

  function discPath(g, cx, cy, r) { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); }

  function makeDistrictTextures(px) {
    // Albedo: dark base, lighter pavement on the roads, a warm-violet plaza disc.
    const alb = document.createElement('canvas'); alb.width = alb.height = px;
    const a = alb.getContext('2d');
    a.fillStyle = '#0c0a1b'; a.fillRect(0, 0, px, px);        // block / base tone
    a.fillStyle = '#191230';                                  // pavement
    for (const e of edges) {
      if (!isRoad(e)) continue;
      const rw = roadHalf(e);
      a.fillRect(w2p(e - rw, px), 0, m2p(rw * 2, px), px);    // road running along z
      a.fillRect(0, w2p(e - rw, px), px, m2p(rw * 2, px));    // road running along x
    }
    // Plaza disc — a touch warmer so the centre reads as a gathering place.
    const cx = w2p(0, px), R = m2p(PLAZA, px);
    const pg = a.createRadialGradient(cx, cx, R * 0.15, cx, cx, R);
    pg.addColorStop(0, '#2a2050'); pg.addColorStop(0.75, '#211945'); pg.addColorStop(1, '#191230');
    a.fillStyle = pg; discPath(a, cx, cx, R); a.fill();

    // Emissive: violet lane lines (bright on the two avenues), faint kerbs, the
    // plaza ring and a soft plaza glow. Drawn white-violet; the material's
    // emissive colour tints it and emissiveIntensity ramps it up at night.
    const emi = document.createElement('canvas'); emi.width = emi.height = px;
    const e2 = emi.getContext('2d');
    e2.fillStyle = '#000'; e2.fillRect(0, 0, px, px);
    e2.strokeStyle = '#d7b3ff'; e2.lineCap = 'round';
    const lineV = (x, w, al) => { e2.globalAlpha = al; e2.lineWidth = m2p(w, px); e2.beginPath(); e2.moveTo(w2p(x, px), 0); e2.lineTo(w2p(x, px), px); e2.stroke(); };
    const lineH = (z, w, al) => { e2.globalAlpha = al; e2.lineWidth = m2p(w, px); e2.beginPath(); e2.moveTo(0, w2p(z, px)); e2.lineTo(px, w2p(z, px)); e2.stroke(); };
    for (const e of edges) {
      if (!isRoad(e)) continue;
      const main = e === 0, rw = roadHalf(e);
      lineV(e, main ? 0.7 : 0.4, main ? 0.95 : 0.5);         // centre line
      lineH(e, main ? 0.7 : 0.4, main ? 0.95 : 0.5);
      lineV(e - rw, 0.3, 0.3); lineV(e + rw, 0.3, 0.3);      // kerbs
      lineH(e - rw, 0.3, 0.3); lineH(e + rw, 0.3, 0.3);
    }
    lineV(-HALF, 0.5, 0.35); lineV(HALF, 0.5, 0.35);         // district boundary
    lineH(-HALF, 0.5, 0.35); lineH(HALF, 0.5, 0.35);
    e2.globalAlpha = 0.9; e2.lineWidth = m2p(0.8, px);        // plaza ring
    discPath(e2, cx, cx, R); e2.stroke();
    const gg = e2.createRadialGradient(cx, cx, R * 0.1, cx, cx, R);  // soft plaza glow
    gg.addColorStop(0, 'rgba(197,139,255,0.5)'); gg.addColorStop(1, 'rgba(197,139,255,0)');
    e2.globalAlpha = 1; e2.fillStyle = gg; discPath(e2, cx, cx, R); e2.fill();

    const mk = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = low ? 1 : 4; return track(t); };
    return { map: mk(alb), emissive: mk(emi) };
  }

  const gtex = makeDistrictTextures(low ? 1024 : 2048);

  const baseFloor = new THREE.Mesh(
    track(new THREE.PlaneGeometry(1100, 1100)),
    track(new THREE.MeshStandardMaterial({ color: 0x06060e, roughness: 1, metalness: 0 })),
  );
  baseFloor.rotation.x = -Math.PI / 2;
  world.add(baseFloor);

  const districtMat = track(new THREE.MeshStandardMaterial({
    map: gtex.map, emissive: new THREE.Color(ACCENT), emissiveMap: gtex.emissive,
    emissiveIntensity: 0.3, roughness: 0.92, metalness: 0.0,
  }));
  const districtPlane = new THREE.Mesh(track(new THREE.PlaneGeometry(HALF * 2, HALF * 2)), districtMat);
  districtPlane.rotation.x = -Math.PI / 2;
  districtPlane.position.y = 0.02;
  world.add(districtPlane);

  // ======================================================================
  //  Buildings: three archetypes (slim towers / mid blocks / low units),
  //  one InstancedMesh batch each, sharing a unit box. Windows come from an
  //  emissive-map grid per archetype whose intensity the clock drives.
  // ======================================================================
  const unitBox = track(new THREE.BoxGeometry(1, 1, 1));

  // A grid of lit windows on black; the material emissive colour tints it.
  function makeWindowTex(cols, rows) {
    const px = low ? 128 : 256;
    const c = document.createElement('canvas'); c.width = c.height = px;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, px, px);
    const cw = px / cols, ch = px / rows, pad = Math.max(2, cw * 0.16), rad = Math.min(4, cw * 0.18);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      // deterministic, Math.random-free: a hash decides which panes are lit.
      const h = ((i * 73856093) ^ (j * 19349663) ^ (cols * 83492791)) >>> 0;
      if (h % 100 < 34) continue;                 // ~1/3 of panes dark
      const b = 0.5 + ((h >>> 3) % 50) / 100;      // vary brightness
      g.fillStyle = `rgba(255,255,255,${b.toFixed(3)})`;
      const x = i * cw + pad, y = j * ch + pad, ww = cw - pad * 2, hh = ch - pad * 2;
      g.beginPath();
      g.moveTo(x + rad, y); g.arcTo(x + ww, y, x + ww, y + hh, rad);
      g.arcTo(x + ww, y + hh, x, y + hh, rad); g.arcTo(x, y + hh, x, y, rad);
      g.arcTo(x, y, x + ww, y, rad); g.closePath(); g.fill();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return track(t);
  }

  // Warm-violet interior light so the quarter reads as inhabited but on-theme.
  const winEmissive = new THREE.Color(0xe7c8ff);
  const archetypes = [
    { tex: makeWindowTex(3, low ? 5 : 8), ff: [0.40, 0.18], h: low ? [20, 20] : [26, 30], light: [0.15, 0.12] },
    { tex: makeWindowTex(5, 4), ff: [0.58, 0.22], h: [12, 16], light: [0.22, 0.14] },
    { tex: makeWindowTex(6, 2), ff: [0.64, 0.24], h: [5, 7], light: [0.28, 0.14] },
  ];
  const archMats = archetypes.map((a) => track(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.86, metalness: 0.04,
    emissive: winEmissive, emissiveMap: a.tex, emissiveIntensity: 0.0,
  })));
  const batches = archetypes.map(() => ({ mats: [], cols: [] }));

  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const tmpC = new THREE.Color();

  // Nearest distance from the origin to a footprint rectangle (for plaza test).
  const rectDistToOrigin = (minX, maxX, minZ, maxZ) => {
    const nx = Math.max(minX, Math.min(0, maxX));
    const nz = Math.max(minZ, Math.min(0, maxZ));
    return Math.hypot(nx, nz);
  };

  function placeBuilding(cx, cz, fw, fd, arch) {
    const a = archetypes[arch];
    const h = a.h[0] + rng() * a.h[1];
    tmpS.set(fw, h, fd);
    tmpP.set(cx, h / 2, cz);
    tmpM.compose(tmpP, tmpQ, tmpS);
    batches[arch].mats.push(tmpM.clone());
    // Cool violet-blue hull; a few punch brighter to accent the skyline.
    let hue = 0.70 + rng() * 0.09, sat = 0.16 + rng() * 0.24, lig = a.light[0] + rng() * a.light[1];
    if (rng() < 0.09) { hue = 0.78; sat = 0.55; lig = 0.44; }
    batches[arch].cols.push(tmpC.setHSL(hue, sat, lig).clone());
    collision.addBox(cx, cz, fw / 2 + 0.4, fd / 2 + 0.4, { tag: 'building' });
  }

  for (let i = 0; i < edges.length - 1; i++) {
    for (let j = 0; j < edges.length - 1; j++) {
      const x0 = edges[i] + edgeInset(edges[i]);
      const x1 = edges[i + 1] - edgeInset(edges[i + 1]);
      const z0 = edges[j] + edgeInset(edges[j]);
      const z1 = edges[j + 1] - edgeInset(edges[j + 1]);
      const bw = x1 - x0, bd = z1 - z0;
      if (bw < 8 || bd < 8) continue;

      const sub = low ? 1 : rng() < 0.5 ? 2 : 1;   // some blocks are one big unit
      const cw = bw / sub, cd = bd / sub;
      for (let sx = 0; sx < sub; sx++) {
        for (let sz = 0; sz < sub; sz++) {
          if (rng() < 0.1) continue;               // the odd courtyard / gap
          const ccx = x0 + cw * (sx + 0.5);
          const ccz = z0 + cd * (sz + 0.5);
          const r = rng();
          const arch = r < 0.34 ? 0 : r < 0.72 ? 1 : 2;
          const a = archetypes[arch];
          let fw = Math.min(cw - 1.5, cw * (a.ff[0] + rng() * a.ff[1]));
          let fd = Math.min(cd - 1.5, cd * (a.ff[0] + rng() * a.ff[1]));
          fw = Math.max(5, fw); fd = Math.max(5, fd);
          const jx = (rng() - 0.5) * Math.max(0, cw - fw) * 0.6;
          const jz = (rng() - 0.5) * Math.max(0, cd - fd) * 0.6;
          const cx = ccx + jx, cz = ccz + jz;
          if (rectDistToOrigin(cx - fw / 2, cx + fw / 2, cz - fd / 2, cz + fd / 2) < PLAZA + 2) continue;
          placeBuilding(cx, cz, fw, fd, arch);
        }
      }
    }
  }

  const buildingMeshes = batches.map((b, k) => {
    const mesh = new THREE.InstancedMesh(unitBox, archMats[k], b.mats.length);
    mesh.name = 'buildings-' + k;
    for (let i = 0; i < b.mats.length; i++) { mesh.setMatrixAt(i, b.mats[i]); mesh.setColorAt(i, b.cols[i]); }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;   // instances span the whole district
    world.add(mesh);
    return mesh;
  });

  // ======================================================================
  //  Streetlights along the two avenues: instanced posts + emissive heads +
  //  an additive glow shell (faked bloom). A few real PointLights pool light
  //  around the plaza where it matters; the rest is emissive-only.
  // ======================================================================
  const lampXZ = [];
  const spacing = low ? 48 : 26;
  const off = 7;
  for (let p = -HALF + spacing * 0.6; p <= HALF; p += spacing) {
    if (Math.abs(p) < PLAZA + 6) continue;         // plaza handled by PointLights
    lampXZ.push([p, off], [p, -off]);              // avenue z = 0
    lampXZ.push([off, p], [-off, p]);              // avenue x = 0
  }

  const postGeo = track(new THREE.CylinderGeometry(0.12, 0.16, 5, 6));
  const headGeo = track(new THREE.SphereGeometry(0.34, 8, 6));
  const glowGeo = track(new THREE.SphereGeometry(1.05, 10, 8));
  const postMat = track(new THREE.MeshStandardMaterial({ color: 0x241d3a, roughness: 0.7, metalness: 0.3 }));
  const headMat = track(new THREE.MeshStandardMaterial({ color: 0x120a22, emissive: new THREE.Color(ACCENT), emissiveIntensity: 0.0 }));
  const glowMat = track(new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));

  const posts = new THREE.InstancedMesh(postGeo, postMat, lampXZ.length);
  const heads = new THREE.InstancedMesh(headGeo, headMat, lampXZ.length);
  const glows = new THREE.InstancedMesh(glowGeo, glowMat, lampXZ.length);
  glows.renderOrder = 3;
  lampXZ.forEach(([x, z], i) => {
    tmpM.compose(tmpP.set(x, 2.5, z), tmpQ, tmpS.set(1, 1, 1)); posts.setMatrixAt(i, tmpM);
    tmpM.compose(tmpP.set(x, 5.3, z), tmpQ, tmpS.set(1, 1, 1)); heads.setMatrixAt(i, tmpM); glows.setMatrixAt(i, tmpM);
  });
  [posts, heads, glows].forEach((m) => { m.instanceMatrix.needsUpdate = true; m.frustumCulled = false; world.add(m); });

  const pointLights = [];
  const plPos = low ? [[0, -4]] : [[PLAZA - 6, 0], [-(PLAZA - 6), 0], [0, PLAZA - 6], [0, -(PLAZA - 6)]];
  const PL_MAX = 55;
  for (const [x, z] of plPos) {
    const pl = new THREE.PointLight(ACCENT, 0, 46, 2);
    pl.position.set(x, 6, z);
    world.add(pl);
    pointLights.push(pl);
  }

  // ======================================================================
  //  Distant skyline: the five other districts as low-detail massing beyond
  //  the wall, each sector tinted its own accent family. One InstancedMesh.
  // ======================================================================
  const skyCount = low ? 44 : 90;
  const skyMat = track(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    emissive: new THREE.Color(0x37304c), emissiveIntensity: 0.0,
  }));
  const skyline = new THREE.InstancedMesh(unitBox, skyMat, skyCount);
  const sectorHue = [0.52, 0.34, 0.09, 0.97, 0.80];   // cyan / green / amber / rose / violet
  for (let i = 0; i < skyCount; i++) {
    const sector = i % 5;
    const ang = sector * (Math.PI * 2 / 5) + (rng() - 0.5) * (Math.PI * 2 / 5) * 0.85;
    const r = HALF + 55 + rng() * 300;
    const w = 12 + rng() * 30, d = 12 + rng() * 30, h = 24 + rng() * 150;
    tmpM.compose(tmpP.set(Math.cos(ang) * r, h / 2, Math.sin(ang) * r), tmpQ, tmpS.set(w, h, d));
    skyline.setMatrixAt(i, tmpM);
    skyline.setColorAt(i, tmpC.setHSL(sectorHue[sector], 0.3, 0.05 + rng() * 0.05));
  }
  skyline.instanceMatrix.needsUpdate = true;
  if (skyline.instanceColor) skyline.instanceColor.needsUpdate = true;
  skyline.frustumCulled = false;
  world.add(skyline);

  // ======================================================================
  //  Lighting + fog, handed to env so the day/night clock drives colour/angle.
  // ======================================================================
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(80, 140, 60);
  const hemi = new THREE.HemisphereLight(0x8aa0e0, 0x0a0a16, 0.6);
  world.add(sun, hemi);
  scene.fog = new THREE.Fog(0x15102a, low ? 50 : 60, low ? 340 : 430);
  env.attach({ sun, hemi, fog: scene.fog, sky: true });

  // ======================================================================
  //  Night driver: windows, lane lines, lamp glow and plaza lights ramp with
  //  darkness. night = 1 at midnight, 0 at noon. Cheap, read each step.
  // ======================================================================
  function applyEnv() {
    const t = env.timeOfDay;
    const night = Math.pow(0.5 + 0.5 * Math.cos(t * Math.PI * 2), 1.25);
    for (const m of archMats) m.emissiveIntensity = 0.04 + night * 1.35;
    districtMat.emissiveIntensity = 0.22 + night * 0.95;
    headMat.emissiveIntensity = 0.25 + night * 2.4;
    glowMat.opacity = 0.05 + night * 0.5;
    skyMat.emissiveIntensity = 0.05 + night * 0.7;
    const plI = night * PL_MAX;
    for (const pl of pointLights) pl.intensity = plI;
  }
  applyEnv();   // so the very first rendered frame already matches the clock

  register({
    update() { applyEnv(); },
    dispose() {
      world.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  });

  return {
    districtName: 'Purpose Quarter',
    spawn: new THREE.Vector3(0, 0, -(PLAZA - 10)),   // south edge of the plaza, facing in
    bounds: { min: [-HALF, -HALF], max: [HALF, HALF] },
  };
}
