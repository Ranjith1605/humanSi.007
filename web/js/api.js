// One client for two worlds. When the Go server is running ("fleet" mode)
// the game talks to it: the server re-scores every run, keeps the shared
// board, issues launch clearance and relays the SI console to a local
// open-source model. When the page is served as plain static files, e.g.
// GitHub Pages, there is no server, so the client falls back to "solo"
// mode: the same rule book and scoring, runs kept only in this browser,
// and no console. The UI must always say which mode it is in.

import { validateRun, scoreRun, normalizeCallsign } from './scoring.js';

// Relative to the page, so the site works at / and at /humanSi.007/web/ alike.
const url = (path) => new URL(path, document.baseURI).toString();

const SOLO_KEY = 'humansi.solo.runs.v2';
const CLEARANCE_KEY = 'humansi.clearance.v1';
const state = { mode: null, version: null, copilot: false, rulebook: null, models: null };

async function fetchJSON(path, opts = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url(path), { ...opts, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe for the server once; every later call reuses the answer. On a
 * static host the request finds web/api/health, a marker file that says
 * {"status":"solo"}, so the probe gets a clean answer instead of a 404 in
 * the console. The fleet server's own /api/health route always wins there.
 */
export async function connect({ timeoutMs = 2500 } = {}) {
  if (state.mode) return { mode: state.mode, version: state.version, copilot: state.copilot };
  try {
    const r = await fetchJSON('api/health', {}, timeoutMs);
    if (r.ok && r.body && r.body.status === 'ok') {
      state.mode = 'fleet';
      state.version = r.body.version ?? null;
      state.copilot = r.body.copilot === true;
      return { mode: 'fleet', version: state.version, copilot: state.copilot };
    }
  } catch { /* unreachable or aborted: solo */ }
  state.mode = 'solo';
  return { mode: 'solo', version: null, copilot: false };
}

export function currentMode() {
  return state.mode;
}

export async function getRulebook() {
  if (state.rulebook) return state.rulebook;
  const { mode } = await connect();
  const r = await fetchJSON(mode === 'fleet' ? 'api/rulebook' : 'data/rulebook.json');
  if (!r.ok || !r.body) throw new Error(`rule book unavailable (${r.status})`);
  state.rulebook = r.body;
  return r.body;
}

export async function getModels() {
  if (state.models) return state.models;
  const r = await fetchJSON('data/models.json');
  if (!r.ok || !r.body) throw new Error(`model catalog unavailable (${r.status})`);
  state.models = r.body;
  return r.body;
}

function readList(key) {
  try {
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, 50)));
  } catch { /* private mode or quota: the run still shows on screen */ }
}

function byScore(a, b) {
  return b.score - a.score || a.createdAt.localeCompare(b.createdAt);
}

/**
 * Launch clearance. In fleet mode it is a server-signed token the console
 * requires; in solo mode it is only a local record that this browser
 * cleared the gates, which unlocks the hangar view and nothing else.
 */
export function getClearance() {
  try {
    const c = JSON.parse(localStorage.getItem(CLEARANCE_KEY) || 'null');
    if (!c || typeof c !== 'object') return null;
    if (c.expiresAt && Date.parse(c.expiresAt) <= Date.now()) return null;
    return c;
  } catch {
    return null;
  }
}

function saveClearance(c) {
  try { localStorage.setItem(CLEARANCE_KEY, JSON.stringify(c)); } catch { /* best effort */ }
}

/**
 * Forget this browser's clearance. askCopilot calls it when the server
 * answers 401 (the token expired, was altered, or was signed by an earlier
 * server run), so a reload shows the hangar sealed instead of a console
 * that can only fail.
 */
export function clearClearance() {
  try { localStorage.removeItem(CLEARANCE_KEY); } catch { /* best effort */ }
}

/**
 * Submit a finished (or abandoned) run.
 * Resolves to { entry, placement, result, clearance, mode } or { error: { field, message, retryAfterSec? }, mode }.
 * `result` is the full scoreRun() breakdown computed locally for display;
 * in fleet mode the stored `entry` is the server's own computation.
 */
export async function submitRun({ callsign, sectors }) {
  const { mode } = await connect();
  const rulebook = await getRulebook();
  const name = normalizeCallsign(callsign);
  if (!name) return { mode, error: { field: 'callsign', message: '2–16 letters, digits, space, _ . -' } };
  const bad = validateRun(rulebook, sectors);
  if (bad) return { mode, error: bad };
  const result = scoreRun(rulebook, sectors);

  if (mode === 'fleet') {
    const r = await fetchJSON('api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callsign: name, sectors }),
    });
    if (r.ok) {
      const clearance = r.body.clearance
        ? { kind: 'fleet', callsign: name, token: r.body.clearance.token, expiresAt: r.body.clearance.expiresAt }
        : null;
      if (clearance) saveClearance(clearance);
      return { mode, entry: r.body.entry, placement: r.body.placement, result, clearance };
    }
    const b = r.body || {};
    return {
      mode,
      error: {
        field: b.field ?? null,
        message: b.message ?? `server refused the run (${r.status})`,
        retryAfterSec: b.retryAfterSec ?? null,
      },
    };
  }

  const entry = {
    id: `solo-${Date.now().toString(36)}`,
    callsign: name,
    score: result.score,
    rank: result.rank,
    rankName: result.rankName,
    sectorsCleared: result.sectorsCleared,
    integrity: result.integrity,
    readinessLevel: result.readinessLevel,
    cleared: result.cleared,
    createdAt: new Date().toISOString(),
  };
  const list = [...readList(SOLO_KEY), entry].sort(byScore);
  writeList(SOLO_KEY, list);
  let clearance = null;
  if (result.cleared) {
    clearance = { kind: 'solo', callsign: name, token: null, expiresAt: null };
    saveClearance(clearance);
  }
  return { mode, entry, placement: list.indexOf(entry) + 1, result, clearance };
}

export async function getLeaderboard(limit = 10) {
  const { mode } = await connect();
  if (mode === 'fleet') {
    const r = await fetchJSON(`api/leaderboard?limit=${encodeURIComponent(limit)}`);
    if (r.ok && r.body) return { mode, entries: r.body.entries ?? [], total: r.body.total ?? 0 };
    return { mode, entries: [], total: 0, error: `fleet board unavailable (${r.status})` };
  }
  const list = readList(SOLO_KEY).sort(byScore);
  return { mode, entries: list.slice(0, limit), total: list.length };
}

/**
 * Live feed of runs other pilots finish. Fleet mode only; in solo mode
 * there is nobody else to hear from, so this returns a no-op unsubscribe.
 */
export function subscribeFleet(onRun) {
  if (state.mode !== 'fleet' || typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(url('api/fleet/stream'));
  es.addEventListener('run', (ev) => {
    try { onRun(JSON.parse(ev.data)); } catch { /* malformed event: skip it */ }
  });
  return () => es.close();
}

/**
 * Which hangar models the server can actually run right now.
 * Resolves to { available, models: [ollamaTag…], reason? }.
 */
export async function copilotStatus() {
  const { mode } = await connect();
  if (mode !== 'fleet') return { available: false, models: [], reason: 'solo' };
  const r = await fetchJSON('api/copilot/status', {}, 6000);
  if (r.ok && r.body) return { available: !!r.body.available, models: r.body.models ?? [], reason: r.body.reason ?? null };
  return { available: false, models: [], reason: `status ${r.status}` };
}

/**
 * Ask the SI console. Streams tokens to onToken; resolves when the model
 * finishes. Pass an AbortSignal: aborting is the human override and stops
 * generation on the server as well.
 * Resolves to { ok: true } or { ok: false, error, message }.
 */
export async function askCopilot({ model, messages, signal, onToken }) {
  const c = getClearance();
  if (!c || c.kind !== 'fleet' || !c.token) {
    return { ok: false, error: 'no_clearance', message: 'Clear the Six Gates on the fleet server to open the console.' };
  }
  let res;
  try {
    res = await fetch(url('api/copilot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ model, messages }),
      signal,
    });
  } catch {
    if (signal?.aborted) return { ok: false, error: 'stopped', message: 'Stopped by the pilot.' };
    return { ok: false, error: 'network', message: 'The console could not reach the server.' };
  }
  if (!res.ok || !res.body) {
    const b = await res.json().catch(() => ({}));
    if (res.status === 401) clearClearance();
    return { ok: false, error: b.error ?? `http_${res.status}`, message: b.message ?? `console refused (${res.status})` };
  }
  // Server-sent events over a POST response: parse "event:"/"data:" blocks by hand.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (event === 'token') {
          try { onToken(JSON.parse(data).t ?? ''); } catch { /* skip */ }
        } else if (event === 'error') {
          let m = {};
          try { m = JSON.parse(data); } catch { /* keep default */ }
          return { ok: false, error: m.error ?? 'model_error', message: m.message ?? 'The model stopped with an error.' };
        } else if (event === 'done') {
          return { ok: true };
        }
      }
    }
  } catch {
    if (signal?.aborted) return { ok: false, error: 'stopped', message: 'Stopped by the pilot.' };
    return { ok: false, error: 'network', message: 'The stream was interrupted.' };
  }
  return { ok: true };
}
