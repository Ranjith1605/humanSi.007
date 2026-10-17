// Synergy City — shared helpers: a seeded PRNG for deterministic world
// generation, quality detection, and the day/night environment driver.
import * as THREE from '../../vendor/three/three.module.js';

/** Mulberry32: tiny, fast, seeded PRNG. World gen uses this, never Math.random. */
export function makeRng(seed = 0x5eed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a quality tier. Honour ?quality=, else guess from the device. */
export function detectQuality(params) {
  const forced = params.get('quality');
  if (forced === 'low' || forced === 'high') return forced;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 540;
  const lean = (navigator.hardwareConcurrency || 4) <= 4;
  return coarse && (small || lean) ? 'low' : 'high';
}

/**
 * The environment: a sun + hemisphere light and fog whose colour and angle
 * follow a time-of-day in [0,1) (0 = midnight, 0.5 = noon). world.js owns the
 * actual lights and fog; it registers them here so the clock can drive them.
 */
export function makeEnv(scene) {
  const state = { timeOfDay: 0.38, sun: null, hemi: null, fog: null, sky: null };

  // Keyframed sky/sun/fog palette across the day. Interpolated by setTimeOfDay.
  const stops = [
    { t: 0.0, sky: 0x05060f, sun: 0x12204a, hemi: 0x0a1230, fog: 0x05060f, intensity: 0.15 },
    { t: 0.25, sky: 0x1a1540, sun: 0xff9d6b, hemi: 0x2a2250, fog: 0x151235, intensity: 0.6 },
    { t: 0.5, sky: 0x8fb7ff, sun: 0xfff2d8, hemi: 0x6f86c4, fog: 0xa9bfe6, intensity: 1.15 },
    { t: 0.75, sky: 0x2a1e52, sun: 0xffb86b, hemi: 0x2e2360, fog: 0x1d1640, intensity: 0.55 },
    { t: 1.0, sky: 0x05060f, sun: 0x12204a, hemi: 0x0a1230, fog: 0x05060f, intensity: 0.15 },
  ];
  const lerpC = (a, b, m) => new THREE.Color(a).lerp(new THREE.Color(b), m);

  function sample(t) {
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (t >= a.t && t <= b.t) {
        const m = (t - a.t) / (b.t - a.t || 1);
        return {
          sky: lerpC(a.sky, b.sky, m),
          sun: lerpC(a.sun, b.sun, m),
          hemi: lerpC(a.hemi, b.hemi, m),
          fog: lerpC(a.fog, b.fog, m),
          intensity: a.intensity + (b.intensity - a.intensity) * m,
        };
      }
    }
    return { sky: new THREE.Color(stops[0].sky), sun: new THREE.Color(stops[0].sun), hemi: new THREE.Color(stops[0].hemi), fog: new THREE.Color(stops[0].fog), intensity: stops[0].intensity };
  }

  function setTimeOfDay(t01) {
    state.timeOfDay = ((t01 % 1) + 1) % 1;
    const s = sample(state.timeOfDay);
    if (state.sky) scene.background = s.sky;
    if (state.fog) state.fog.color.copy(s.fog);
    if (state.sun) {
      state.sun.color.copy(s.sun);
      state.sun.intensity = s.intensity;
      // Sun arcs across the sky: dawn east (-x), noon high, dusk west (+x).
      const ang = (state.timeOfDay - 0.25) * Math.PI * 2; // 0 at dawn
      state.sun.position.set(Math.cos(ang) * 180, Math.max(8, Math.sin(ang) * 160 + 20), 60);
    }
    if (state.hemi) {
      state.hemi.color.copy(s.hemi);
      state.hemi.intensity = 0.4 + s.intensity * 0.4;
    }
  }

  return {
    get timeOfDay() { return state.timeOfDay; },
    setTimeOfDay,
    // world.js calls this once it has created the lights/fog so the env can drive them.
    attach({ sun, hemi, fog, sky = true }) {
      state.sun = sun;
      state.hemi = hemi;
      state.fog = fog;
      state.sky = sky;
      setTimeOfDay(state.timeOfDay);
    },
  };
}
