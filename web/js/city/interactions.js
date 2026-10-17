// Synergy City — proximity interactions. Places register a point, a label and
// an onActivate; the engine tests the player each frame, shows the HUD prompt
// for the nearest one in range, and fires it on the activate control.
import * as THREE from '../../vendor/three/three.module.js';

export function makeInteractions(hud) {
  const items = []; // { pos: Vector3, radius, label, hint, onActivate }
  let current = null;
  let enabled = true;

  // A vehicle takes over the prompt while it is driven, so places go quiet until
  // the player steps out; otherwise E would both open a place and leave the car.
  function setEnabled(on) {
    enabled = !!on;
    if (!enabled && current) { current = null; hud.clearPrompt(); }
  }

  function add({ position, radius = 4, label, hint = 'Press E', onActivate }) {
    const pos = position.isVector3 ? position.clone() : new THREE.Vector3(position[0], 0, position[1]);
    const item = { pos, radius, label, hint, onActivate };
    items.push(item);
    return item;
  }

  // Returns true when this call fired a place, so the caller can consume the press.
  function update(playerPos, activate) {
    if (!enabled) return false;
    let best = null;
    let bestD = Infinity;
    for (const it of items) {
      const dx = it.pos.x - playerPos.x;
      const dz = it.pos.z - playerPos.z;
      const d = Math.hypot(dx, dz);
      if (d <= it.radius && d < bestD) { best = it; bestD = d; }
    }
    if (best !== current) {
      current = best;
      if (best) hud.prompt(best.label, best.hint);
      else hud.clearPrompt();
    }
    if (current && activate) { current.onActivate(); return true; }
    return false;
  }

  return { add, update, setEnabled, get nearest() { return current ? current.label : null; }, get count() { return items.length; } };
}
