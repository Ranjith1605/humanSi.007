// Node test for the Glass Box. Run: node --test web/js/glassbox/glassbox.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  decidingFactor,
  factorById,
  acceptedVerdicts,
  scoreCase,
  rankFor,
  validateGlassbox,
} from './logic.js';

const here = dirname(fileURLToPath(import.meta.url));
const glassbox = JSON.parse(readFileSync(resolve(here, '../../data/glassbox.json'), 'utf8'));

test('the data file is valid', () => {
  assert.equal(validateGlassbox(glassbox), null);
});

test('every case names its greatest-influence factor as the deciding one', () => {
  for (const c of glassbox.cases) {
    assert.equal(c.decidingFactor, decidingFactor(c), `case ${c.id}`);
  }
});

test('opaque and proxy cases never accept a pass', () => {
  for (const c of glassbox.cases) {
    const f = factorById(c, c.decidingFactor);
    if (f.opaque || f.proxyFor) {
      assert.ok(!acceptedVerdicts(c).includes('pass'), `case ${c.id} must not pass`);
    }
  }
});

test('legible cases decide on a visible, non-proxy factor', () => {
  for (const c of glassbox.cases.filter((x) => x.kind === 'legible')) {
    const f = factorById(c, c.decidingFactor);
    assert.ok(!f.opaque && !f.proxyFor, `case ${c.id}`);
    assert.equal(c.correct, 'pass', `case ${c.id} legible should pass`);
  }
});

test('scoreCase rewards factor+verdict, partial-credits verdict only', () => {
  const c = glassbox.cases[0];
  const good = scoreCase(glassbox, c, { namedFactor: c.decidingFactor, verdict: c.correct, probesUsed: c.probeBudget });
  assert.equal(good.solved, true);
  assert.equal(good.insight, glassbox.scoring.factorAndVerdict);

  const verdictOnly = scoreCase(glassbox, c, { namedFactor: 'nope', verdict: c.correct, probesUsed: c.probeBudget });
  assert.equal(verdictOnly.solved, false);
  assert.equal(verdictOnly.insight, glassbox.scoring.verdictOnly);

  const wrong = scoreCase(glassbox, c, { namedFactor: 'nope', verdict: 'pass', probesUsed: 0 });
  assert.equal(wrong.insight, 0);
});

test('saved probes add a bonus only when the factor was found', () => {
  const c = glassbox.cases[0];
  const full = scoreCase(glassbox, c, { namedFactor: c.decidingFactor, verdict: c.correct, probesUsed: c.probeBudget - 2 });
  assert.equal(full.insight, glassbox.scoring.factorAndVerdict + 2 * glassbox.scoring.probeSaved);
  // verdict-only gets no probe bonus
  const vo = scoreCase(glassbox, c, { namedFactor: 'nope', verdict: c.correct, probesUsed: 0 });
  assert.equal(vo.insight, glassbox.scoring.verdictOnly);
});

test('altAccept verdicts are accepted', () => {
  const opaque = glassbox.cases.find((x) => x.inspectable === false);
  assert.ok(opaque, 'there is an opaque case');
  for (const v of acceptedVerdicts(opaque)) {
    const r = scoreCase(glassbox, opaque, { namedFactor: opaque.decidingFactor, verdict: v, probesUsed: opaque.probeBudget });
    assert.equal(r.solved, true, `verdict ${v} accepted`);
  }
});

test('rankFor climbs with insight and never returns undefined', () => {
  assert.equal(rankFor(glassbox, -5).id, glassbox.scoring.ranks[0].id);
  const top = glassbox.scoring.ranks[glassbox.scoring.ranks.length - 1];
  assert.equal(rankFor(glassbox, 99999).id, top.id);
});

test('every cited id exists in the rule book', () => {
  const rb = JSON.parse(readFileSync(resolve(here, '../../data/rulebook.json'), 'utf8'));
  const ids = new Set();
  for (const m of rb.method.modules) ids.add(m.id);
  for (const v of rb.charter.values) for (const a of v.articles) ids.add(a.id);
  for (const c of glassbox.cases) {
    for (const cite of c.cites) assert.ok(ids.has(cite), `case ${c.id} cites unknown ${cite}`);
  }
});
