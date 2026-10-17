// Synergy City — bootstrap and the fixed-timestep loop. Assembles the ctx,
// builds the world/player/citizens/places, rings the district with an invisible
// wall, and drives everything. Owns nothing visual itself.
import * as THREE from '../../vendor/three/three.module.js';
import { makeRng, detectQuality, makeEnv } from './core.js';
import { makeInput } from './input.js';
import { makeCamera } from './camera.js';
import { makeCollision } from './collision.js';
import { makeInteractions } from './interactions.js';
import { makeHud } from './hud.js';
import { buildWorld } from './world.js';
import { buildPlayer } from './player.js';
import { buildCitizens } from './citizens.js';
import { buildPlaces } from './places.js';
import { makePerfGovernor } from './perf.js';

const STEP = 1 / 60;

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    // Release the probe context immediately; a software renderer can refuse a
    // second live context, which would make the real renderer fail.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export async function start() {
  const canvas = document.getElementById('view');
  const hud = makeHud();
  const params = new URLSearchParams(location.search);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!hasWebGL()) { hud.showFallback(); return; }

  const quality = detectQuality(params);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'high', powerPreference: 'high-performance' });
  } catch {
    hud.showFallback();
    return;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Sets the starting pixel ratio and size, then adapts both to real frame times.
  const perf = makePerfGovernor(renderer, { quality, params });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1400);

  const updaters = [];
  const disposers = [];
  const env = makeEnv(scene);
  const input = makeInput(canvas);
  const collision = makeCollision();
  const interactions = makeInteractions(hud);
  const cam3p = makeCamera(camera, input);

  // Who the input drives: Nova by default, or a vehicle that has taken control.
  // A controller is { position: Vector3, update(dt) }; the camera and the place
  // prompts follow whichever one is active.
  let player = null;
  let pilot = null;
  const control = {
    take(ctrl) { pilot = ctrl; },
    release() { pilot = player; },
    get active() { return pilot; },
    get player() { return player; },
  };

  const ctx = {
    THREE, scene, camera, renderer,
    clock: { time: 0, dt: STEP },
    quality, env, input, collision, interactions, hud,
    camera3p: cam3p, control, perf,
    rng: makeRng(0x5ea17 ^ (quality === 'low' ? 1 : 0)),
    register(obj) { if (obj?.update) updaters.push(obj); if (obj?.dispose) disposers.push(obj); },
  };

  // Build the district, then the avatar, crowd and places. Each may be a stub.
  hud.setLoading(0.15);
  const world = buildWorld(ctx);
  hud.setDistrict(world.districtName || 'Purpose Quarter');
  hud.setLoading(0.55);
  player = buildPlayer(ctx, world.spawn.clone());
  pilot = player;
  hud.setLoading(0.75);
  buildCitizens(ctx, world);
  buildPlaces(ctx, world);
  hud.setLoading(1);

  // Ring the walkable area with invisible walls so the player can't leave.
  if (world.bounds) {
    const { min, max } = world.bounds;
    const cx = (min[0] + max[0]) / 2;
    const cz = (min[1] + max[1]) / 2;
    const hx = (max[0] - min[0]) / 2;
    const hz = (max[1] - min[1]) / 2;
    const t = 2;
    collision.addBox(cx, min[1] - t, hx + t, t, { tag: 'wall' });
    collision.addBox(cx, max[1] + t, hx + t, t, { tag: 'wall' });
    collision.addBox(min[0] - t, cz, t, hz + t, { tag: 'wall' });
    collision.addBox(max[0] + t, cz, t, hz + t, { tag: 'wall' });
  }

  hud.setControls([
    ['WASD / Arrows', 'Walk'],
    ['Shift', 'Run'],
    ['Drag / Right stick', 'Look around'],
    ['E / A', 'Use a place'],
    ['Esc / P', 'Pause'],
  ]);

  // --- pause ---
  let paused = false;
  const setPaused = (on) => { paused = on; hud.showPause(on); };
  hud.onResume(() => setPaused(false));
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    perf.resize();
  });

  // --- debug ---
  let fps = 0;
  let acc = 0;
  let frames = 0;
  let fpsT = 0;
  if (params.get('debug') === '1') {
    window.__city = {
      getState: () => ({
        fps: Math.round(fps),
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        quality,
        dpr: perf.dpr,
        perfLevel: perf.level,
        driving: pilot !== player,
        pilot: { x: +pilot.position.x.toFixed(2), y: +pilot.position.y.toFixed(2), z: +pilot.position.z.toFixed(2) },
        timeOfDay: +env.timeOfDay.toFixed(3),
        colliders: collision.count,
        places: interactions.count,
        nearest: interactions.nearest,
        player: { x: +player.position.x.toFixed(2), y: +player.position.y.toFixed(2), z: +player.position.z.toFixed(2) },
      }),
      teleport: (x, z) => { pilot.position.x = x; pilot.position.z = z; },
      setTimeOfDay: (t) => env.setTimeOfDay(t),
    };
  }

  // --- loop ---
  let last = performance.now();
  let dayClock = env.timeOfDay;
  let carryJump = false;
  let carryAct = false;
  function frame(now) {
    requestAnimationFrame(frame);
    let delta = (now - last) / 1000;
    last = now;
    if (delta > 0.25) delta = 0.25; // clamp after a stall

    // fps meter
    fpsT += delta; frames++;
    if (fpsT >= 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    if (!paused) perf.frame(delta);

    input.sample();
    if (input.state.pausePressed) setPaused(!paused);

    // Edge presses (jump, use) reach exactly one fixed step. On a 120 Hz screen
    // many frames run no step at all and the press would be lost; on a 30 fps
    // phone two steps run per frame and a toggle (lift off, leave the car)
    // would fire twice and undo itself.
    const pressedAct = input.state.activate;
    if (input.state.jump) carryJump = true;
    if (pressedAct) carryAct = true;

    if (!paused) {
      const wasDriving = pilot !== player;
      acc += delta;
      let steps = 0;
      while (acc >= STEP && steps < 5) {
        input.state.jump = carryJump;
        input.state.activate = carryAct;
        carryJump = false;
        carryAct = false;
        ctx.clock.time += STEP;
        pilot.update(STEP);
        for (const u of updaters) u.update(STEP);
        acc -= STEP; steps++;
      }
      input.state.jump = false;
      input.state.activate = false;
      // Day/night: a slow cycle (~6 real minutes per day), paused with reduced motion.
      if (!reduceMotion) { dayClock = (dayClock + delta / 360) % 1; env.setTimeOfDay(dayClock); }
      cam3p.update(delta, pilot.position, reduceMotion);
      // A press that a vehicle used (to step out) must not also open the place
      // the player lands beside; a press a place used (say, to hand control to
      // the roadster) must not reach the vehicle's first step.
      if (interactions.update(pilot.position, pressedAct && !wasDriving)) carryAct = false;
    } else {
      carryJump = false;
      carryAct = false;
    }
    input.endFrame();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  // reveal
  setTimeout(() => hud.setLoading(null), reduceMotion ? 0 : 450);
}
