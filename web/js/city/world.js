// Synergy City — world (STUB). A walkable district: ground, instanced blocks,
// lights, fog, a distant skyline, and registered collisions. The content build
// replaces this file with the richly modelled Purpose Quarter; the exports and
// the ctx.collision / ctx.env contract stay the same.
import * as THREE from '../../vendor/three/three.module.js';

export function buildWorld(ctx) {
  const { scene, rng, collision, env, quality } = ctx;
  const world = new THREE.Group();
  world.name = 'world';
  scene.add(world);

  const HALF = 120; // walkable half-extent (metres)
  const PLAZA = 30; // clear radius around the centre (the places live here)

  // --- ground ---
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 2 + 60, HALF * 2 + 60),
    new THREE.MeshStandardMaterial({ color: 0x15102a, roughness: 0.95, metalness: 0.0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  world.add(ground);

  // A faint plaza disc so the centre reads as a gathering place.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(PLAZA, 48),
    new THREE.MeshStandardMaterial({ color: 0x241a40, emissive: 0x2a1746, emissiveIntensity: 0.35, roughness: 0.8 }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.02;
  world.add(disc);

  // --- buildings: one InstancedMesh of unit boxes, scaled per instance ---
  const spots = [];
  const spacing = 24;
  for (let gx = -HALF + 12; gx <= HALF - 12; gx += spacing) {
    for (let gz = -HALF + 12; gz <= HALF - 12; gz += spacing) {
      const jx = gx + (rng() - 0.5) * 6;
      const jz = gz + (rng() - 0.5) * 6;
      if (Math.hypot(jx, jz) < PLAZA + 8) continue; // keep the plaza clear
      if (rng() < 0.12) continue; // the odd gap/courtyard
      const w = 8 + rng() * 7;
      const d = 8 + rng() * 7;
      const h = 9 + rng() * (quality === 'low' ? 26 : 46);
      spots.push({ x: jx, z: jz, w, d, h });
    }
  }
  const box = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.15 });
  const mesh = new THREE.InstancedMesh(box, mat, spots.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  spots.forEach((s, i) => {
    m.makeScale(s.w, s.h, s.d);
    m.setPosition(s.x, s.h / 2, s.z);
    mesh.setMatrixAt(i, m);
    // Cool hull tones with a hint of the quarter's violet.
    const shade = 0.12 + rng() * 0.12;
    col.setHSL(0.72 + rng() * 0.06, 0.35, shade);
    mesh.setColorAt(i, col);
    collision.addBox(s.x, s.z, s.w / 2 + 0.3, s.d / 2 + 0.3, { tag: 'building' });
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  world.add(mesh);

  // --- distant skyline: the other five districts as massing beyond the wall ---
  const farCount = quality === 'low' ? 36 : 70;
  const far = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0x0c1026, roughness: 1 }), farCount);
  for (let i = 0; i < farCount; i++) {
    const ang = rng() * Math.PI * 2;
    const r = HALF + 60 + rng() * 260;
    const w = 14 + rng() * 26;
    const h = 20 + rng() * 120;
    m.makeScale(w, h, w);
    m.setPosition(Math.cos(ang) * r, h / 2, Math.sin(ang) * r);
    far.setMatrixAt(i, m);
  }
  far.instanceMatrix.needsUpdate = true;
  world.add(far);

  // --- lights + fog (driven by ctx.env) ---
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(80, 120, 60);
  const hemi = new THREE.HemisphereLight(0x8899cc, 0x0a0a16, 0.6);
  world.add(sun, hemi);
  scene.fog = new THREE.Fog(0x15102a, 60, 420);
  env.attach({ sun, hemi, fog: scene.fog, sky: true });

  return {
    districtName: 'Purpose Quarter',
    spawn: new THREE.Vector3(0, 0, -PLAZA + 6),
    bounds: { min: [-HALF, -HALF], max: [HALF, HALF] },
  };
}
