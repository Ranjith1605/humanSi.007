// Architect — the message protocol around the simulation. The module worker
// (sim.worker.js) and the main-thread fallback (host.js, inline mode) both run
// this same code, so the page behaves identically either way: it sends
// messages, and draws what comes back. This module owns the sim state and the
// month timer; the page never touches the state directly.
//
//   in:  init { seed, save? }  new { seed }  tool { tool, x, y, x2?, y2? }
//        speed { speed }  tax { rate }  policy { name, value }
//        decide { id, decision }  inspect { x, y }  save  step { count? }
//   out: state { layers, stats, advice, events, log }  toolResult { ok, cost, reason, placed, tool }
//        inspect { info }  saved { data }  decided { id, decision, ok, reason }  error { reason }
//
// `step` is a debugging aid (advance n months now); docs/ARCHITECT.md has the rest.

import {
  LAYER_NAMES,
  createState,
  apply,
  step,
  advise,
  decide,
  setTax,
  setPolicy,
  stats,
  inspect,
  serialize,
  deserialize,
} from './sim.js';

/** Milliseconds per simulated month at speeds 0 (paused) to 3. */
export const SPEED_DELAYS = Object.freeze([0, 2400, 1200, 500]);
const LOG_TAIL = 30; // the Synergy panel shows recent decisions; the save keeps more

/**
 * `post(msg, transfer)` delivers a message to the page; `transfer` lists the
 * layer buffers, which are fresh copies, so a worker can hand them over
 * without copying again. Timers are injectable so tests can drive the clock.
 */
export function createProtocol(post, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let state = null;
  let speed = 0;
  let timer = null;

  function snapshot(events = []) {
    const layers = {};
    const transfer = [];
    for (const name of LAYER_NAMES) {
      const copy = state.layers[name].slice();
      layers[name] = copy;
      transfer.push(copy.buffer);
    }
    const s = stats(state);
    s.speed = speed;
    post({ type: 'state', layers, stats: s, advice: advise(state), events, log: state.log.slice(-LOG_TAIL) }, transfer);
  }

  // A setTimeout chain rather than setInterval: a slow step (or a busy main
  // thread in inline mode) delays the next month instead of queueing a burst.
  function schedule() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (state && speed > 0) timer = setTimer(tick, SPEED_DELAYS[speed]);
  }

  function tick() {
    timer = null;
    if (!state || speed === 0) return;
    const { events } = step(state);
    snapshot(events);
    schedule();
  }

  function fresh(msg) {
    state = createState(msg.seed ?? 1);
  }

  const handlers = {
    init(msg) {
      const events = [];
      if (msg.save) {
        try {
          state = deserialize(msg.save);
          events.push({ type: 'loaded', tick: state.tick });
        } catch (err) {
          fresh(msg);
          events.push({ type: 'loadFailed', reason: err.message });
        }
      } else {
        fresh(msg);
      }
      snapshot(events);
      schedule();
    },
    new(msg) {
      fresh(msg);
      snapshot([{ type: 'newCity', seed: state.seed }]);
      schedule();
    },
    tool(msg) {
      if (msg.tool === 'inspect') {
        post({ type: 'inspect', info: inspect(state, msg.x, msg.y) });
        return;
      }
      const r = apply(state, msg.tool, msg.x, msg.y, msg.x2, msg.y2);
      post({ type: 'toolResult', ok: r.ok, cost: r.cost, reason: r.reason, placed: r.placed, tool: msg.tool });
      if (r.ok) snapshot();
    },
    speed(msg) {
      const s = Math.round(Number(msg.speed));
      speed = Number.isFinite(s) ? Math.min(3, Math.max(0, s)) : 0;
      schedule();
      snapshot();
    },
    tax(msg) {
      setTax(state, msg.rate);
      snapshot();
    },
    policy(msg) {
      const r = setPolicy(state, msg.name, msg.value);
      if (!r.ok) post({ type: 'error', reason: r.reason });
      snapshot();
    },
    decide(msg) {
      const r = decide(state, msg.id, msg.decision);
      post({ type: 'decided', id: msg.id, decision: msg.decision, ok: r.ok, reason: r.reason });
      snapshot();
    },
    inspect(msg) {
      post({ type: 'inspect', info: inspect(state, msg.x, msg.y) });
    },
    save() {
      post({ type: 'saved', data: serialize(state) });
    },
    step(msg) {
      const n = Math.min(120, Math.max(1, Math.round(Number(msg.count) || 1)));
      const events = [];
      for (let k = 0; k < n; k++) events.push(...step(state).events);
      snapshot(events);
    },
  };

  function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    const fn = Object.prototype.hasOwnProperty.call(handlers, msg.type) ? handlers[msg.type] : null;
    if (!fn) {
      post({ type: 'error', reason: `Unknown message: ${String(msg.type)}` });
      return;
    }
    if (!state && msg.type !== 'init' && msg.type !== 'new') {
      post({ type: 'error', reason: 'Send init first' });
      return;
    }
    // One bad message must not kill the worker: report it and carry on.
    try {
      fn(msg);
    } catch (err) {
      post({ type: 'error', reason: String((err && err.message) || err) });
    }
  }

  function dispose() {
    speed = 0;
    schedule();
  }

  return { handle, dispose };
}
