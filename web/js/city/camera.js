// Synergy City — third-person follow camera. Orbits the player on yaw/pitch
// from look input, keeps a spring-damped distance, and exposes the yaw so the
// player can move relative to where the camera faces.
import * as THREE from '../../vendor/three/three.module.js';

export function makeCamera(camera, input) {
  let yaw = 0.6;
  let pitch = 0.32;
  const target = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const desired = new THREE.Vector3();
  let dist = 7.5;
  let wantDist = 7.5;

  function update(dt, focus, reduceMotion) {
    // Ease toward the requested distance (a car or a flight wants a wider view).
    dist += (wantDist - dist) * (reduceMotion ? 1 : Math.min(1, dt * 3));
    yaw -= input.state.look.x;
    pitch = Math.max(0.08, Math.min(1.15, pitch + input.state.look.y));

    // Focus a little above the player's feet.
    target.set(focus.x, focus.y + 1.3, focus.z);

    const cp = Math.cos(pitch);
    desired.set(
      target.x + Math.sin(yaw) * cp * dist,
      target.y + Math.sin(pitch) * dist,
      target.z + Math.cos(yaw) * cp * dist,
    );
    // Spring toward the desired position; snap when reduced motion is on.
    const k = reduceMotion ? 1 : Math.min(1, dt * 9);
    pos.lerp(desired, k);
    if (!pos.lengthSq()) pos.copy(desired);
    camera.position.copy(pos);
    camera.lookAt(target);
  }

  return {
    update,
    get yaw() { return yaw; },
    setYaw(v) { yaw = v; },
    /** Follow distance in metres; 7.5 is Nova on foot. */
    setDistance(d) { wantDist = d; },
  };
}
