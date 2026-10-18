// Sky-pods: the flying car of the ISV Synergy's cities, an original design
// shared by Synergy City's skyway and Architect's flying traffic so both skies
// match. Each part is its own geometry so a fleet is one InstancedMesh per part:
// a teardrop hull, a glass canopy, four ducted rotor rings, an under-glow disc
// and red/green nav lights. The nose points +Z; the pod is ~4.4 m long with its
// origin at the hull's centre.
import * as THREE from '../../vendor/three/three.module.js';

// Concatenate geometries into one non-indexed geometry. three's own helper
// lives in an addon we don't vendor, and these parts are tiny.
function merge(geoms, withColor = false) {
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  const n = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = withColor ? new Float32Array(n * 3) : null;
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (col) col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const g of geoms) g.dispose();
  for (const g of parts) g.dispose();
  return out;
}

function tint(geom, hex) {
  const c = new THREE.Color(hex);
  const n = geom.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geom;
}

/** Build the parts. `low` trims segment counts for phones. */
export function makeSkyPodParts({ low = false } = {}) {
  const seg = low ? 8 : 14;

  // Hull: a lathe teardrop revolved around Y, laid along Z (rotateX maps +Y to
  // +Z), then flattened so it reads as a car, not a missile.
  const profile = [
    [0, -2.2], [0.42, -2.05], [0.78, -1.5], [0.95, -0.6], [0.92, 0.4],
    [0.74, 1.3], [0.42, 1.95], [0, 2.2],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const hull = new THREE.LatheGeometry(profile, seg);
  hull.rotateX(Math.PI / 2);
  hull.scale(1.15, 0.55, 1);

  // Canopy: a half-dome, stretched and set forward of centre.
  const canopy = new THREE.SphereGeometry(0.62, seg, Math.max(4, seg >> 1), 0, Math.PI * 2, 0, Math.PI / 2);
  canopy.scale(0.95, 0.75, 1.55);
  canopy.translate(0, 0.32, 0.35);

  // Four ducted rotors on short outriggers.
  const rings = [];
  for (const [x, z] of [[-1.35, 1.15], [1.35, 1.15], [-1.35, -1.25], [1.35, -1.25]]) {
    const ring = new THREE.TorusGeometry(0.52, 0.1, 6, seg);
    ring.rotateX(Math.PI / 2);
    ring.translate(x, 0.02, z);
    rings.push(ring);
    const arm = new THREE.BoxGeometry(0.75, 0.08, 0.14);
    arm.translate(x * 0.62, 0.02, z * 0.9);
    rings.push(arm);
  }
  const rotors = merge(rings);

  // Under-glow, facing down.
  const glow = new THREE.CircleGeometry(1.15, seg);
  glow.rotateX(Math.PI / 2);
  glow.translate(0, -0.42, 0);

  // Nav lights: red to port, green to starboard, white at the tail. Facing +Z
  // with +Y up, the pod's left (port) is +X.
  const red = tint(new THREE.SphereGeometry(0.11, 6, 4).translate(1.9, 0.05, 1.15), 0xff3b4d);
  const green = tint(new THREE.SphereGeometry(0.11, 6, 4).translate(-1.9, 0.05, 1.15), 0x3bff9a);
  const white = tint(new THREE.SphereGeometry(0.09, 6, 4).translate(0, 0.12, -2.2), 0xffffff);
  const nav = merge([red, green, white], true);

  const materials = {
    hull: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.55, roughness: 0.32 }),
    canopy: new THREE.MeshStandardMaterial({ color: 0x0a1626, metalness: 0.2, roughness: 0.08, emissive: 0x66e1ff, emissiveIntensity: 0.22, transparent: true, opacity: 0.86 }),
    rotors: new THREE.MeshStandardMaterial({ color: 0x1b2541, metalness: 0.6, roughness: 0.4, emissive: 0x66e1ff, emissiveIntensity: 0.15 }),
    glow: new THREE.MeshBasicMaterial({ color: 0x66e1ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    nav: new THREE.MeshBasicMaterial({ vertexColors: true }),
  };

  return {
    hull, canopy, rotors, glow, nav, materials,
    dispose() {
      for (const g of [hull, canopy, rotors, glow, nav]) g.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
  };
}
