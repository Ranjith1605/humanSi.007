// The loop: a fixed 120 Hz simulation driven by requestAnimationFrame. The
// simulation always advances in whole STEP increments, so physics and the
// reported sector time are identical whatever the display's refresh rate.
// `timescale` (debug, 1–8) runs more steps per frame without changing what a
// step means, so a sped-up run reports the same simulated time.

import { STEP } from './physics.js';

export class Engine {
  constructor({ update, render }) {
    this.update = update;
    this.render = render;
    this.timescale = 1;
    this.acc = 0;
    this.last = 0;
    this.running = false;
    this.frameWork = new Float32Array(600);
    this.frameGap = new Float32Array(600);
    this.frames = 0;
    this.tick = this.tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.tick);
  }

  setTimescale(n) {
    const v = Number(n);
    this.timescale = Number.isFinite(v) ? Math.min(8, Math.max(0.1, v)) : 1;
  }

  tick(now) {
    if (!this.running) return;
    const t0 = performance.now();
    let dt = (now - this.last) / 1000;
    const gap = now - this.last;
    this.last = now;
    // A long stall (tab switch, debugger) must not become a burst of catch-up steps.
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this.acc += dt * this.timescale;
    let steps = 0;
    const maxSteps = Math.ceil(0.1 * this.timescale / STEP) + 2;
    while (this.acc >= STEP && steps < maxSteps) {
      this.update(STEP);
      this.acc -= STEP;
      steps++;
    }
    if (steps >= maxSteps) this.acc = 0;
    this.render(this.acc / STEP, dt);
    const i = this.frames % 600;
    this.frameWork[i] = performance.now() - t0;
    this.frameGap[i] = gap;
    this.frames++;
    requestAnimationFrame(this.tick);
  }

  /** Work time per frame (update + render) and frame interval over the last 600 frames. */
  perf() {
    const n = Math.min(this.frames, 600);
    if (n === 0) return null;
    const stat = (arr) => {
      const a = Array.from(arr.slice(0, n)).sort((x, y) => x - y);
      const avg = a.reduce((s, v) => s + v, 0) / n;
      return { avg: +avg.toFixed(3), p95: +a[Math.min(n - 1, Math.floor(n * 0.95))].toFixed(3), max: +a[n - 1].toFixed(3) };
    };
    return { frames: n, workMs: stat(this.frameWork), intervalMs: stat(this.frameGap) };
  }
}
