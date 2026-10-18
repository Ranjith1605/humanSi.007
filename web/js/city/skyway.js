// Synergy City — skyway. Flying traffic over the Purpose Quarter: the sky-pods
// from skypod.js on one-way loops above the street grid. Every lane is a
// rounded rectangle over the roads at its own height, so lanes that cross in
// plan pass over each other instead of meeting. Pods keep a time gap to the pod
// ahead (a small car-following rule), bank into the corners, bob very slightly,
// and their under-glow and nav lights brighten after dark.
//
// The fleet is six InstancedMeshes (hull, canopy, rotors, under-glow, nav
// lights, nav halos) sharing one instance-matrix buffer: one compose and one
// upload per pod per step, and six draw calls whatever the fleet size. A perf
// drop only lowers `mesh.count`; the simulation is a few multiplies per pod.
import * as THREE from '../../vendor/three/three.module.js';
import { makeSkyPodParts } from './skypod.js';

// Lanes over the roads (x or z = ±48, ±96; the avenues at 0), one direction
// each, every one at its own height. Loops that share a road run opposite ways
// along it, so each street reads as a two-way skyway. 70 m is left empty on
// purpose: it is the roadster's cruise height, so a player flying it passes
// between the low lane and the stack above instead of through traffic. Lanes
// that are neighbours in height never share a corner, which is what lets them
// sit only 3 m apart: a banked pod still clears the level one above (MAX_BANK).
const LANES = [
  { x0: -96, x1: 96, z0: -96, z1: 96, y: 64, dir: 1 },   // outer ring
  { x0: -48, x1: 48, z0: -48, z1: 48, y: 74, dir: -1 },  // inner ring
  { x0: -96, x1: 0, z0: -48, z1: 96, y: 77, dir: 1 },    // west loop
  { x0: 0, x1: 96, z0: -96, z1: 48, y: 80, dir: 1 },     // east loop
  { x0: -48, x1: 96, z0: 0, z1: 96, y: 83, dir: -1 },    // north loop
  { x0: -96, x1: 48, z0: -96, z1: 0, y: 86, dir: -1 },   // south loop
  { x0: -48, x1: 48, z0: -48, z1: 48, y: 89, dir: 1 },   // inner ring, return
  { x0: -96, x1: 96, z0: -96, z1: 96, y: 92, dir: -1 },  // outer ring, return
];

const R = 18;              // corner radius (m): a sweep over the block corner
const POD_LEN = 4.6;       // nose to tail, with a hand's width to spare
const S0 = 9;              // bumper gap kept even when stopped (m)
const HEADWAY = 1.1;       // time gap kept to the pod ahead (s)
const ACCEL = 2.4;         // comfortable acceleration (m/s^2)
const BRAKE = 3.2;         // comfortable braking (m/s^2)
const MAX_BANK = 0.35;     // rad (~20 deg); with BOB, keeps 3 m stacking clear
const BOB = 0.15;          // metres: alive, not seasick
const GRAV = 9.81;
const COUNTS = { high: 80, low: 24 };
const SHARE = [1, 0.5, 0.25]; // fleet shown at perf level 0 / 1 / 2
const TAU = Math.PI * 2;

// Hull finishes: mostly calm neutrals, a few in the quarter's violet family and
// some quiet accents, so the sky looks lived-in rather than like a parade.
const PALETTE = [
  [0xe8ebf0, 3], // pearl
  [0xb9c0cc, 3], // silver
  [0x2a2f3c, 2], // graphite
  [0x3e5487, 2], // slate blue
  [0x8b6fd6, 2], // violet
  [0x4fa7b8, 1], // teal
  [0xd8c6a5, 1], // sand
  [0x5c3a63, 1], // plum
];
const PALETTE_WEIGHT = PALETTE.reduce((s, [, w]) => s + w, 0);

function pickHull(r) {
  let x = r * PALETTE_WEIGHT;
  for (const [hex, w] of PALETTE) { if ((x -= w) < 0) return hex; }
  return PALETTE[0][0];
}

/** Precompute a lane's straight and corner lengths and its total loop length. */
function makeLane(def) {
  const w = def.x1 - def.x0 - 2 * R;
  const d = def.z1 - def.z0 - 2 * R;
  const arc = (Math.PI / 2) * R;
  const seg = [w, arc, d, arc, w, arc, d, arc];
  const starts = new Float64Array(9);
  for (let i = 0; i < 8; i++) starts[i + 1] = starts[i] + seg[i];
  return { ...def, starts, L: starts[8] };
}

/**
 * Where a lane is at arc length `s`: writes { x, z, yaw, k } into `out`, with
 * yaw about +Y (the pod's nose is +Z) and k the signed curvature dyaw/ds
 * (positive turns left). The loop is laid out once in one rotational sense:
 * east along z0, north along x1, west along z1, south along x0; a lane with
 * dir -1 runs it backwards.
 */
function lanePoint(lane, s, out) {
  const { x0, x1, z0, z1, starts, L } = lane;
  let u = s - Math.floor(s / L) * L;
  if (lane.dir < 0) u = L - u;
  let i = 0;
  while (i < 7 && u >= starts[i + 1]) i++;
  u -= starts[i];
  let th = 0;
  let cx = 0;
  let cz = 0;
  switch (i) {
    case 0: out.x = x0 + R + u; out.z = z0; out.yaw = Math.PI / 2; out.k = 0; break;
    case 2: out.x = x1; out.z = z0 + R + u; out.yaw = 0; out.k = 0; break;
    case 4: out.x = x1 - R - u; out.z = z1; out.yaw = -Math.PI / 2; out.k = 0; break;
    case 6: out.x = x0; out.z = z1 - R - u; out.yaw = Math.PI; out.k = 0; break;
    default:
      // Corners: centre and starting angle per quadrant; the heading is -theta
      // because the tangent of (cos t, sin t) is (-sin t, cos t).
      if (i === 1) { cx = x1 - R; cz = z0 + R; th = -Math.PI / 2; }
      else if (i === 3) { cx = x1 - R; cz = z1 - R; th = 0; }
      else if (i === 5) { cx = x0 + R; cz = z1 - R; th = Math.PI / 2; }
      else { cx = x0 + R; cz = z0 + R; th = Math.PI; }
      th += u / R;
      out.x = cx + R * Math.cos(th);
      out.z = cz + R * Math.sin(th);
      out.yaw = -th;
      out.k = -1 / R;
  }
  if (lane.dir < 0) { out.yaw += Math.PI; out.k = -out.k; }
  return out;
}

// Nav-light halos: an inner and an outer additive shell on each of the three
// nav lights (skypod.js positions), the faked bloom that makes them read at
// night from the street 60+ m below. Icosahedra: at that range shape is moot.
function makeHaloGeometry() {
  const lights = [
    [1.9, 0.05, 1.15, 0xff3b4d], // port, red
    [-1.9, 0.05, 1.15, 0x3bff9a], // starboard, green
    [0, 0.12, -2.2, 0xffffff], // tail, white
  ];
  const shells = [[0.3, 1], [0.75, 0.32]];
  const unit = new THREE.IcosahedronGeometry(1, 0); // non-indexed already
  const src = unit.attributes.position.array;
  const per = src.length / 3;
  const n = per * lights.length * shells.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  let o = 0;
  for (const [lx, ly, lz, hex] of lights) {
    for (const [r, b] of shells) {
      c.setHex(hex).multiplyScalar(b);
      for (let v = 0; v < per; v++, o++) {
        pos[o * 3] = lx + src[v * 3] * r;
        pos[o * 3 + 1] = ly + src[v * 3 + 1] * r;
        pos[o * 3 + 2] = lz + src[v * 3 + 2] * r;
        col[o * 3] = c.r; col[o * 3 + 1] = c.g; col[o * 3 + 2] = c.b;
      }
    }
  }
  unit.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// `world` is not read: the lanes follow the road grid the contract fixes and
// world.js lays out. It stays in the signature to match the other builders.
export function buildSkyway(ctx, world) {
  const { scene, rng, quality, env, register, clock } = ctx;
  const perf = ctx.perf;
  const low = quality === 'low';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const total = COUNTS[low ? 'low' : 'high'];
  const lanes = LANES.map(makeLane);

  const group = new THREE.Group();
  group.name = 'skyway';
  scene.add(group);

  // --- share the fleet across lanes by length (largest remainder, >= 1 each)
  const sumL = lanes.reduce((s, l) => s + l.L, 0);
  const spare = total - lanes.length;
  const ideal = lanes.map((l) => (spare * l.L) / sumL);
  const perLane = ideal.map((x) => 1 + Math.floor(x));
  let left = total - perLane.reduce((s, n) => s + n, 0);
  const byRemainder = ideal.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let j = 0; left > 0; j++, left--) perLane[byRemainder[j % lanes.length][1]]++;

  // --- pods: seeded lane slot, speed, phase and finish ---------------------
  // Each lane gets a cruise speed that rises with height (the high lanes are
  // the express ones), and each pod a few m/s either side of it, inside 18-32.
  // Even spacing with a little jitter, so nobody starts on anyone's tail.
  //
  // Instance order is visibility priority: perf levels show a prefix of the
  // fleet (mesh.count), so every fourth pod of each lane comes first, then
  // the in-between ones, then the rest. A cut then thins every lane evenly
  // instead of emptying some.
  const pods = [];
  const col = new THREE.Color();
  lanes.forEach((lane, li) => {
    const n = perLane[li];
    const laneV = 19 + ((lane.y - 64) / 28) * 9 + rng() * 3;
    const tierN = [0, 0, 0];
    const members = [];
    for (let k = 0; k < n; k++) {
      const tier = k % 4 === 0 ? 0 : k % 2 === 0 ? 1 : 2;
      const v0 = Math.min(32, Math.max(18, laneV + (rng() - 0.5) * 3));
      const hull = pickHull(rng());
      const shade = (rng() - 0.5) * 0.06;
      const pod = {
        lane, s: ((k + 0.5 + (rng() - 0.5) * 0.6) / n) * lane.L,
        v: v0, v0, acc: 0, phase: rng() * TAU, bank: 0, pitch: 0,
        color: col.setHex(hull).offsetHSL(0, 0, shade).clone(),
        tier, rank: tierN[tier]++, key: 0, lead: null,
      };
      members.push(pod);
    }
    for (let k = 0; k < n; k++) {
      const p = members[k];
      p.lead = members[(k + 1) % n];
      p.key = p.tier + (p.rank + 0.5) / tierN[p.tier] * 0.999 + li * 1e-6;
      pods.push(p);
    }
  });
  pods.sort((a, b) => a.key - b.key);

  // --- meshes: one per part, all reading one shared matrix buffer ----------
  const parts = makeSkyPodParts({ low });
  const haloGeo = makeHaloGeometry();
  const haloMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const shared = new THREE.InstancedBufferAttribute(new Float32Array(total * 16), 16);
  shared.setUsage(THREE.DynamicDrawUsage);
  const meshes = [];
  const addMesh = (geo, mat, name, order) => {
    // Built at count 0 so the constructor doesn't fill a buffer we replace.
    const m = new THREE.InstancedMesh(geo, mat, 0);
    m.instanceMatrix = shared;
    m.count = total;
    m.name = 'skyway-' + name;
    m.renderOrder = order;
    // Pods range over the whole district: a bounding sphere would be the
    // district anyway, and a stale one makes pods pop at the screen edge.
    m.frustumCulled = false;
    group.add(m);
    meshes.push(m);
    return m;
  };
  const M = parts.materials;
  const hullMesh = addMesh(parts.hull, M.hull, 'hull', 0);
  addMesh(parts.rotors, M.rotors, 'rotors', 0);
  addMesh(parts.nav, M.nav, 'nav', 0);
  addMesh(parts.canopy, M.canopy, 'canopy', 1);
  addMesh(parts.glow, M.glow, 'glow', 2);
  addMesh(haloGeo, haloMat, 'halo', 3);
  for (let i = 0; i < total; i++) hullMesh.setColorAt(i, pods[i].color);
  hullMesh.instanceColor.needsUpdate = true;

  // --- per-step scratch: nothing below allocates ---------------------------
  const P = { x: 0, z: 0, yaw: 0, k: 0 };
  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ'); // yaw, then pitch, then roll
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const arr = shared.array;
  const sqrtAB = 2 * Math.sqrt(ACCEL * BRAKE);

  let count = total;
  let disposed = false;

  // Car-following (the intelligent-driver rule): ease toward a desired speed,
  // brake as the gap closes on the pod ahead. Every pod is simulated, shown or
  // not, so a pod that reappears after a perf drop is already in its place.
  // The desired speed breathes slowly per pod so platoons form and loosen
  // instead of locking into a train behind the slowest pod.
  function simulate(dt, t) {
    for (let i = 0; i < pods.length; i++) {
      const p = pods[i];
      const lead = p.lead;
      let gap = lead.s - p.s;
      if (gap <= 0) gap += p.lane.L; // the leader is ahead around the loop (or is us)
      gap = Math.max(0.1, gap - POD_LEN);
      const want = p.v0 * (1 + 0.07 * Math.sin(t * 0.17 + p.phase));
      const sStar = S0 + Math.max(0, p.v * HEADWAY + (p.v * (p.v - lead.v)) / sqrtAB);
      const r = p.v / want;
      p.acc = Math.max(-9, ACCEL * (1 - r * r * r * r - (sStar / gap) * (sStar / gap)));
    }
    for (let i = 0; i < pods.length; i++) {
      const p = pods[i];
      p.v = Math.max(0, p.v + p.acc * dt);
      p.s += p.v * dt;
      if (p.s >= p.lane.L) p.s -= p.lane.L;
    }
  }

  // Compose the shown pods' matrices into the shared buffer. `dt` eases the
  // bank and pitch; 0 places pods without easing (after a count change).
  function writeMatrices(dt, t) {
    const ease = Math.min(1, dt * 3.5);
    for (let i = 0; i < count; i++) {
      const p = pods[i];
      lanePoint(p.lane, p.s, P);
      let y = p.lane.y;
      if (!reduceMotion) {
        // Bank like a coordinated turn (tan bank = v^2 k / g), softened and
        // capped; left turns roll the port (+X) side down, hence the minus.
        const want = -Math.max(-MAX_BANK, Math.min(MAX_BANK, 0.6 * Math.atan((p.v * p.v * P.k) / GRAV)));
        p.bank += (want - p.bank) * ease;
        // Nose dips a touch to speed up and lifts to slow, as a rotor craft does.
        const tilt = Math.max(-0.06, Math.min(0.06, p.acc * 0.03));
        p.pitch += (tilt - p.pitch) * ease * 0.6;
        y += BOB * Math.sin(t * 1.1 + p.phase);
      }
      pos.set(P.x, y, P.z);
      euler.set(p.pitch, P.yaw, p.bank);
      quat.setFromEuler(euler);
      mat4.compose(pos, quat, one).toArray(arr, i * 16);
    }
    shared.needsUpdate = true;
  }

  // Night: the under-glow, cabin and rotor rims and nav halos come up as the
  // sun goes down (same curve as world.js: 1 at midnight, 0 at noon). The halo
  // never goes fully off, so its shader is compiled at load, not at dusk.
  let lastTod = -1;
  function applyNight() {
    const tod = env.timeOfDay;
    if (Math.abs(tod - lastTod) < 0.002) return;
    lastTod = tod;
    const night = Math.pow(0.5 + 0.5 * Math.cos(tod * TAU), 1.25);
    M.glow.opacity = 0.22 + night * 0.68;
    M.canopy.emissiveIntensity = 0.2 + night * 0.65;
    M.rotors.emissiveIntensity = 0.12 + night * 0.7;
    haloMat.opacity = 0.04 + night * 0.86;
  }

  function setLevel(level) {
    const lv = Math.max(0, Math.min(2, level | 0));
    count = Math.max(1, Math.round(total * SHARE[lv]));
    for (const m of meshes) m.count = count;
    writeMatrices(0, clock.time);
  }

  setLevel(perf ? perf.level : 0);
  applyNight();
  // perf has no unsubscribe; a disposed skyway just ignores the call.
  perf?.onChange((level) => { if (!disposed) setLevel(level); });

  // A test hook (?debug=1 only), the same object buildSkyway returns.
  const api = {
    lanes: lanes.length,
    get total() { return total; },
    get count() { return count; },
    /** Positions of the shown pods as [x, y, z]; allocates, so debug use only. */
    snapshot() {
      const out = [];
      for (let i = 0; i < count; i++) out.push([arr[i * 16 + 12], arr[i * 16 + 13], arr[i * 16 + 14]]);
      return out;
    },
    /** One shown pod's instance matrix (column-major), for orientation checks. */
    matrix(i) { return Array.from(arr.subarray(i * 16, i * 16 + 16)); },
    setVisible(on) { group.visible = !!on; },
  };
  if (new URLSearchParams(location.search).get('debug') === '1') window.__skyway = api;

  register({
    update(dt) {
      simulate(dt, clock.time);
      writeMatrices(dt, clock.time);
      applyNight();
    },
    dispose() {
      disposed = true;
      group.removeFromParent();
      for (const m of meshes) m.dispose();
      parts.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      if (window.__skyway === api) delete window.__skyway;
    },
  });

  return api;
}
