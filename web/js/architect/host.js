// Architect — the bridge between the page and the simulation. It runs the sim
// in a module worker so a month's step never stalls a frame on a phone, and
// falls back to running protocol.js on the main thread when a module worker
// cannot start (older browsers throw, or fail to load the module later), when
// asked to (`inline: true`), or with ?worker=0 in the URL. Both modes have the
// same interface and the same ordering: send() never delivers a reply before
// it returns.
//
//   const host = createHost((msg) => { ... }, { inline: false });
//   host.send({ type: 'init', seed: 42 });
//   host.mode;                 // 'worker' | 'inline' (can switch to 'inline' once, early)

function wantsInline() {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).get('worker') === '0';
  } catch {
    return false;
  }
}

// Inline messages are cloned, as a worker's would be, so a caller that reuses
// or mutates a message object after send() sees the same behaviour in both modes.
function clone(msg) {
  try {
    return typeof structuredClone === 'function' ? structuredClone(msg) : JSON.parse(JSON.stringify(msg));
  } catch {
    return msg;
  }
}

export function createHost(onMessage, { inline = false } = {}) {
  let mode = 'worker';
  let worker = null;
  let ready = false; // the worker's module has loaded and answered
  let pending = []; // sent to the worker before it was ready; replayed if it fails
  let protocol = null;
  let queued = []; // sent while the inline protocol was still loading
  let disposed = false;

  const deliver = (msg) => {
    if (!disposed) onMessage(msg);
  };

  function startInline() {
    mode = 'inline';
    // Loaded on demand: in worker mode the page never parses the sim at all.
    import('./protocol.js')
      .then(({ createProtocol }) => {
        if (disposed) return;
        protocol = createProtocol((msg) => queueMicrotask(() => deliver(msg)));
        const backlog = queued;
        queued = [];
        for (const msg of backlog) protocol.handle(msg);
      })
      .catch((err) => deliver({ type: 'error', reason: `Simulation failed to load: ${err.message}` }));
  }

  function fallBack() {
    if (mode === 'inline') return;
    if (worker) {
      worker.terminate();
      worker = null;
    }
    queued = pending.map(clone);
    pending = [];
    startInline();
  }

  if (!inline && !wantsInline() && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./sim.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        if (!ready) {
          ready = true;
          pending = [];
        }
        if (e.data && e.data.type === 'ready') return;
        deliver(e.data);
      };
      worker.onerror = (e) => {
        // Before 'ready' this is a load failure (no module workers, or a
        // script error): retry inline. After it, protocol.js has already
        // caught message errors, so this is unexpected: report it.
        if (!ready) {
          if (e && e.preventDefault) e.preventDefault();
          fallBack();
        } else {
          deliver({ type: 'error', reason: (e && e.message) || 'Simulation worker error' });
        }
      };
    } catch {
      worker = null;
    }
  }
  if (!worker) startInline();

  function send(msg) {
    if (disposed) return;
    if (mode === 'worker' && worker) {
      if (!ready) pending.push(msg);
      worker.postMessage(msg);
      return;
    }
    const copy = clone(msg);
    if (protocol) queueMicrotask(() => protocol.handle(copy));
    else queued.push(copy);
  }

  function terminate() {
    disposed = true;
    if (worker) worker.terminate();
    if (protocol) protocol.dispose();
    worker = null;
    protocol = null;
  }

  return {
    send,
    terminate,
    get mode() {
      return mode;
    },
  };
}
