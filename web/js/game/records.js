// Personal records, kept only in this browser: which levels this device has
// reached (for the level select), and per level the best time, the best
// completion percentage and the best seal. These are replay hooks, not
// scores: the score always comes from scoring.js and is never stored here.

import { correctVerdicts } from '../scoring.js';

const KEY = 'humansi.nova.records.v1';
const SEALS = ['none', 'bronze', 'silver', 'gold'];

function load() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (r && typeof r === 'object' && r.levels && typeof r.levels === 'object') return r;
  } catch { /* corrupt or blocked: start fresh */ }
  return { reached: 1, levels: {} };
}

let data = load();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* private mode: records last for this visit */ }
}

/** Number of levels reached on this device (G1 is always reachable). */
export function reached() {
  return Math.max(1, data.reached | 0);
}

export function markReached(levelIndex) {
  if (levelIndex + 1 > reached()) {
    data.reached = levelIndex + 1;
    save();
  }
}

export function levelRecord(sectorId) {
  return data.levels[sectorId] || null;
}

/**
 * Completion: gems, the mechanic's items (shortcuts left alone, for the
 * integrity gate) and correct verdicts, as a share of what the level holds.
 */
export function completionOf(sector, mech, result) {
  const [mDone, mMax] = mech.mechanicProgress();
  const correct = result.cleared ? correctVerdicts(sector, result) : 0;
  const done = result.cores + mDone + correct;
  const max = sector.spawn.cores + mMax + sector.gate.length;
  return max > 0 ? Math.round((done / max) * 100) : 0;
}

export function sealFor(cleared, completion) {
  if (!cleared) return 'none';
  if (completion >= 100) return 'gold';
  if (completion >= 75) return 'silver';
  return 'bronze';
}

/** Record a flown level; returns what improved. */
export function recordLevel(sectorId, { cleared, timeMs, completion }) {
  const prev = data.levels[sectorId] || { bestTimeMs: null, bestCompletion: 0, seal: 'none' };
  const seal = sealFor(cleared, completion);
  const out = { newTime: false, newCompletion: false, newSeal: false, seal, completion };
  const next = { ...prev };
  if (cleared && (prev.bestTimeMs === null || timeMs < prev.bestTimeMs)) {
    next.bestTimeMs = timeMs;
    out.newTime = prev.bestTimeMs !== null;
    out.firstClear = prev.bestTimeMs === null;
  }
  if (completion > prev.bestCompletion) {
    next.bestCompletion = completion;
    out.newCompletion = prev.bestCompletion > 0;
  }
  if (SEALS.indexOf(seal) > SEALS.indexOf(prev.seal || 'none')) {
    next.seal = seal;
    out.newSeal = true;
  }
  data.levels[sectorId] = next;
  save();
  return out;
}

export function formatTime(ms) {
  if (ms === null || ms === undefined) return '--:--.-';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}

export function reload() {
  data = load();
}
