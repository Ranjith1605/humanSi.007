// Synergy City — citizens. A calm, varied crowd of simple simulated figures
// that stroll the streets and plaza, avoiding buildings. Two InstancedMesh
// batches (bodies + heads) keep it cheap. Ambience only — never conscious.
import * as THREE from '../../vendor/three/three.module.js';

export function buildCitizens(ctx, world) {
  const { scene, rng, quality, collision, env, register } = ctx;
  const count = quality === 'low' ? 10 : 30;
  const group = new THREE.Group();
  group.name = 'citizens';
  scene.add(group);

  const bodyGeo = new THREE.CapsuleGeometry(0.26, 0.5, 4, 8);
  const headGeo = new THREE.SphereGeometry(0.2, 10, 8);
  const bodyMesh = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.75 }), count);
  const headMesh = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.6 }), count);
  group.add(bodyMesh, headMesh);

  const HALF = 132;
  const PLAZA = 30;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const skin = new THREE.Color();
  const agents = [];

  function openSpot(minR = 0) {
    for (let t = 0; t < 24; t++) {
      const x = (rng() - 0.5) * 2 * HALF;
      const z = (rng() - 0.5) * 2 * HALF;
      if (Math.hypot(x, z) < minR) continue;
      if (!collision.blocks(x, z, 1.2)) return { x, z };
    }
    return { x: (rng() - 0.5) * PLAZA, z: (rng() - 0.5) * PLAZA };
  }

  for (let i = 0; i < count; i++) {
    const p = openSpot();
    const tgt = openSpot();
    const h = 0.85 + rng() * 0.5; // height variation
    const w = 0.8 + rng() * 0.5;
    agents.push({ x: p.x, z: p.z, tx: tgt.x, tz: tgt.z, speed: 1.1 + rng() * 1.5, phase: rng() * 6.28, h, w, active: true });
    // a few cooler "crew" tones, the rest warmer "residents"
    if (rng() < 0.3) col.setHSL(0.58 + rng() * 0.08, 0.45, 0.42);
    else col.setHSL(rng(), 0.4, 0.46 + rng() * 0.16);
    bodyMesh.setColorAt(i, col);
    skin.copy(col).offsetHSL(0, -0.1, 0.12);
    headMesh.setColorAt(i, skin);
  }
  bodyMesh.instanceColor && (bodyMesh.instanceColor.needsUpdate = true);
  headMesh.instanceColor && (headMesh.instanceColor.needsUpdate = true);

  function retarget(a) { const t = openSpot(); a.tx = t.x; a.tz = t.z; }

  register({
    update(dt) {
      // The quarter quietens at night: a fraction of the crowd stops wandering.
      const night = env.timeOfDay < 0.22 || env.timeOfDay > 0.82;
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        a.active = !night || i % 2 === 0;
        if (a.active) {
          const dx = a.tx - a.x;
          const dz = a.tz - a.z;
          const d = Math.hypot(dx, dz);
          if (d < 1.4) retarget(a);
          else {
            const nx = a.x + (dx / d) * a.speed * dt;
            const nz = a.z + (dz / d) * a.speed * dt;
            if (collision.blocks(nx, nz, 0.6)) retarget(a);
            else { a.x = nx; a.z = nz; a.phase += dt * 6; }
          }
        }
        const face = Math.atan2(a.tx - a.x, a.tz - a.z);
        const bob = a.active ? Math.abs(Math.sin(a.phase)) * 0.05 : 0;
        q.setFromAxisAngle(up, face);
        // body
        pos.set(a.x, 0.55 * a.h + bob, a.z);
        sc.set(a.w, a.h, a.w);
        m.compose(pos, q, sc);
        bodyMesh.setMatrixAt(i, m);
        // head sits on top
        pos.set(a.x, (0.95 * a.h) + bob, a.z);
        sc.set(a.w, a.w, a.w);
        m.compose(pos, q, sc);
        headMesh.setMatrixAt(i, m);
      }
      bodyMesh.instanceMatrix.needsUpdate = true;
      headMesh.instanceMatrix.needsUpdate = true;
    },
    dispose() { bodyGeo.dispose(); headGeo.dispose(); bodyMesh.material.dispose(); headMesh.material.dispose(); },
  });
}
