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
  renderer.setPixelRatio(Math.min(quality === 'high' ? 2 : 1.3, devicePixelRatio || 1));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1400);

  const updaters = [];
  const disposers = [];
  const env = makeEnv(scene);
  const input = makeInput(canvas);
  const collision = makeCollision();
  const interactions = makeInteractions(hud);
  const cam3p = makeCamera(camera, input);

  const ctx = {
    THREE, scene, camera, renderer,
    clock: { time: 0, dt: STEP },
    quality, env, input, collision, interactions, hud,
    rng: makeRng(0x5ea17 ^ (quality === 'low' ? 1 : 0)),
    register(obj) { if (obj?.update) updaters.push(obj); if (obj?.dispose) disposers.push(obj); },
  };

  // Build the district, then the avatar, crowd and places. Each may be a stub.
  hud.setLoading(0.15);
  const world = buildWorld(ctx);
  hud.setDistrict(world.districtName || 'Purpose Quarter');
  hud.setLoading(0.55);
  const player = buildPlayer(ctx, world.spawn.clone());
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
    renderer.setSize(innerWidth, innerHeight, false);
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
        timeOfDay: +env.timeOfDay.toFixed(3),
        colliders: collision.count,
        places: interactions.count,
        nearest: interactions.nearest,
        player: { x: +player.position.x.toFixed(2), y: +player.position.y.toFixed(2), z: +player.position.z.toFixed(2) },
      }),
      teleport: (x, z) => { player.position.x = x; player.position.z = z; },
      setTimeOfDay: (t) => env.setTimeOfDay(t),
    };
  }

  // --- loop ---
  let last = performance.now();
  let dayClock = env.timeOfDay;
  function frame(now) {
    requestAnimationFrame(frame);
    let delta = (now - last) / 1000;
    last = now;
    if (delta > 0.25) delta = 0.25; // clamp after a stall

    // fps meter
    fpsT += delta; frames++;
    if (fpsT >= 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }

    input.sample();
    if (input.state.pausePressed) setPaused(!paused);

    if (!paused) {
      acc += delta;
      let steps = 0;
      while (acc >= STEP && steps < 5) {
        ctx.clock.time += STEP;
        player.update(STEP);
        for (const u of updaters) u.update(STEP);
        acc -= STEP; steps++;
      }
      // Day/night: a slow cycle (~6 real minutes per day), paused with reduced motion.
      if (!reduceMotion) { dayClock = (dayClock + delta / 360) % 1; env.setTimeOfDay(dayClock); }
      cam3p.update(delta, player.position, reduceMotion);
      interactions.update(player.position, input.state.activate);
    }
    input.endFrame();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  // reveal
  setTimeout(() => hud.setLoading(null), reduceMotion ? 0 : 450);
}
