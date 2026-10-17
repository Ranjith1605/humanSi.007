// Synergy City — input, normalised across keyboard, mouse/pointer, gamepad and
// touch into one intent object the player and camera read each frame.
import * as THREE from '../../vendor/three/three.module.js';

export function makeInput(canvas) {
  const keys = new Set();
  // Keys pressed since the last sample, so a tap shorter than one frame (easy on
  // a slow phone) still counts even though it is no longer held when we look.
  const tapped = new Set();
  const state = {
    move: new THREE.Vector2(), // camera-relative, -1..1
    look: new THREE.Vector2(), // yaw,pitch delta this frame
    run: false,
    jump: false, // edge
    activate: false, // edge
    pausePressed: false, // edge
  };
  let jumpLatch = false;
  let keyJumpLatch = false;
  let actLatch = false;
  let keyActLatch = false;
  let pauseLatch = false;
  let keyPauseLatch = false;

  // --- keyboard ---
  const code = (e) => e.code;
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(code(e));
    tapped.add(code(e));
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  }, { passive: false });
  addEventListener('keyup', (e) => keys.delete(code(e)));
  addEventListener('blur', () => { keys.clear(); tapped.clear(); });

  // --- pointer look (drag) ---
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const touchLook = { id: null, lastX: 0, lastY: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') { touchLook.id = e.pointerId; touchLook.lastX = e.clientX; touchLook.lastY = e.clientY; return; }
    dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      if (e.pointerId !== touchLook.id) return;
      state.look.x += (e.clientX - touchLook.lastX) * 0.005;
      state.look.y += (e.clientY - touchLook.lastY) * 0.005;
      touchLook.lastX = e.clientX; touchLook.lastY = e.clientY;
      return;
    }
    if (!dragging) return;
    state.look.x += (e.clientX - lastX) * 0.0045;
    state.look.y += (e.clientY - lastY) * 0.0045;
    lastX = e.clientX; lastY = e.clientY;
  });
  const endPointer = (e) => { if (e.pointerId === touchLook.id) touchLook.id = null; dragging = false; };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  addEventListener('wheel', () => {}, { passive: true });

  // --- touch controls ---
  const touchEl = document.getElementById('touch');
  const stick = document.getElementById('stick');
  const nub = document.getElementById('nub');
  const touchMove = new THREE.Vector2();
  let touchRun = false;
  let touchActLatch = false;
  let touchJumpLatch = false;
  if (matchMedia('(pointer: coarse)').matches && touchEl) {
    touchEl.hidden = false;
    touchEl.setAttribute('aria-hidden', 'false');
    let stickId = null;
    const rectC = () => stick.getBoundingClientRect();
    stick.addEventListener('pointerdown', (e) => { stickId = e.pointerId; stick.setPointerCapture(e.pointerId); moveStick(e); });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) moveStick(e); });
    const release = (e) => { if (e.pointerId === stickId) { stickId = null; touchMove.set(0, 0); nub.style.transform = 'translate(0,0)'; } };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
    function moveStick(e) {
      const r = rectC();
      let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const len = Math.hypot(dx, dy) || 1;
      if (len > 1) { dx /= len; dy /= len; }
      touchMove.set(dx, -dy);
      nub.style.transform = `translate(${dx * 34}px, ${dy * 34}px)`;
    }
    const runBtn = document.getElementById('btn-run');
    runBtn.addEventListener('pointerdown', () => { touchRun = true; });
    runBtn.addEventListener('pointerup', () => { touchRun = false; });
    runBtn.addEventListener('pointercancel', () => { touchRun = false; });
    document.getElementById('btn-act').addEventListener('pointerdown', () => { touchActLatch = true; });
    // Jump on foot; lift off / land in the roadster (it relabels this button).
    document.getElementById('btn-up')?.addEventListener('pointerdown', () => { touchJumpLatch = true; });
  }

  function keyAxis() {
    const v = new THREE.Vector2();
    if (keys.has('KeyW') || keys.has('ArrowUp')) v.y += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) v.y -= 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) v.x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) v.x += 1;
    if (v.lengthSq() > 1) v.normalize();
    return v;
  }

  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const dz = (n) => (Math.abs(n) < 0.18 ? 0 : n);
      const lx = dz(p.axes[0] || 0);
      const ly = dz(p.axes[1] || 0);
      if (lx || ly) state.move.set(lx, -ly);
      state.look.x += dz(p.axes[2] || 0) * 0.05;
      state.look.y += dz(p.axes[3] || 0) * 0.05;
      if (p.buttons[10]?.pressed || p.buttons[6]?.pressed) state.run = true;
      if (p.buttons[0]?.pressed) { if (!jumpLatch) state.jump = true; jumpLatch = true; } else jumpLatch = false;
      if (p.buttons[2]?.pressed || p.buttons[1]?.pressed) { if (!actLatch) state.activate = true; actLatch = true; } else actLatch = false;
      if (p.buttons[9]?.pressed) { if (!pauseLatch) state.pausePressed = true; pauseLatch = true; } else pauseLatch = false;
      return true;
    }
    return false;
  }

  // Called once per frame by the engine, before modules read `input`.
  function sample() {
    state.move.set(0, 0);
    state.run = false;
    state.jump = false;
    state.activate = false;
    state.pausePressed = false;

    const k = keyAxis();
    if (k.lengthSq()) state.move.copy(k);
    if (touchMove.lengthSq()) state.move.copy(touchMove);
    if (keys.has('ShiftLeft') || keys.has('ShiftRight') || touchRun) state.run = true;

    pollGamepad();

    // edge-triggered keys
    // Keyboard keys have their own latches: sharing the gamepad's meant Space
    // only ever fired once with no pad connected, and E/Esc re-fired every frame
    // while held with one connected (the pad poll kept clearing the latch).
    if (keys.has('Space') || tapped.has('Space')) { if (!keyJumpLatch) state.jump = true; keyJumpLatch = keys.has('Space'); } else keyJumpLatch = false;
    if (keys.has('KeyE') || tapped.has('KeyE')) { if (!keyActLatch) state.activate = true; keyActLatch = keys.has('KeyE'); } else keyActLatch = false;
    if (touchActLatch) { state.activate = true; touchActLatch = false; }
    if (touchJumpLatch) { state.jump = true; touchJumpLatch = false; }
    const pauseKey = keys.has('Escape') || keys.has('KeyP');
    if (pauseKey || tapped.has('Escape') || tapped.has('KeyP')) { if (!keyPauseLatch) state.pausePressed = true; keyPauseLatch = pauseKey; } else keyPauseLatch = false;
    tapped.clear();
  }

  function endFrame() { state.look.set(0, 0); }

  return { state, sample, endFrame };
}
