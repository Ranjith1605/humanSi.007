// Synergy City — citizens (STUB). A small, calm crowd of simple figures that
// stroll between points. Ambience only; the content build gives them real
// variety and avoidance. They are simulated agents, never described as conscious.
import * as THREE from '../../vendor/three/three.module.js';

export function buildCitizens(ctx, world) {
  const { scene, rng, quality, collision } = ctx;
  const count = quality === 'low' ? 8 : 18;
  const group = new THREE.Group();
  group.name = 'citizens';
  scene.add(group);

  const geo = new THREE.CapsuleGeometry(0.28, 0.5, 4, 8);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), count);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const agents = [];
  const HALF = 110;

  function openSpot() {
    for (let tries = 0; tries < 20; tries++) {
      const x = (rng() - 0.5) * 2 * HALF;
      const z = (rng() - 0.5) * 2 * HALF;
      if (!collision.blocks(x, z, 1.2)) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  for (let i = 0; i < count; i++) {
    const p = openSpot();
    const target = openSpot();
    agents.push({ x: p.x, z: p.z, tx: target.x, tz: target.z, speed: 1.2 + rng() * 1.4, phase: rng() * 6.28 });
    col.setHSL(rng(), 0.4, 0.45 + rng() * 0.2);
    mesh.setColorAt(i, col);
  }
  mesh.instanceColor && (mesh.instanceColor.needsUpdate = true);
  group.add(mesh);

  function retarget(a) { const t = openSpot(); a.tx = t.x; a.tz = t.z; }

  ctx.register({
    update(dt) {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        const dx = a.tx - a.x;
        const dz = a.tz - a.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.5) { retarget(a); continue; }
        const nx = a.x + (dx / d) * a.speed * dt;
        const nz = a.z + (dz / d) * a.speed * dt;
        if (collision.blocks(nx, nz, 0.6)) retarget(a);
        else { a.x = nx; a.z = nz; }
        a.phase += dt * 6;
        const bob = Math.abs(Math.sin(a.phase)) * 0.04;
        m.makeRotationY(Math.atan2(dx, dz));
        m.setPosition(a.x, 0.6 + bob, a.z);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  });
}
