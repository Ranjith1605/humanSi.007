// Checks web/js/scoring.js against the shared fixture testdata/score-cases.json.
// The Go server (internal/game) asserts the same fixture, so if either side
// drifts from the other, one of the two suites fails.
//
//   node --test web/js/scoring.test.mjs            run the checks
//   node web/js/scoring.test.mjs --regenerate      rebuild the fixture
//
// The fixture is never typed by hand: the cases below are built from the rule
// book, and every expected value is what scoring.js computes for them. A few
// inputs are written as raw JSON number text (1e1, 5.0, -0, 1e400) because the
// server must read numbers the way JSON.parse does, and only raw text tests that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  COUNTERS,
  sectorCaps,
  validateRun,
  scoreRun,
  normalizeCallsign,
} from '../js/scoring.js';

const FIXTURE = fileURLToPath(new URL('../../testdata/score-cases.json', import.meta.url));
const RULEBOOK = fileURLToPath(new URL('../data/rulebook.json', import.meta.url));
const rulebook = JSON.parse(readFileSync(RULEBOOK, 'utf8'));

// --- case builders ----------------------------------------------------------

// A raw JSON number: kept as a placeholder string until the fixture text is
// written, then substituted verbatim.
const raw = (text) => `@@raw:${text}@@`;
const unraw = (json) => json.replace(/"@@raw:([^@"]+)@@"/g, '$1');

const S = rulebook.sectors;
const minT = rulebook.scoring.minSectorTimeMs;
const maxT = rulebook.scoring.maxSectorTimeMs;
const wrong = (def, q) => (def.gate[q].answer + 1) % def.gate[q].options.length;

/**
 * One sector result. `full` maxes every counter except shortcuts; `correct`
 * is how many of the sector's scenarios get the rule book's answer (the
 * rest get a wrong option); an uncleared sector has -1 for every verdict.
 */
function sector(i, { cleared = true, full = false, correct = Infinity, timeMs = 30000 + i * 1500, set = {}, drop = [] } = {}) {
  const def = S[i];
  const caps = sectorCaps(def);
  const r = { id: def.id, cleared };
  for (const k of COUNTERS) r[k] = full && k !== 'shortcuts' ? caps[k] : 0;
  r.verdicts = def.gate.map((g, q) => (!cleared ? -1 : q < correct ? g.answer : wrong(def, q)));
  r.timeMs = timeMs;
  Object.assign(r, set);
  for (const k of drop) delete r[k];
  return r;
}

/** Every sector cleared; `opts(i)` customises sector i. */
const fullRoute = (opts = () => ({})) => S.map((_, i) => sector(i, opts(i)));
/** Valid cleared prefix of n sectors, then `last` as sector n. */
const prefixThen = (n, last) => [...S.slice(0, n).map((_, i) => sector(i)), last];

const shortcutSector = S.findIndex((s) => s.spawn.shortcuts > 0);
const chainSector = S.findIndex((s) => s.spawn.humanPods + s.spawn.siPods > 1);
const noShortcutSector = S.findIndex((s) => s.spawn.shortcuts === 0);
const totalScenarios = S.reduce((n, s) => n + s.gate.length, 0);

/** Exactly `n` correct verdicts across a fully cleared route, earliest scenarios first. */
function routeWithCorrect(n, opts = () => ({})) {
  let left = n;
  return fullRoute((i) => {
    const take = Math.min(left, S[i].gate.length);
    left -= take;
    return { correct: take, ...opts(i) };
  });
}

const minLevel = rulebook.method.minimumRule.level;
const levelFloor = (level) => rulebook.scoring.readinessLevels.find((l) => l.level === level).minCorrect;

function buildRuns() {
  const runs = [];
  const ok = (name, sectors) => runs.push({ name, sectors });
  const bad = (name, sectors) => runs.push({ name, sectors, invalid: true });

  // Valid runs.
  ok('perfect run: every counter maxed, no shortcuts, every verdict right', fullRoute(() => ({ full: true })));
  ok('minimal clearing run: nothing collected, exactly the minimum-rule verdicts, fastest legal times',
    routeWithCorrect(levelFloor(minLevel), () => ({ timeMs: minT })));
  ok('below the minimum rule: every gate cleared, one verdict short of readiness Level 3',
    routeWithCorrect(levelFloor(minLevel) - 1));
  ok('partial run ending uncleared: two gates, then hull lost in the third sector',
    prefixThen(2, sector(2, { cleared: false, set: { cores: 7 }, timeMs: 3000 })));
  ok('lost in the first sector with nothing collected', [sector(0, { cleared: false, timeMs: 0 })]);
  ok('shortcut-heavy run floored at zero',
    [...S.slice(0, shortcutSector).map((_, i) => sector(i, { correct: 0 })),
      sector(shortcutSector, { cleared: false, set: { shortcuts: S[shortcutSector].spawn.shortcuts } })]);
  ok('one shortcut keeps a perfect score out of the top rank',
    fullRoute((i) => ({ full: true, set: i === shortcutSector ? { shortcuts: 1 } : {} })));
  ok('two shortcuts: integrity at the middle rank threshold',
    fullRoute((i) => ({ full: true, set: i === shortcutSector ? { shortcuts: 2 } : {} })));
  ok('readiness Level 4 boundary', routeWithCorrect(levelFloor(4), () => ({ full: true })));
  ok('readiness Level 5 boundary', routeWithCorrect(levelFloor(5)));
  ok('slowest legal times', fullRoute(() => ({ timeMs: maxT })));
  ok('uncleared final sector may be faster than the minimum time',
    prefixThen(1, sector(1, { cleared: false, timeMs: minT - 1 })));
  ok('integer-valued number forms (1e1, 2.0, 9000.0, -0) are integers, as in JavaScript',
    [sector(0, { set: { cores: raw('1e1'), scans: raw('2.0'), timeMs: raw('9000.0'), verdicts: [S[0].gate[0].answer, raw('-0')] } })]);
  ok('unknown extra fields are ignored', [sector(0, { set: { score: 999999, rank: 'ri', note: 'ignored' } })]);
  ok('all scenarios answered wrongly', routeWithCorrect(0, () => ({ full: true })));

  // Invalid runs: one per rule in validateRun.
  bad('empty run', []);
  bad('sectors is not an array', { 0: sector(0) });
  bad('sectors is null', null);
  bad('more sectors than the rule book defines', [...fullRoute(), sector(S.length - 1)]);
  bad('wrong order: starts at the second sector', [sector(1)]);
  bad('unknown sector id', [sector(0, { set: { id: 'nowhere' } })]);
  bad('sector is a number', [5]);
  bad('sector is null', [null]);
  bad('sector is an array', [[]]);
  bad('uncleared sector in the middle', [sector(0, { cleared: false }), sector(1)]);
  bad('cleared is a string', [sector(0, { set: { cleared: 'true' } })]);
  bad('cleared is missing', [sector(0, { drop: ['cleared'] })]);
  bad('counter over its cap', [sector(0, { set: { cores: S[0].spawn.cores + 1 } })]);
  bad('chain links over their cap', prefixThen(chainSector, sector(chainSector, { set: { chainLinks: sectorCaps(S[chainSector]).chainLinks + 1 } })));
  bad('shortcut in a sector that has none', prefixThen(noShortcutSector, sector(noShortcutSector, { set: { shortcuts: 1 } })));
  bad('negative counter', [sector(0, { set: { scans: -1 } })]);
  bad('non-integer counter', [sector(0, { set: { scans: 2.5 } })]);
  bad('counter as a string', [sector(0, { set: { cores: '3' } })]);
  bad('counter missing', [sector(0, { drop: ['reviews'] })]);
  bad('counter overflowing to Infinity', [sector(0, { set: { cores: raw('1e400') } })]);
  bad('wrong verdict count', [sector(0, { set: { verdicts: [S[0].gate[0].answer] } })]);
  bad('verdicts is not an array', [sector(0, { set: { verdicts: '1,0' } })]);
  bad('verdict out of range', [sector(0, { set: { verdicts: [S[0].gate[0].answer, S[0].gate[1].options.length] } })]);
  bad('verdict below -1', [sector(0, { set: { verdicts: [-2, S[0].gate[1].answer] } })]);
  bad('non-integer verdict', [sector(0, { set: { verdicts: [0.5, S[0].gate[1].answer] } })]);
  bad('-1 verdict in a cleared sector', [sector(0, { set: { verdicts: [S[0].gate[0].answer, -1] } })]);
  bad('answered verdict in an uncleared sector', prefixThen(1, sector(1, { cleared: false, set: { verdicts: [-1, 0] } })));
  bad('-0 verdict in an uncleared sector is still an answer', [sector(0, { cleared: false, set: { verdicts: [-1, raw('-0')] } })]);
  bad('cleared faster than the sector can be flown', [sector(0, { timeMs: minT - 1 })]);
  bad('time over the maximum', [sector(0, { timeMs: maxT + 1 })]);
  bad('negative time', [sector(0, { cleared: false, timeMs: -1 })]);
  bad('non-integer time', [sector(0, { timeMs: minT + 0.5 })]);
  bad('time missing', [sector(0, { drop: ['timeMs'] })]);
  bad('error in a later sector is reported with its index',
    prefixThen(S.length - 1, sector(S.length - 1, { set: { reviews: -3 } })));
  return runs;
}

const CALLSIGNS = [
  'Nova',
  '  Nova   Pilot  ',
  'ab',
  'a',
  'A23456789012345P',
  'A234567890123456Q',
  '_nova',
  '.nova',
  'nova_7.x-y',
  'Nová',
  'tab\there',
  'nb sp',
  '﻿Nova',
  'Nova\u0085',
  ' Nova ',
  'line sep',
  '   ',
  '',
  'no/slash',
  'emoji \u{1F680}',
];

/** The fixture text that the current rule book and scoring.js produce. */
function generate() {
  const runs = buildRuns().map(({ name, sectors, invalid }) => {
    // Score the parsed form of the exact text the fixture will hold.
    const parsed = JSON.parse(unraw(JSON.stringify(sectors)));
    const err = validateRun(rulebook, parsed);
    if (invalid && !err) throw new Error(`case "${name}" was meant to be invalid but validates`);
    if (!invalid && err) throw new Error(`case "${name}" was meant to be valid: ${err.field} ${err.message}`);
    if (err) return { name, sectors, error: { field: err.field, message: err.message } };
    const r = scoreRun(rulebook, parsed);
    return {
      name,
      sectors,
      expect: {
        score: r.score,
        perSector: r.perSector,
        integrity: r.integrity,
        rank: r.rank,
        rankName: r.rankName,
        sectorsCleared: r.sectorsCleared,
        correctVerdicts: r.correctVerdicts,
        readinessLevel: r.readinessLevel,
        cleared: r.cleared,
      },
    };
  });
  const callsigns = CALLSIGNS.map((c) => ({ raw: c, expect: normalizeCallsign(c) }));
  const doc = {
    about:
      'Shared scoring fixture for web/js/scoring.js and the Go server (internal/game). ' +
      'Generated by `node web/js/scoring.test.mjs --regenerate` from data/rulebook.json; expected values are what scoring.js computes. Do not edit by hand.',
    scenarios: totalScenarios,
    runs,
    callsigns,
  };
  // Escape non-ASCII so invisible characters stay visible in review.
  const text = unraw(JSON.stringify(doc, null, 1)).replace(
    /[\u007f-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${text}\n`;
}

// --- entry point ------------------------------------------------------------

if (process.argv.includes('--regenerate')) {
  writeFileSync(FIXTURE, generate());
  console.log(`wrote ${FIXTURE}`);
} else {
  const fixtureText = readFileSync(FIXTURE, 'utf8');
  const fixture = JSON.parse(fixtureText);

  test('fixture is current with the rule book and scoring.js', () => {
    assert.equal(fixtureText, generate(), 'run: node web/js/scoring.test.mjs --regenerate');
  });

  test('fixture covers the required kinds of run', () => {
    assert.ok(fixture.runs.length >= 16);
    const valid = fixture.runs.filter((c) => c.expect);
    assert.ok(valid.some((c) => c.expect.cleared && c.expect.readinessLevel === 5), 'a perfect cleared run');
    assert.ok(valid.some((c) => c.expect.cleared && c.expect.readinessLevel === minLevel), 'a minimal clearing run');
    assert.ok(valid.some((c) => c.expect.sectorsCleared === S.length && !c.expect.cleared), 'below the minimum rule');
    assert.ok(valid.some((c) => c.expect.score === 0 && c.expect.perSector.some((p) => p < 0)), 'floored at zero');
    const fields = new Set(fixture.runs.filter((c) => c.error).map((c) => c.error.message));
    for (const m of [
      'a run needs at least one sector',
      'more sectors than the rule book defines',
      'must be an object',
      'must be true or false',
      'only the final sector of a run may be uncleared',
      'must be a non-negative integer',
      'not an option of this scenario',
      'an uncleared sector cannot have verdicts',
      'a cleared gate needs a verdict for every scenario',
      'implausible sector time',
      'cleared faster than the sector can be flown',
    ]) {
      assert.ok(fields.has(m), `an invalid case for "${m}"`);
    }
  });

  for (const c of fixture.runs) {
    test(`run: ${c.name}`, () => {
      const err = validateRun(rulebook, c.sectors);
      if (c.error) {
        assert.deepEqual(err, c.error);
        return;
      }
      assert.equal(err, null);
      const r = scoreRun(rulebook, c.sectors);
      for (const [k, v] of Object.entries(c.expect)) assert.deepEqual(r[k], v, k);
    });
  }

  test('callsigns normalise as the fixture says', () => {
    for (const c of fixture.callsigns) assert.equal(normalizeCallsign(c.raw), c.expect, JSON.stringify(c.raw));
  });
}
