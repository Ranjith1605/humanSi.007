// Architect — the simulation's module worker. It only wires protocol.js to the
// worker's message port, so the inline fallback in host.js runs exactly the
// same code on the main thread. Layer buffers are transferred, not copied:
// protocol.js makes fresh copies for every message, so nothing here keeps them.
import { createProtocol } from './protocol.js';

const protocol = createProtocol((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (e) => protocol.handle(e.data);
// Tells host.js the module loaded: until then it keeps the messages it sent,
// so it can replay them inline if this worker fails to start.
self.postMessage({ type: 'ready' });
