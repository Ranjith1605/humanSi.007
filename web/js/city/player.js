// Synergy City — player. Nova, the low-poly space penguin from Nova Run, built
// entirely in code (no external assets), plus her character controller: move
// relative to the camera, walk/run, gravity and a small hop onto the ground
// plane, and collision so she cannot enter buildings. Procedural idle/walk/run
// animation, a cheap running thruster plume and a soft contact shadow keep her
// readable against the Purpose Quarter's violet backdrop.
//
// The controller contract is the skeleton's: return { object3D, position,
// update(dt) }. The engine drives update() in the fixed step and reads
// `position` (and teleports it in ?debug=1), so `position` is the root group's
// position and the root group's y-rotation is the facing. Everything else hangs
// beneath a nested "chassis" that carries lean, waddle, bob and squash, leaving
// the root a clean handle for movement and the follow camera.
import * as THREE from '../../vendor/three/three.module.js';

export function buildPlayer(ctx, spawn) {
  const T = THREE;
  const { scene, camera, collision } = ctx;

  // Calmer idle (and gentler lean/flourish) when the viewer asks for less motion.
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const group = new T.Group();
  group.name = 'nova';
  group.position.copy(spawn);
  const chassis = new T.Group(); // lean / waddle / bob / squash live here
  group.add(chassis);

  // ---- materials: one per look, reused across identical parts, disposed never
  // re-created per frame (no churn, no leak). ----
  const navyMat = new T.MeshStandardMaterial({ color: 0x1d2e59, roughness: 0.5, metalness: 0.12 });
  const bellyMat = new T.MeshStandardMaterial({ color: 0xe9efff, roughness: 0.85 });
  const amberMat = new T.MeshStandardMaterial({ color: 0xff9e42, roughness: 0.5 });
  const slateMat = new T.MeshStandardMaterial({ color: 0x2a3b61, roughness: 0.45, metalness: 0.25 });
  const visorMat = new T.MeshStandardMaterial({ color: 0x0a2230, emissive: 0x5fd8ff, emissiveIntensity: 1.35, roughness: 0.22, metalness: 0.3 });
  const nozzleMat = new T.MeshStandardMaterial({ color: 0x3a2a10, emissive: 0xffb547, emissiveIntensity: 0.6, roughness: 0.4 });
  // Faked bloom: additive halos, no post pass.
  const haloMat = new T.MeshBasicMaterial({ color: 0x66e1ff, transparent: true, opacity: 0.36, blending: T.AdditiveBlending, depthWrite: false });
  const plumeMat = new T.MeshBasicMaterial({ color: 0xffb04a, transparent: true, opacity: 0.0, blending: T.AdditiveBlending, depthWrite: false });
  const glowMat = new T.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0.35, blending: T.AdditiveBlending, depthWrite: false });

  // ---- body + head: two stacked eggs read as one continuous penguin ----
  const body = new T.Mesh(new T.SphereGeometry(0.42, 20, 16), navyMat);
  body.scale.set(1.0, 1.28, 0.98);
  body.position.y = 0.52;

  const belly = new T.Mesh(new T.SphereGeometry(0.3, 18, 14), bellyMat);
  belly.scale.set(0.92, 1.12, 0.52);
  belly.position.set(0, 0.5, 0.27);

  const head = new T.Mesh(new T.SphereGeometry(0.3, 18, 14), navyMat);
  head.position.y = 1.03;

  // Cyan visor: a flattened lens pushed onto the face; its back half sits inside
  // the head so only the glowing front shows.
  const visor = new T.Mesh(new T.SphereGeometry(0.26, 18, 12), visorMat);
  visor.scale.set(1.06, 0.6, 0.82);
  visor.position.set(0, 1.05, 0.14);
  const visorHalo = new T.Mesh(new T.SphereGeometry(0.3, 16, 10), haloMat);
  visorHalo.scale.set(1.12, 0.66, 0.9);
  visorHalo.position.copy(visor.position);

  // Beak: a short amber cone pointing +z (forward).
  const beak = new T.Mesh(new T.ConeGeometry(0.085, 0.2, 10), amberMat);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.9, 0.33);

  // ---- flippers: paddles hung from shoulder pivots so they swing fore/aft ----
  const flipperGeo = new T.BoxGeometry(0.09, 0.38, 0.2);
  const flipperL = new T.Group();
  flipperL.position.set(-0.4, 0.64, 0);
  const flipperLm = new T.Mesh(flipperGeo, navyMat);
  flipperLm.position.y = -0.17;
  flipperL.add(flipperLm);
  const flipperR = new T.Group();
  flipperR.position.set(0.4, 0.64, 0);
  const flipperRm = new T.Mesh(flipperGeo, navyMat);
  flipperRm.position.y = -0.17;
  flipperR.add(flipperRm);

  // ---- feet: amber webbed blocks on hip pivots; rotating the pivot steps them ----
  const footGeo = new T.BoxGeometry(0.17, 0.08, 0.28);
  const footL = new T.Group();
  footL.position.set(-0.15, 0.11, 0);
  const footLm = new T.Mesh(footGeo, amberMat);
  footLm.position.set(0, -0.05, 0.08);
  footL.add(footLm);
  const footR = new T.Group();
  footR.position.set(0.15, 0.11, 0);
  const footRm = new T.Mesh(footGeo, amberMat);
  footRm.position.set(0, -0.05, 0.08);
  footR.add(footRm);

  // ---- thruster pack on the back (-z) with two glowing nozzles + a plume ----
  const pack = new T.Mesh(new T.BoxGeometry(0.36, 0.44, 0.2), slateMat);
  pack.position.set(0, 0.62, -0.31);
  const nozzleGeo = new T.CylinderGeometry(0.06, 0.08, 0.14, 10);
  const nozzleL = new T.Mesh(nozzleGeo, nozzleMat);
  nozzleL.rotation.x = Math.PI / 2;
  nozzleL.position.set(-0.1, 0.46, -0.44);
  const nozzleR = new T.Mesh(nozzleGeo, nozzleMat);
  nozzleR.rotation.x = Math.PI / 2;
  nozzleR.position.set(0.1, 0.46, -0.44);
  const glow = new T.Mesh(new T.SphereGeometry(0.11, 12, 10), glowMat);
  glow.position.set(0, 0.46, -0.48);
  const plume = new T.Mesh(new T.ConeGeometry(0.12, 0.5, 12, 1, true), plumeMat);
  plume.rotation.x = -Math.PI / 2; // taper points back (-z)
  plume.position.set(0, 0.46, -0.62);
  plume.visible = false;

  chassis.add(
    body, belly, head, visor, visorHalo, beak,
    flipperL, flipperR, footL, footR,
    pack, nozzleL, nozzleR, glow, plume,
  );
  group.add(chassis);
  scene.add(group);

  // ---- soft contact shadow: a flat radial-gradient disc that follows Nova on
  // the ground (separate from the group so it stays at y~0 while she hops) ----
  const shCanvas = document.createElement('canvas');
  shCanvas.width = shCanvas.height = 128;
  const g2d = shCanvas.getContext('2d');
  const grad = g2d.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(6,5,14,0.55)');
  grad.addColorStop(0.6, 'rgba(6,5,14,0.28)');
  grad.addColorStop(1, 'rgba(6,5,14,0)');
  g2d.fillStyle = grad;
  g2d.fillRect(0, 0, 128, 128);
  const shTex = new T.CanvasTexture(shCanvas);
  shTex.colorSpace = T.SRGBColorSpace;
  const shadowMat = new T.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false, opacity: 0.42 });
  const shadow = new T.Mesh(new T.CircleGeometry(0.72, 32), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.copy(spawn);
  shadow.position.y = 0.015;
  scene.add(shadow);

  // ---- controller state ----
  const pos = group.position;
  const vel = new T.Vector3();
  const fwd = new T.Vector3();
  const right = new T.Vector3();
  const wish = new T.Vector3();
  let yVel = 0;
  let yaw = group.rotation.y;
  let facing = yaw;
  let phase = 0;       // stride phase
  let breathe = 0;     // idle breathing phase
  let squash = 0;      // landing squash (0..1), decays
  let airStretch = 0;  // smoothed airborne stretch
  let plumeHeat = 0;   // smoothed thruster intensity 0..1
  let wasGrounded = true;

  const WALK = 5.0;
  const RUN = 9.2;
  const ACCEL = 14;
  const GRAV = 18;
  const HOP = 5.6;
  const flourish = reduceMotion ? 0.55 : 1;

  function update(dt) {
    // --- camera-relative basis, flattened to the ground (same as the stub) ---
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    right.set(fwd.z, 0, -fwd.x);

    const mv = ctx.input.state.move;
    wish.set(0, 0, 0).addScaledVector(fwd, mv.y).addScaledVector(right, mv.x);
    const wantRun = ctx.input.state.run && wish.lengthSq() > 1e-4;
    const topSpeed = wantRun ? RUN : WALK;
    if (wish.lengthSq() > 1e-4) {
      wish.normalize().multiplyScalar(topSpeed);
      facing = Math.atan2(wish.x, wish.z);
    }

    // Snappy acceleration toward the wish velocity.
    const a = Math.min(1, dt * ACCEL);
    vel.x += (wish.x - vel.x) * a;
    vel.z += (wish.z - vel.z) * a;

    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    collision.resolve(pos, 0.5); // keep Nova out of every building footprint

    // Gravity and a small hop onto the flat ground (y = 0).
    const grounded = pos.y <= 1e-3;
    if (ctx.input.state.jump && grounded) yVel = HOP;
    yVel -= GRAV * dt;
    pos.y += yVel * dt;
    if (pos.y < 0) { pos.y = 0; yVel = 0; }

    // Landing -> trigger a squash.
    const nowGrounded = pos.y <= 1e-3;
    if (nowGrounded && !wasGrounded) squash = 1;
    wasGrounded = nowGrounded;

    // Turn to face the movement direction along the shortest arc (no π spin).
    let d = facing - yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    yaw += d * Math.min(1, dt * (reduceMotion ? 18 : 11));
    group.rotation.y = yaw;

    // --- procedural animation ---
    const speed = Math.hypot(vel.x, vel.z);
    const sp01 = Math.min(1, speed / RUN);
    const walkAmt = Math.min(1, speed / WALK);                          // 0..1 by walk speed
    const runAmt = Math.max(0, Math.min(1, (speed - WALK) / (RUN - WALK))); // 0..1 over walk

    // Stride phase tracks real speed so walk blends into run with no pop.
    phase += dt * (1.4 + speed * 1.05);
    breathe += dt * (reduceMotion ? 0.9 : 1.5);
    const swing = Math.sin(phase);

    // Flippers swing fore/aft (opposite each other), held back and streamlined
    // when running.
    const flipAmp = (0.26 + runAmt * 0.5) * walkAmt;
    const flipBase = 0.14 + runAmt * 0.34;
    flipperL.rotation.x = flipBase + swing * flipAmp;
    flipperR.rotation.x = flipBase - swing * flipAmp;
    flipperL.rotation.z = 0.2 + runAmt * 0.08;
    flipperR.rotation.z = -(0.2 + runAmt * 0.08);

    // Feet step, opposite to the near flipper.
    const stepAmp = (0.5 + runAmt * 0.38) * walkAmt;
    footL.rotation.x = -swing * stepAmp;
    footR.rotation.x = swing * stepAmp;

    // Bob (twice stride freq), waddle roll, lean into motion; calm idle breathe.
    const bob = Math.abs(Math.sin(phase)) * (0.03 + runAmt * 0.05) * walkAmt * flourish;
    const idle = (reduceMotion ? 0.006 : 0.02) * Math.sin(breathe) * (1 - walkAmt);
    const waddle = Math.sin(phase) * (0.06 + runAmt * 0.05) * walkAmt * flourish;
    const lean = sp01 * 0.16 * flourish;

    // Air stretch + landing squash (smoothstep decay), stacked into one scale.
    airStretch += ((nowGrounded ? 0 : 1) - airStretch) * Math.min(1, dt * 12);
    squash = Math.max(0, squash - dt * 5.5);
    const sEase = squash * squash * (3 - 2 * squash);
    const sqY = 1 + airStretch * 0.06 - sEase * 0.2;
    const sqXZ = 1 - airStretch * 0.05 + sEase * 0.14;

    chassis.position.y = bob + idle;
    chassis.rotation.x = lean;
    chassis.rotation.z = waddle;
    chassis.scale.set(sqXZ, sqY, sqXZ);

    // Thruster: cheap glow + plume that ramp with running (no particle system).
    plumeHeat += (runAmt - plumeHeat) * Math.min(1, dt * 8);
    const flicker = reduceMotion ? 1 : 0.85 + Math.sin(ctx.clock.time * 34) * 0.15;
    nozzleMat.emissiveIntensity = 0.55 + plumeHeat * 2.2 * flicker;
    glowMat.opacity = 0.3 + plumeHeat * 0.45;
    plume.visible = plumeHeat > 0.02;
    if (plume.visible) {
      plumeMat.opacity = 0.55 * plumeHeat * flicker;
      const s = 0.6 + plumeHeat * 0.6;
      plume.scale.set(s, 0.8 + plumeHeat * 1.5, s);
    }

    // Visor halo: a calm slow pulse (steady under reduced motion).
    haloMat.opacity = reduceMotion ? 0.36 : 0.34 + Math.sin(ctx.clock.time * 1.6) * 0.06;

    // Soft contact shadow tracks Nova and fades/shrinks as she lifts off.
    shadow.position.set(pos.x, 0.015, pos.z);
    const shScale = Math.max(0.42, 1 - pos.y * 0.5);
    shadow.scale.set(shScale, shScale, shScale);
    shadowMat.opacity = Math.max(0.12, 0.42 - pos.y * 0.22);
  }

  return { object3D: group, position: pos, update };
}
