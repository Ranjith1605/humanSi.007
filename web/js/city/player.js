// Synergy City — player (STUB). Nova as a simple low-poly figure, moved
// relative to the camera, with gravity to the ground and collision. The content
// build replaces the model and animation; the controller contract is stable.
import * as THREE from '../../vendor/three/three.module.js';

export function buildPlayer(ctx, spawn) {
  const { THREE: T, scene, camera, collision } = ctx;
  const group = new T.Group();
  group.name = 'nova';
  group.position.copy(spawn);

  // A stand-in Nova: body, white belly, visor, thruster. Good enough to walk;
  // the content build swaps in the real penguin.
  const navy = new T.MeshStandardMaterial({ color: 0x15233f, roughness: 0.6 });
  const body = new T.Mesh(new T.CapsuleGeometry(0.34, 0.5, 6, 12), navy);
  body.position.y = 0.6;
  const belly = new T.Mesh(new T.CapsuleGeometry(0.24, 0.34, 6, 12), new T.MeshStandardMaterial({ color: 0xdfe8ff, roughness: 0.7 }));
  belly.position.set(0, 0.56, 0.16);
  belly.scale.z = 0.6;
  const visor = new T.Mesh(new T.BoxGeometry(0.34, 0.12, 0.08), new T.MeshStandardMaterial({ color: 0x66e1ff, emissive: 0x1aa7d0, emissiveIntensity: 0.8, roughness: 0.3 }));
  visor.position.set(0, 0.92, 0.26);
  const pack = new T.Mesh(new T.BoxGeometry(0.3, 0.34, 0.16), new T.MeshStandardMaterial({ color: 0x24324f, roughness: 0.5 }));
  pack.position.set(0, 0.62, -0.26);
  const glow = new T.Mesh(new T.SphereGeometry(0.07, 8, 8), new T.MeshBasicMaterial({ color: 0xffb547 }));
  glow.position.set(0, 0.46, -0.34);
  group.add(body, belly, visor, pack, glow);
  scene.add(group);

  const pos = group.position;
  const vel = new T.Vector3();
  const fwd = new T.Vector3();
  const right = new T.Vector3();
  const wish = new T.Vector3();
  let yVel = 0;
  let facing = 0;
  let stride = 0;

  const WALK = 5.2;
  const RUN = 9.4;

  function update(dt) {
    // Camera-relative movement basis, flattened to the ground.
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    right.set(fwd.z, 0, -fwd.x);

    const mv = ctx.input.state.move;
    wish.set(0, 0, 0).addScaledVector(fwd, mv.y).addScaledVector(right, mv.x);
    const speed = ctx.input.state.run ? RUN : WALK;
    if (wish.lengthSq() > 1e-4) {
      wish.normalize().multiplyScalar(speed);
      facing = Math.atan2(wish.x, wish.z);
    }
    // Accelerate toward the wish velocity (snappy but not instant).
    vel.x += (wish.x - vel.x) * Math.min(1, dt * 12);
    vel.z += (wish.z - vel.z) * Math.min(1, dt * 12);

    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    collision.resolve(pos, 0.5);

    // Gravity onto the flat ground (y = 0). Jump gives a small hop.
    if (ctx.input.state.jump && pos.y <= 0.001) yVel = 5.2;
    yVel -= 16 * dt;
    pos.y += yVel * dt;
    if (pos.y < 0) { pos.y = 0; yVel = 0; }

    // Face the way we move; bob a little while walking.
    group.rotation.y += (facing - group.rotation.y) * Math.min(1, dt * 12);
    const moving = vel.x * vel.x + vel.z * vel.z;
    stride += dt * (ctx.input.state.run ? 14 : 9) * (moving > 0.3 ? 1 : 0);
    body.position.y = 0.6 + Math.abs(Math.sin(stride)) * 0.05 * (moving > 0.3 ? 1 : 0);
  }

  return { object3D: group, position: pos, update };
}
