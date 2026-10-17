// The Glass Box — pure logic, no DOM. The page uses it and the node test
// (glassbox.test.mjs) checks it, so the rules that score a case are in one place.

/**
 * The deciding factor is the one with the greatest absolute influence on the
 * decision. That is what "tipped it" means mechanically, and the authored
 * `decidingFactor` must agree with it — the test enforces that, so the data
 * can never quietly disagree with the mechanic.
 */
export function decidingFactor(caseDef) {
  let best = null;
  for (const f of caseDef.factors) {
    if (best === null || Math.abs(f.influence) > Math.abs(best.influence)) best = f;
  }
  return best ? best.id : null;
}

export function factorById(caseDef, id) {
  return caseDef.factors.find((f) => f.id === id) || null;
}

/** Verdicts the case accepts: the correct one, plus any listed alternatives. */
export function acceptedVerdicts(caseDef) {
  return [caseDef.correct, ...(caseDef.altAccept || [])];
}

/**
 * Score one attempt. Full credit needs both the right deciding factor and an
 * accepted verdict; a right verdict alone earns partial credit, because
 * stopping an indefensible decision for the wrong reason is still the right
 * call but not yet understanding. Saved probes add a small efficiency bonus,
 * never a penalty, and only when the factor was found.
 */
export function scoreCase(glassbox, caseDef, attempt) {
  const s = glassbox.scoring;
  const factorCorrect = attempt.namedFactor === decidingFactor(caseDef);
  const verdictCorrect = acceptedVerdicts(caseDef).includes(attempt.verdict);
  const probesUsed = Number.isInteger(attempt.probesUsed) ? attempt.probesUsed : caseDef.probeBudget;
  const probesSaved = Math.max(0, caseDef.probeBudget - probesUsed);

  let insight = 0;
  if (factorCorrect && verdictCorrect) insight = s.factorAndVerdict + probesSaved * s.probeSaved;
  else if (verdictCorrect) insight = s.verdictOnly;

  return { factorCorrect, verdictCorrect, solved: factorCorrect && verdictCorrect, insight };
}

/** Highest rank whose insight threshold the total meets. */
export function rankFor(glassbox, totalInsight) {
  let best = glassbox.scoring.ranks[0];
  for (const r of glassbox.scoring.ranks) if (totalInsight >= r.minInsight) best = r;
  return best;
}

/**
 * Validate the data at load time, so a malformed case fails loudly in the page
 * instead of mis-teaching. Returns null when valid, or a {caseId, message}.
 */
export function validateGlassbox(glassbox) {
  if (!glassbox || !Array.isArray(glassbox.cases) || glassbox.cases.length === 0) {
    return { caseId: null, message: 'no cases' };
  }
  const verdictIds = new Set(glassbox.verdicts.map((v) => v.id));
  const seen = new Set();
  for (const c of glassbox.cases) {
    const at = c.id || '(missing id)';
    if (!c.id || seen.has(c.id)) return { caseId: at, message: 'missing or duplicate id' };
    seen.add(c.id);
    if (!Array.isArray(c.factors) || c.factors.length < 2) return { caseId: at, message: 'need at least two factors' };
    const ids = new Set();
    for (const f of c.factors) {
      if (!f.id || ids.has(f.id)) return { caseId: at, message: 'missing or duplicate factor id' };
      ids.add(f.id);
      if (!Number.isFinite(f.influence)) return { caseId: at, message: `factor ${f.id} has no numeric influence` };
    }
    if (!Number.isInteger(c.probeBudget) || c.probeBudget < 1 || c.probeBudget > c.factors.length) {
      return { caseId: at, message: 'probeBudget must be 1..factors.length' };
    }
    // The authored deciding factor must be the greatest-influence one: the mechanic and the answer agree.
    if (c.decidingFactor !== decidingFactor(c)) return { caseId: at, message: 'decidingFactor is not the greatest-influence factor' };
    if (!ids.has(c.decidingFactor)) return { caseId: at, message: 'decidingFactor is not a factor id' };
    if (!verdictIds.has(c.correct)) return { caseId: at, message: `unknown correct verdict ${c.correct}` };
    for (const v of c.altAccept || []) if (!verdictIds.has(v)) return { caseId: at, message: `unknown altAccept verdict ${v}` };
    // An opaque case must have its deciding factor opaque (that is the lesson), and must not accept "pass".
    const decidesOnOpaque = !!factorById(c, c.decidingFactor).opaque;
    if (c.inspectable === false && !decidesOnOpaque) return { caseId: at, message: 'uninspectable case must decide on an opaque factor' };
    if (decidesOnOpaque && acceptedVerdicts(c).includes('pass')) return { caseId: at, message: 'a decision that turns on an opaque factor cannot pass' };
    // A proxy deciding factor cannot be passed either.
    if (factorById(c, c.decidingFactor).proxyFor && acceptedVerdicts(c).includes('pass')) {
      return { caseId: at, message: 'a decision that turns on a proxy cannot pass' };
    }
    if (!Array.isArray(c.cites) || c.cites.length === 0) return { caseId: at, message: 'missing cites' };
    if (typeof c.explain !== 'string' || c.explain.length < 20) return { caseId: at, message: 'missing explain' };
  }
  return null;
}
