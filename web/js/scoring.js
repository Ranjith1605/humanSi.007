// Scoring for a HumanSI Synergy run. This file is the specification:
// the Go server (internal/game) recomputes every submitted run with the
// same rules, and both implementations are checked against the shared
// fixture testdata/score-cases.json, so a score shown in the browser is
// the score the fleet board stores, and a launch clearance the server
// issues is one the browser would also have predicted.

/**
 * @typedef {Object} SectorResult
 * @property {string} id           sector id from rulebook.sectors
 * @property {boolean} cleared     reached the gate
 * @property {number} cores
 * @property {number} chainLinks
 * @property {number} assists
 * @property {number} harmonized
 * @property {number} scans
 * @property {number} reviews
 * @property {number} shortcuts
 * @property {number[]} verdicts   chosen option index per gate scenario, -1 if not reached
 * @property {number} timeMs       simulated flight time in the sector
 */

export const COUNTERS = ['cores', 'chainLinks', 'assists', 'harmonized', 'scans', 'reviews', 'shortcuts'];

/** Upper bound for each counter, derived from what the sector actually spawns. */
export function sectorCaps(sector) {
  const s = sector.spawn;
  const pods = s.humanPods + s.siPods;
  return {
    cores: s.cores,
    chainLinks: pods > 0 ? pods - 1 : 0,
    assists: s.stranded,
    harmonized: s.discord,
    scans: s.anomalies,
    reviews: s.satellites,
    shortcuts: s.shortcuts,
  };
}

/**
 * Check a run against the rule book. Returns null when valid, or
 * { field, message } describing the first problem found.
 */
export function validateRun(rulebook, sectors) {
  const rules = rulebook.scoring;
  if (!Array.isArray(sectors) || sectors.length === 0) {
    return { field: 'sectors', message: 'a run needs at least one sector' };
  }
  if (sectors.length > rulebook.sectors.length) {
    return { field: 'sectors', message: 'more sectors than the rule book defines' };
  }
  for (let i = 0; i < sectors.length; i++) {
    const r = sectors[i];
    const def = rulebook.sectors[i];
    const at = `sectors[${i}]`;
    if (!r || typeof r !== 'object') return { field: at, message: 'must be an object' };
    // Sectors are flown in order, so a run is always a prefix of the route.
    if (r.id !== def.id) return { field: `${at}.id`, message: `expected sector ${def.id}` };
    if (typeof r.cleared !== 'boolean') return { field: `${at}.cleared`, message: 'must be true or false' };
    // Only the last sector of a run may be uncleared: you can't fly past a gate you never reached.
    if (!r.cleared && i !== sectors.length - 1) {
      return { field: `${at}.cleared`, message: 'only the final sector of a run may be uncleared' };
    }
    const caps = sectorCaps(def);
    for (const k of COUNTERS) {
      const v = r[k];
      if (!Number.isInteger(v) || v < 0) return { field: `${at}.${k}`, message: 'must be a non-negative integer' };
      if (v > caps[k]) return { field: `${at}.${k}`, message: `exceeds the ${caps[k]} this sector holds` };
    }
    if (!Array.isArray(r.verdicts) || r.verdicts.length !== def.gate.length) {
      return { field: `${at}.verdicts`, message: `expected ${def.gate.length} verdicts` };
    }
    for (let q = 0; q < r.verdicts.length; q++) {
      const a = r.verdicts[q];
      if (!Number.isInteger(a) || a < -1 || a >= def.gate[q].options.length) {
        return { field: `${at}.verdicts[${q}]`, message: 'not an option of this scenario' };
      }
      // The gate sits at the end of the sector: an uncleared sector has no verdicts,
      // and a cleared one has a verdict for every scenario.
      if (!r.cleared && a !== -1) {
        return { field: `${at}.verdicts[${q}]`, message: 'an uncleared sector cannot have verdicts' };
      }
      if (r.cleared && a === -1) {
        return { field: `${at}.verdicts[${q}]`, message: 'a cleared gate needs a verdict for every scenario' };
      }
    }
    if (!Number.isInteger(r.timeMs) || r.timeMs < 0 || r.timeMs > rules.maxSectorTimeMs) {
      return { field: `${at}.timeMs`, message: 'implausible sector time' };
    }
    if (r.cleared && r.timeMs < rules.minSectorTimeMs) {
      return { field: `${at}.timeMs`, message: 'cleared faster than the sector can be flown' };
    }
  }
  return null;
}

/** Number of gate verdicts that match the rule book's answer. */
export function correctVerdicts(def, r) {
  let n = 0;
  r.verdicts.forEach((a, q) => { if (a === def.gate[q].answer) n++; });
  return n;
}

/** Score for one sector. Assumes the run already passed validateRun. */
export function scoreSector(rulebook, def, r) {
  const p = rulebook.scoring;
  return (
    r.cores * p.core +
    r.chainLinks * p.chainLink +
    r.assists * p.assist +
    r.harmonized * p.harmonize +
    r.scans * p.scan +
    r.reviews * p.review +
    r.shortcuts * (p.shortcutGain - p.shortcutPenalty) +
    correctVerdicts(def, r) * p.correctVerdict +
    (r.cleared ? p.sectorClear : 0)
  );
}

/** Integrity only falls, one fixed step per shortcut taken, never below zero. */
export function integrityOf(rulebook, sectors) {
  const p = rulebook.scoring;
  const taken = sectors.reduce((n, r) => n + r.shortcuts, 0);
  return Math.max(0, p.integrityStart - taken * p.integrityPerShortcut);
}

/** Readiness level from the number of correct gate verdicts across the run. */
export function readinessLevel(rulebook, correct) {
  let level = rulebook.scoring.readinessLevels[0].level;
  for (const l of rulebook.scoring.readinessLevels) {
    if (correct >= l.minCorrect) level = l.level;
  }
  return level;
}

/** Highest rank whose score and integrity thresholds are both met. */
export function rankFor(rulebook, score, integrity) {
  let best = rulebook.ranks[0];
  for (const rank of rulebook.ranks) {
    if (score >= rank.minScore && integrity >= rank.minIntegrity) best = rank;
  }
  return best;
}

/**
 * Full result for a validated run. A run's total is floored at zero so a
 * shortcut-heavy run reads as "nothing earned" rather than a debt.
 *
 * `cleared` is the playbook's minimum rule made playable: every gate
 * flown and readiness at or above the minimum level. Only a cleared run
 * earns launch clearance for the Model Hangar.
 */
export function scoreRun(rulebook, sectors) {
  const perSector = sectors.map((r, i) => scoreSector(rulebook, rulebook.sectors[i], r));
  const score = Math.max(0, perSector.reduce((a, b) => a + b, 0));
  const integrity = integrityOf(rulebook, sectors);
  const rank = rankFor(rulebook, score, integrity);
  const sectorsCleared = sectors.filter((r) => r.cleared).length;
  const correct = sectors.reduce((n, r, i) => n + correctVerdicts(rulebook.sectors[i], r), 0);
  const readiness = readinessLevel(rulebook, correct);
  const cleared =
    sectorsCleared === rulebook.sectors.length && readiness >= rulebook.method.minimumRule.level;
  return {
    score,
    perSector,
    integrity,
    rank: rank.id,
    rankName: rank.name,
    sectorsCleared,
    correctVerdicts: correct,
    readinessLevel: readiness,
    cleared,
  };
}

/** Callsigns are what other pilots see on the fleet board, so keep them short and plain. */
export const CALLSIGN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,15}$/;

export function normalizeCallsign(raw) {
  const c = String(raw ?? '').trim().replace(/\s+/g, ' ');
  return CALLSIGN_PATTERN.test(c) ? c : null;
}
