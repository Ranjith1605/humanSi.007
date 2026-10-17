// Adaptive resolution. Phones differ by an order of magnitude in GPU power, so
// a fixed pixel ratio is either blurry on a flagship or a slideshow on a budget
// handset. This watches real frame times and trades resolution for frame rate:
// it steps the pixel ratio down when frames run long and back up when there is
// headroom, with hysteresis so it never oscillates. Once resolution is at its
// floor and frames are still long, it raises `level` so modules can shed work
// (fewer cars, fewer citizens). Shared by Synergy City and Architect.
//
//   ?perf=off  pins the starting pixel ratio (for comparisons and tests)

const SLOW = 1 / 45; // a frame longer than this is a dropped frame at 60 Hz
const FAST = 1 / 65; // comfortably inside budget: room to sharpen
const DOWN_AFTER = 1.5; // seconds of sustained slow frames before stepping down
const UP_AFTER = 4; // seconds of sustained headroom before stepping up
const WARMUP = 2; // ignore the first seconds: shader compiles and texture uploads
const STEP = 0.15;
const MAX_LEVEL = 2;

export function makePerfGovernor(renderer, { quality = 'high', params = new URLSearchParams() } = {}) {
  const native = window.devicePixelRatio || 1;
  const maxDpr = Math.min(quality === 'high' ? 2 : 1.25, native);
  const minDpr = Math.min(maxDpr, quality === 'high' ? 0.75 : 0.6);
  const pinned = params.get('perf') === 'off';
  const listeners = [];

  let dpr = maxDpr;
  let level = 0;
  let ema = 1 / 60;
  let slowFor = 0;
  let fastFor = 0;
  let age = 0;
  let fps = 60;

  function apply() {
    renderer.setPixelRatio(dpr);
    renderer.setSize(innerWidth, innerHeight, false);
  }
  apply();

  function setLevel(next) {
    if (next === level) return;
    level = next;
    for (const fn of listeners) fn(level);
  }

  function frame(delta) {
    // A stall (tab switch, GC pause, alert) says nothing about steady-state cost.
    if (delta <= 0 || delta > 0.25) return;
    age += delta;
    ema += (delta - ema) * 0.08;
    fps = 1 / ema;
    if (pinned || age < WARMUP) return;

    if (ema > SLOW) { slowFor += delta; fastFor = 0; }
    else if (ema < FAST) { fastFor += delta; slowFor = 0; }
    else { slowFor = 0; fastFor = 0; }

    if (slowFor >= DOWN_AFTER) {
      slowFor = 0;
      if (dpr > minDpr + 1e-3) { dpr = Math.max(minDpr, +(dpr - STEP).toFixed(2)); apply(); }
      else setLevel(Math.min(MAX_LEVEL, level + 1));
    } else if (fastFor >= UP_AFTER) {
      fastFor = 0;
      // Win back detail before resolution: a lower level is the bigger visual loss.
      if (level > 0) setLevel(level - 1);
      else if (dpr < maxDpr - 1e-3) { dpr = Math.min(maxDpr, +(dpr + STEP).toFixed(2)); apply(); }
    }
  }

  return {
    frame,
    /** Re-apply the current pixel ratio after a window resize. */
    resize: apply,
    /** Subscribe to level changes: 0 = full detail, 1 = reduced, 2 = minimal. */
    onChange(fn) { listeners.push(fn); },
    get dpr() { return dpr; },
    get level() { return level; },
    get fps() { return fps; },
  };
}
