// Nova Run: boot and the flow between screens.
// title → (briefing → flight → gate) × 6 → readiness → finale or the
// minimum-rule ending → debrief. Practice flights (level select) fly one
// reached gate and are never submitted. Scores come only from scoring.js,
// server access only through api.js, Rule Book text only from rulebook.json.

import * as api from '../api.js';
import { validateRun, scoreRun, scoreSector, normalizeCallsign } from '../scoring.js';
import { Engine } from './engine.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';
import { LevelRun, HULL_CELLS, HULL_PER_CELL } from './game.js';
import { validateLevels } from './level.js';
import * as records from './records.js';
import { novaSprites } from './sprites.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const CALLSIGN_KEY = 'humansi.nova.callsign';
const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

const app = {
  screen: 'loading',
  rulebook: null,
  levels: null,
  mode: 'solo',
  session: null,
  run: null,
  time: 0,
  backdrop: 'crystal',
};

const input = new Input();
const audio = new Audio();
const canvas = document.getElementById('screen');
const renderer = new Renderer(canvas);
const ui = new UI({ input, audio });
const engine = new Engine({ update, render });

const ts = Number(params.get('timescale'));
if (Number.isFinite(ts) && ts >= 1) engine.setTimescale(Math.min(8, ts));

function reducedMotion() {
  return !!motionQuery.matches;
}

function loadCallsign() {
  try { return localStorage.getItem(CALLSIGN_KEY) || ''; } catch { return ''; }
}

function saveCallsign(c) {
  try { localStorage.setItem(CALLSIGN_KEY, c); } catch { /* fine */ }
}

function moduleOf(sector) {
  return app.rulebook.method.modules.find((m) => m.id === sector.moduleId);
}

function setScreen(s) {
  app.screen = s;
  document.body.dataset.screen = s;
  input.enabled = s === 'play';
  if (s !== 'play') input.clear();
}

// ---------------------------------------------------------------- boot ----

async function boot() {
  setScreen('loading');
  ui.showLoading('Loading the Rule Book…');
  engine.start();
  const conn = await api.connect();
  app.mode = conn.mode;
  try {
    app.rulebook = await api.getRulebook();
  } catch (e) {
    console.error('[nova] rule book', e);
    setScreen('error');
    ui.showDevError('The Rule Book could not be loaded', [String(e.message || e)]);
    return;
  }
  let mod;
  try {
    mod = await import('./levels/index.js');
  } catch (e) {
    console.error('[nova] levels', e);
    setScreen('error');
    ui.showDevError('The levels could not be loaded', [`web/js/game/levels/index.js: ${e.message || e}`]);
    return;
  }
  app.levels = mod.LEVELS;
  const problems = validateLevels(app.levels, app.rulebook);
  if (problems.length) {
    console.error('[nova] level validation failed', problems);
    setScreen('error');
    ui.showDevError('A level disagrees with the Rule Book', problems);
    return;
  }
  novaSprites();
  toTitle();
}

function toTitle() {
  ui.leaveDebrief();
  audio.stopTheme();
  app.run = null;
  app.session = null;
  ui.showHUD(false);
  setScreen('title');
  const last = Math.min(records.reached(), app.levels.length) - 1;
  app.backdrop = app.levels[Math.max(0, last)]?.world || 'crystal';
  const { novaCanvas } = ui.showTitle({
    rulebook: app.rulebook,
    levels: app.levels,
    mode: app.mode,
    callsign: loadCallsign(),
    onStart: (raw) => {
      const c = normalizeCallsign(raw);
      if (!c) return 'Pick a callsign: 2–16 letters, digits, space, _ . -';
      saveCallsign(c);
      audio.unlock();
      audio.sfx('confirm');
      app.session = { practice: false, index: 0, results: [], seals: [], callsign: c };
      briefing(0);
      return null;
    },
    onPractice: (i, raw) => {
      const c = normalizeCallsign(raw);
      if (c) saveCallsign(c);
      audio.unlock();
      audio.sfx('confirm');
      app.session = { practice: true, index: i, results: [], seals: [], callsign: c || '' };
      briefing(i);
      return null;
    },
  });
  const ctx = novaCanvas.getContext('2d');
  ctx.drawImage(novaSprites().idle[0].right, 0, 0);
}

// ------------------------------------------------------------- flights ----

function briefing(i) {
  const sector = app.rulebook.sectors[i];
  app.session.index = i;
  app.run = null;
  ui.showHUD(false);
  setScreen('briefing');
  app.backdrop = app.levels[i].world;
  ui.showBriefing({
    index: i,
    total: app.rulebook.sectors.length,
    sector,
    module: moduleOf(sector),
    practice: app.session.practice,
    onLaunch: () => launch(i),
    onBack: app.session.practice ? toTitle : null,
  });
  audio.sfx('select');
}

function launch(i) {
  const sector = app.rulebook.sectors[i];
  const def = app.levels[i];
  audio.unlock();
  const run = new LevelRun({
    def,
    sector,
    module: moduleOf(sector),
    levelIndex: i,
    rulebook: app.rulebook,
    audio,
    reducedMotion: reducedMotion(),
    practice: app.session.practice,
  });
  run.onGate = () => openGate();
  run.onHullOut = () => hullOut();
  app.run = run;
  records.markReached(i);
  ui.hide();
  ui.hudCache = {};
  ui.showHUD(true);
  setScreen('play');
  audio.playTheme(def.world, def.music);
  ui.announce(`Gate ${i + 1}, ${sector.name}. Flying.`);
}

function pause() {
  if (app.screen !== 'play' || !app.run || app.run.state !== 'play') return false;
  setScreen('paused');
  audio.pauseTheme(true);
  ui.showPause({
    practice: app.session.practice,
    onResume: resume,
    onRestart: () => {
      audio.pauseTheme(false);
      launch(app.session.index);
    },
    onQuit: () => {
      audio.pauseTheme(false);
      if (app.session.practice) toTitle();
      else abandon();
    },
  });
  return true;
}

function resume() {
  if (app.screen !== 'paused') return;
  ui.hide();
  setScreen('play');
  audio.pauseTheme(false);
}

input.onPause = (e) => {
  if (app.screen === 'play') return pause();
  if (app.screen === 'paused') {
    resume();
    return true;
  }
  return false;
};
input.onMute = () => {
  audio.unlock();
  audio.toggleMute();
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

function shortcutsSoFar() {
  return app.session.results.reduce((n, r) => n + (r ? r.shortcuts : 0), 0);
}

function liveIntegrity() {
  const s = app.rulebook.scoring;
  const taken = shortcutsSoFar() + (app.run ? app.run.mech.shortcuts : 0);
  return Math.max(0, s.integrityStart - taken * s.integrityPerShortcut);
}

function openGate() {
  const run = app.run;
  const i = run.levelIndex;
  const sector = run.sector;
  setScreen('gate');
  audio.duck(true);
  ui.showHUD(false);
  ui.showGate({
    rulebook: app.rulebook,
    index: i,
    sector,
    module: run.module,
    run,
    finish: (verdicts) => {
      const result = run.mech.result({ cleared: true, verdicts, timeMs: (run.gateSteps * 1000) / 120 });
      const completion = records.completionOf(sector, run.mech, result);
      const rec = records.recordLevel(sector.id, { cleared: true, timeMs: result.timeMs, completion });
      app.session.results[i] = result;
      app.session.seals[i] = rec.seal;
      const last = i === app.rulebook.sectors.length - 1;
      return {
        result,
        score: scoreSector(app.rulebook, sector, result),
        completion,
        seal: rec.seal,
        records: rec,
        nextLabel: app.session.practice ? 'Continue' : last ? 'Readiness' : `Gate ${i + 2}`,
      };
    },
    onContinue: () => {
      audio.duck(false);
      if (app.session.practice) {
        audio.stopTheme();
        setScreen('practice-end');
        ui.showPracticeEnd({ sector, cleared: true, onRetry: () => briefing(i), onTitle: toTitle });
      } else if (i < app.rulebook.sectors.length - 1) {
        briefing(i + 1);
      } else {
        finishRun('complete');
      }
    },
  });
  ui.announce(`Gate ${i + 1} reached.`);
}

function hullOut() {
  const run = app.run;
  const i = run.levelIndex;
  const result = run.mech.result({ cleared: false, verdicts: [], timeMs: run.timeMs });
  const completion = records.completionOf(run.sector, run.mech, result);
  records.recordLevel(run.sector.id, { cleared: false, timeMs: result.timeMs, completion });
  audio.stopTheme();
  ui.showHUD(false);
  if (app.session.practice) {
    setScreen('practice-end');
    ui.showPracticeEnd({ sector: run.sector, cleared: false, onRetry: () => briefing(i), onTitle: toTitle });
    return;
  }
  app.session.results[i] = result;
  app.session.seals[i] = 'none';
  setScreen('over');
  ui.showHullOut({ sectorName: run.sector.name, onContinue: () => finishRun('hull') });
}

function abandon() {
  const run = app.run;
  const i = run.levelIndex;
  app.session.results[i] = run.mech.result({ cleared: false, verdicts: [], timeMs: run.timeMs });
  app.session.seals[i] = 'none';
  finishRun('abandon');
}

// ------------------------------------------------------------ run end ----

function finishRun(reason) {
  audio.stopTheme();
  ui.showHUD(false);
  const s = app.session;
  const sectors = s.results.filter(Boolean);
  const bad = validateRun(app.rulebook, sectors);
  if (bad) {
    // The game builds results itself, so this is a bug, never a player error.
    console.error('[nova] run failed validation (bug)', bad, sectors);
  }
  const summary = bad ? null : scoreRun(app.rulebook, sectors);
  s.summary = summary;
  s.submission = bad
    ? Promise.resolve({ mode: app.mode, error: { field: bad.field, message: `internal error: ${bad.field} ${bad.message}` } })
    : api.submitRun({ callsign: s.callsign, sectors });
  s.submission.then((res) => {
    if (res.error) console.warn('[nova] submission', res.error);
  });
  if (!summary) {
    setScreen('error');
    ui.showDevError('This run could not be scored', [`${bad.field}: ${bad.message}`]);
    return;
  }
  if (reason !== 'complete') {
    debrief();
    return;
  }
  setScreen('readiness');
  audio.sfx('confirm');
  ui.showReadiness({
    rulebook: app.rulebook,
    correct: summary.correctVerdicts,
    total: app.rulebook.sectors.reduce((n, sec) => n + sec.gate.length, 0),
    level: summary.readinessLevel,
    onContinue: () => {
      if (summary.cleared) {
        setScreen('finale');
        audio.sfx('launch');
        ui.showFinale({ rulebook: app.rulebook, reducedMotion: reducedMotion(), clearance: s.submission, onDebrief: debrief });
      } else {
        setScreen('ending');
        ui.showMinimumEnding({
          rulebook: app.rulebook,
          level: summary.readinessLevel,
          allCleared: summary.sectorsCleared === app.rulebook.sectors.length,
          onFlyAgain: () => flyAgain(),
          onDebrief: debrief,
        });
      }
    },
  });
}

function debrief() {
  const s = app.session;
  setScreen('debrief');
  const sectors = s.results.filter(Boolean);
  ui.showDebrief({
    rulebook: app.rulebook,
    results: s.results,
    summary: s.summary,
    seals: s.seals,
    mode: app.mode,
    callsign: s.callsign,
    submission: s.submission,
    submit: () => {
      s.submission = api.submitRun({ callsign: s.callsign, sectors });
      return s.submission;
    },
    loadBoard: () => api.getLeaderboard(10),
    subscribe: app.mode === 'fleet' ? api.subscribeFleet : null,
    onFlyAgain: flyAgain,
    onTitle: toTitle,
  });
}

function flyAgain() {
  ui.leaveDebrief();
  const c = app.session?.callsign || loadCallsign();
  app.session = { practice: false, index: 0, results: [], seals: [], callsign: c };
  briefing(0);
}

// ---------------------------------------------------------------- loop ----

function update(dt) {
  const run = app.run;
  if (!run) return;
  if (app.screen === 'play' || app.screen === 'gate' || app.screen === 'over') {
    const inp = input.sample();
    run.step(dt, inp);
  }
}

function render(alpha, dt) {
  app.time += dt;
  input.pollGamepad();
  const run = app.run;
  if (run && app.screen !== 'briefing') {
    renderer.drawRun(run, app.screen === 'paused' ? 1 : alpha, app.time);
    if (app.screen === 'play') ui.updateHUD(run, liveIntegrity());
  } else {
    renderer.drawBackdrop(app.backdrop, app.time);
  }
  renderer.present();
}

window.addEventListener('resize', () => renderer.resize());
// The canvas also changes size when the handheld (portrait touch) layout toggles.
if (window.ResizeObserver) new ResizeObserver(() => renderer.resize()).observe(canvas);
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 120));
const unlock = () => audio.unlock();
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);
document.getElementById('hud').addEventListener('click', (e) => {
  if (e.target.closest('#hud-pause')) pause();
});

// ---------------------------------------------------------------- debug ----

if (DEBUG) {
  window.__humansi = {
    /** Positions in tiles: entity x/y is its centre; Nova's x is her centre and y her feet. */
    getState() {
      const run = app.run;
      const s = app.session;
      return {
        screen: app.screen,
        mode: app.mode,
        levelIndex: s ? s.index : null,
        practice: s ? s.practice : null,
        results: s ? JSON.parse(JSON.stringify(s.results.filter(Boolean))) : [],
        hull: run ? run.cells * HULL_PER_CELL : HULL_CELLS * HULL_PER_CELL,
        cells: run ? run.cells : HULL_CELLS,
        integrity: s && app.rulebook ? liveIntegrity() : null,
        player: run ? run.snapshot() : null,
        entities: run ? run.entitySnapshots() : [],
        gate: run ? { x: run.gate.x, y: run.gate.ground } : null,
        platforms: run ? run.lv.platforms.map((p) => ({ axis: p.axis, x: +p.x.toFixed(3), y: +p.y.toFixed(3), w: p.w })) : [],
        level: run ? { w: run.lv.w, h: run.lv.h, world: run.world, sectorId: run.sector.id, state: run.state } : null,
        timeMs: run ? run.timeMs : 0,
        secrets: run ? { found: run.secretsFound, total: run.lv.falseGroups.length } : null,
        counters: run ? { cores: run.mech.cores, chainLinks: run.mech.chainLinks, assists: run.mech.assists, harmonized: run.mech.harmonized, scans: run.mech.scans, reviews: run.mech.reviews, shortcuts: run.mech.shortcuts } : null,
        summary: s?.summary ?? null,
        timescale: engine.timescale,
        perf: engine.perf(),
        view: { w: renderer.W, h: renderer.H, scale: renderer.k },
      };
    },
    setTimescale(n) {
      engine.setTimescale(n);
    },
    teleport(x, y) {
      app.run?.teleport(x, y);
    },
  };
}

boot();
