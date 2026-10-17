// The Glass Box — page controller. Loads the cases, runs the probe → name →
// verdict loop, and scores with logic.js. Pure client side: it works as static
// files (GitHub Pages, solo mode), needs no server, and keeps a best score in
// this browser only. All text comes from glassbox.json / rulebook.json; nothing
// is rendered with innerHTML from data.

import { decidingFactor, factorById, acceptedVerdicts, scoreCase, rankFor, validateGlassbox } from './logic.js';

const url = (p) => new URL(p, document.baseURI).toString();
const BEST_KEY = 'humansi.glassbox.best.v1';

const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') throw new Error('no html from data');
    else if (k.startsWith('aria') || k === 'role' || k === 'type' || k === 'hidden') n.setAttribute(k, v);
    else if (k.startsWith('data-')) n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const kid of [].concat(kids)) if (kid != null) n.append(kid);
  return n;
};
const $ = (sel) => document.querySelector(sel);
const bind = (name) => document.querySelector(`[data-bind="${name}"]`);
const setText = (name, text) => { const n = bind(name); if (n) n.textContent = text; };
const show = (sel, on = true) => { const n = typeof sel === 'string' ? $(sel) : sel; if (n) n.hidden = !on; };

let GB = null; // glassbox.json
let RB = null; // rulebook.json (for citation labels)
let order = []; // case indices in play order
let pos = 0; // position in order
let results = []; // per-case score records
let state = null; // current case runtime state

async function getJSON(path) {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function citeLabel(id) {
  const mod = RB?.method?.modules?.find((m) => m.id === id);
  if (mod) return `${mod.gate} · ${mod.name}`;
  for (const v of RB?.charter?.values ?? []) {
    const a = v.articles.find((x) => x.id === id);
    if (a) return `${id} · ${a.title}`;
  }
  return id;
}

function readBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function writeBest(n) {
  try { if (n > readBest()) localStorage.setItem(BEST_KEY, String(n)); } catch { /* ignore */ }
}

/* ---------- Intro ---------- */
function renderIntro() {
  setText('tagline', GB.tagline);
  setText('title', GB.title);
  setText('intro', GB.intro);
  setText('disclaimer', GB.disclaimer);
  setText('disclaimerFoot', GB.disclaimer);
  const g4 = RB.method.modules.find((m) => m.id === 'M4');
  setText('g4', g4 ? g4.question : 'is the human reviewer genuinely capable of intervention?');
  const list = bind('howto');
  list.replaceChildren(...GB.howto.map((t) => el('li', { text: t })));
  show('#intro', true);
}

/* ---------- One case ---------- */
function startCase() {
  const caseDef = GB.cases[order[pos]];
  state = { caseDef, revealed: new Set(), named: null, decided: false };

  show('#intro', false);
  show('#debrief', false);
  show('#case', true);

  setText('caseIndex', String(pos + 1));
  setText('caseTotal', String(order.length));
  setText('system', caseDef.system);
  setText('decision', caseDef.decision);
  setText('subject', caseDef.subject);
  setText('briefing', caseDef.briefing);
  setText('probeBudget', String(caseDef.probeBudget));
  updateMeter();

  show(bind('verdicts'), false);
  show(bind('feedback'), false);
  show($('[data-action="next"]'), false);
  show($('[data-action="restart"]'), false);
  renderFactors();
  renderVerdictButtons();
  setPhaseHint();
  $('#case').scrollIntoView({ block: 'start', behavior: 'smooth' });
  bind('decision').focus?.();
}

function probesUsed() { return state.revealed.size; }
function probesLeft() { return state.caseDef.probeBudget - probesUsed(); }

function updateMeter() {
  setText('probesLeft', String(Math.max(0, probesLeft())));
  const total = results.reduce((a, r) => a + r.insight, 0);
  setText('insight', String(total));
}

function setPhaseHint() {
  if (state.decided) { setText('phaseHint', 'The full picture is revealed below.'); return; }
  if (!state.named) {
    setText('phaseHint', probesLeft() > 0
      ? 'Probe the factors to see how much each one moved the decision. Then name the one that tipped it.'
      : 'Out of probes. Name the deciding factor from what you have seen.');
  } else {
    setText('phaseHint', 'Deciding factor named. Give your verdict.');
  }
}

function renderFactors() {
  const list = bind('factors');
  list.replaceChildren(...state.caseDef.factors.map((f) => factorNode(f)));
}

function factorNode(f) {
  const caseDef = state.caseDef;
  const revealed = state.revealed.has(f.id) || state.decided;
  const isNamed = state.named === f.id;
  const classes = ['factor'];
  if (revealed) classes.push('is-revealed');
  if (f.opaque && revealed) classes.push('is-opaque');
  if (isNamed) classes.push('is-named');

  const tag = !revealed ? 'Probe' : f.opaque ? '■ Sealed' : isNamed ? '◆ Named' : '✓ Inspected';
  const head = el('button', {
    class: 'factor__btn',
    type: 'button',
    'aria-expanded': revealed ? 'true' : 'false',
  }, [el('span', { class: 'factor__name', text: f.label }), el('span', { class: 'factor__tag', text: tag })]);

  if (!revealed) {
    head.addEventListener('click', () => probe(f.id));
    return el('li', { class: classes.join(' ') }, head);
  }

  const body = el('div', { class: 'factor__body' });
  body.append(el('p', { class: 'factor__detail', text: f.detail }));
  if (f.opaque) {
    const bar = el('div', { class: 'bar' }, el('div', { class: 'bar__fill opaque' }));
    body.append(bar, el('p', { class: 'factor__influence', text: 'Influence: not inspectable' }));
  } else {
    const mag = Math.min(50, Math.abs(f.influence) / 2); // half-width %, capped
    const fill = el('div', { class: `bar__fill ${f.influence >= 0 ? 'for' : 'against'}` });
    fill.style.width = `${mag}%`;
    body.append(el('div', { class: 'bar' }, fill));
    body.append(el('p', { class: 'factor__influence', text: `Influence on the decision: ${f.influence > 0 ? '+' : ''}${f.influence}` }));
  }
  if (f.proxyFor && (state.decided || state.revealed.has(f.id))) {
    body.append(el('p', { class: 'factor__proxy', text: `⚠ Proxy for ${f.proxyFor}.` }));
  }
  if (!state.decided) {
    const nameBtn = el('button', {
      class: 'factor__name-btn',
      type: 'button',
      text: isNamed ? 'Named as deciding factor' : 'Name as deciding factor',
    });
    nameBtn.disabled = isNamed;
    nameBtn.addEventListener('click', () => nameFactor(f.id));
    body.append(nameBtn);
  } else if (f.id === decidingFactor(caseDef)) {
    body.append(el('p', { class: 'factor__proxy', text: '◆ This is the factor that actually tipped the decision.' }));
  }
  return el('li', { class: classes.join(' ') }, [head, body]);
}

function probe(id) {
  if (state.decided) return;
  if (!state.revealed.has(id) && probesLeft() <= 0) return;
  state.revealed.add(id);
  updateMeter();
  renderFactors();
  setPhaseHint();
}

function nameFactor(id) {
  if (state.decided) return;
  state.named = id;
  renderFactors();
  show(bind('verdicts'), true);
  setPhaseHint();
  bind('verdicts').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderVerdictButtons() {
  const row = bind('verdicts').querySelector('.verdicts__row');
  row.replaceChildren(...GB.verdicts.map((v) => {
    const b = el('button', { class: 'verdict-btn', type: 'button', text: v.label, title: v.meaning });
    b.setAttribute('data-v', v.id);
    b.addEventListener('click', () => decide(v.id));
    return b;
  }));
}

function decide(verdict) {
  if (state.decided || !state.named) return;
  state.decided = true;
  const caseDef = state.caseDef;
  const res = scoreCase(GB, caseDef, { namedFactor: state.named, verdict, probesUsed: probesUsed() });
  results[pos] = {
    caseId: caseDef.id,
    system: caseDef.system,
    factorCorrect: res.factorCorrect,
    verdictCorrect: res.verdictCorrect,
    insight: res.insight,
    namedLabel: factorById(caseDef, state.named)?.label ?? '—',
    verdict,
  };
  // Lock verdict buttons and reveal everything.
  bind('verdicts').querySelectorAll('.verdict-btn').forEach((b) => { b.disabled = true; });
  renderFactors();
  updateMeter();
  setPhaseHint();
  renderFeedback(res, verdict);
  const next = $('[data-action="next"]');
  next.textContent = pos + 1 < order.length ? 'Next case →' : 'See debrief →';
  show(next, true);
  show($('[data-action="restart"]'), true);
  next.focus();
}

function renderFeedback(res, verdict) {
  const caseDef = state.caseDef;
  const box = bind('feedback');
  box.className = 'feedback ' + (res.solved ? 'is-right' : res.verdictCorrect ? 'is-part' : 'is-wrong');
  const correctV = GB.verdicts.find((v) => v.id === caseDef.correct).label;
  let title;
  if (res.solved) title = `Right factor, right call (+${res.insight} insight).`;
  else if (res.verdictCorrect) title = `Right call, but not for the reason that decided it (+${res.insight}).`;
  else title = `Not defensible. The call here is ${correctV}.`;

  box.replaceChildren(
    el('p', { class: 'feedback__title', text: title }),
    el('p', { class: 'feedback__explain', text: caseDef.explain }),
    el('div', { class: 'feedback__cites' }, caseDef.cites.map((c) => el('span', { class: 'cite', text: citeLabel(c) }))),
  );
  show(box, true);
}

/* ---------- Navigation ---------- */
function next() {
  if (pos + 1 < order.length) { pos += 1; startCase(); }
  else renderDebrief();
}

function renderDebrief() {
  show('#case', false);
  show('#debrief', true);
  const total = results.reduce((a, r) => a + r.insight, 0);
  const solved = results.filter((r) => r.factorCorrect && r.verdictCorrect).length;
  const rank = rankFor(GB, total);
  setText('debriefTitle', `${solved} of ${order.length} boxes fully opened · ${total} insight`);
  setText('debriefRank', `Rank: ${rank.name}. The point was never the score — it was whether you could say why.`);
  const rows = bind('debriefRows');
  rows.replaceChildren(...results.map((r) => el('tr', {}, [
    el('td', { text: r.system }),
    cell(r.factorCorrect, r.namedLabel),
    cell(r.verdictCorrect, r.verdict.toUpperCase()),
    el('td', { text: String(r.insight) }),
  ])));
  writeBest(total);
  setText('debriefBest', `Best on this device: ${readBest()} insight.`);
  $('#debrief').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function cell(ok, label) {
  const td = el('td', { text: label });
  td.classList.add(ok ? 'cell-right' : 'cell-wrong');
  td.prepend(document.createTextNode(ok ? '✓ ' : '✗ '));
  return td;
}

function restartRun() {
  // Shuffle the case order so replays open the boxes in a different sequence.
  order = GB.cases.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  results = [];
  pos = 0;
  startCase();
}

function wire() {
  $('[data-action="start"]').addEventListener('click', restartRun);
  $('[data-action="again"]').addEventListener('click', restartRun);
  $('[data-action="next"]').addEventListener('click', next);
  $('[data-action="restart"]').addEventListener('click', () => startCase());
}

async function boot() {
  try {
    [GB, RB] = await Promise.all([getJSON('data/glassbox.json'), getJSON('data/rulebook.json')]);
  } catch (e) {
    const n = $('#loaderror');
    n.textContent = 'Could not load the Glass Box data. Try reloading.';
    show(n, true);
    return;
  }
  const bad = validateGlassbox(GB);
  if (bad) {
    const n = $('#loaderror');
    n.textContent = `The Glass Box data has a problem (${bad.caseId}: ${bad.message}).`;
    show(n, true);
    return;
  }
  renderIntro();
  wire();

  // Debug hook for automated checks, mirroring the game's convention.
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === '1') {
    window.__glassbox = {
      getState: () => ({
        screen: !$('#intro').hidden ? 'intro' : !$('#case').hidden ? 'case' : 'debrief',
        pos,
        order: [...order],
        caseId: state?.caseDef.id,
        revealed: state ? [...state.revealed] : [],
        named: state?.named ?? null,
        decided: state?.decided ?? false,
        probesLeft: state ? probesLeft() : null,
        results: results.map((r) => ({ ...r })),
        total: results.reduce((a, r) => a + r.insight, 0),
      }),
      deciding: () => (state ? decidingFactor(state.caseDef) : null),
    };
  }
}

boot();
