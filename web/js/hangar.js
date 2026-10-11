// Model Hangar: the catalog of open models, sealed until the pilot earns
// launch clearance, and the SI console that talks to one of them.
//
// Every Rule Book and catalog word comes from rulebook.json and models.json
// (through api.js, which also decides fleet vs solo) and goes into the page
// as text nodes, never innerHTML. Model output is treated the same way, as
// untrusted text: it is appended to a Text node, so markup in an answer
// shows up as characters and can never become elements.
//
// The console practises what the Rule Book preaches: every SI message is
// labelled as SI, Stop (the human override) aborts the request so the
// server cancels generation too, and only a short conversation is kept, in
// memory, in this tab.

import { connect, getRulebook, getModels, getClearance, copilotStatus, askCopilot } from './api.js';

// The server's limits for POST /api/copilot (docs/ARCHITECTURE.md): 1–12
// messages, each 1–2000 characters (code points), the last from the pilot.
const MAX_HISTORY = 12;
const MAX_CHARS = 2000;

const STARTERS = [
  'Which gate decides whether oversight is real?',
  'Explain the minimum rule',
  'Walk me through Gate 3 for a school chatbot',
];

const OPENNESS = { 'fully-open': 'Fully open', 'open-weights': 'Open weights' };
const LICENCE_KIND = { osi: 'OSI', custom: 'Custom', mixed: 'Mixed' };

// Per-tab convenience only: the door opens with ceremony once per visit,
// not on every reload. Losing it (private mode, blocked storage) just means
// the door opens again.
const OPENED_KEY = 'humansi.hangar.opened.v1';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ dom --

/** Tiny element builder. Text always goes in as text nodes. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** Runtime steps mark commands with backticks; render those as <code>, the rest as text. */
function withCode(text) {
  return String(text).split('`').map((part, i) => (i % 2 ? h('code', { text: part }) : part));
}

function announce(text) {
  const el = $('announce');
  // Clear first so the same words twice in a row are still read out.
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = text; });
}

function onMediaChange(mq, fn) {
  if (mq.addEventListener) mq.addEventListener('change', fn);
  else mq.addListener(fn); // Safari < 14
}

/** Clip to the server's per-message limit, counting code points as the server does. */
function clip(text) {
  const cps = Array.from(text);
  return cps.length > MAX_CHARS ? cps.slice(0, MAX_CHARS).join('') : text;
}

/** "qwen2.5:0.5b" → "qwen2.5": the server matches installed tags on the name before ':'. */
const baseTag = (tag) => String(tag).split(':')[0];

function safeHttps(href) {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- the door --

function setStatus(clearance) {
  const el = $('bay-status');
  const text = $('bay-status-text');
  if (!clearance) {
    el.dataset.tone = 'locked';
    text.textContent = 'Sealed';
    return;
  }
  el.dataset.tone = 'open';
  const who = typeof clearance.callsign === 'string' ? clearance.callsign.slice(0, 24) : '';
  let detail = 'solo record on this device';
  if (clearance.kind === 'fleet') {
    const d = new Date(clearance.expiresAt);
    detail = Number.isNaN(d.getTime())
      ? 'fleet clearance'
      : `fleet clearance until ${d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  text.textContent = ['Clearance granted', who, detail].filter(Boolean).join(' · ');
}

function setDoor(clearance, dust) {
  const bay = $('bay');
  if (!clearance) {
    bay.dataset.state = 'locked';
    dust.refresh();
    return;
  }
  let seen = false;
  try { seen = sessionStorage.getItem(OPENED_KEY) === '1'; } catch { /* storage blocked */ }
  if (seen || reduceMotion.matches) {
    bay.dataset.state = 'open';
    dust.refresh();
    return;
  }
  try { sessionStorage.setItem(OPENED_KEY, '1'); } catch { /* storage blocked */ }
  // Two frames: the closed door has to be painted once, or there is nothing
  // to transition from and the bay would simply appear open.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bay.dataset.state = 'opening';
    dust.refresh();
    // The longest transition ends at ~2.7 s; settle on the end state after it.
    setTimeout(() => { if (bay.dataset.state === 'opening') bay.dataset.state = 'open'; }, 3000);
  }));
}

/**
 * Dust drifting through the light of the bay. Decoration only: it pauses
 * when the scene is off screen or the tab is hidden, and with reduced motion
 * it is a single still frame.
 */
function startDust() {
  const canvas = $('dust');
  const bay = $('bay');
  const ctx = canvas.getContext && canvas.getContext('2d');
  const noop = { refresh() {} };
  if (!ctx) return noop;

  let w = 0;
  let hgt = 0;
  let motes = [];
  let raf = 0;
  let last = 0;
  let onScreen = true;
  let light = 0.3;

  const target = () => (bay.dataset.state === 'open' || bay.dataset.state === 'opening' ? 1 : 0.3);

  function seed() {
    const n = Math.round(Math.min(90, Math.max(28, w / 14)));
    motes = Array.from({ length: n }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.4 + Math.random() * 1.2,
      v: 0.006 + Math.random() * 0.014,
      p: Math.random() * Math.PI * 2,
      a: 0.25 + Math.random() * 0.6,
    }));
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = r.width;
    hgt = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(hgt * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    if (!raf) draw(0, true);
  }

  function draw(dt, still) {
    const goal = target();
    // The light follows the door: it fades up as the leaves part.
    light = still ? goal : light + (goal - light) * Math.min(1, dt * 0.9);
    ctx.clearRect(0, 0, w, hgt);
    for (const m of motes) {
      m.y -= m.v * dt;
      m.p += dt * 0.5;
      if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); }
      // Brightest in the shaft of light in front of the door.
      const dx = (m.x - 0.5) / 0.24;
      const beam = Math.exp(-dx * dx);
      const alpha = m.a * (0.12 + 0.88 * beam) * light;
      if (alpha < 0.01) continue;
      ctx.fillStyle = `rgba(205, 242, 255, ${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc((m.x + Math.sin(m.p) * 0.006) * w, m.y * hgt, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function frame(t) {
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
    last = t;
    draw(dt, false);
    raf = requestAnimationFrame(frame);
  }

  function run() {
    const go = onScreen && !document.hidden && !reduceMotion.matches;
    if (go && !raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    } else if (!go && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (!go) draw(0, true);
  }

  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize', resize);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      run();
    }).observe(canvas);
  }
  document.addEventListener('visibilitychange', run);
  onMediaChange(reduceMotion, run);
  resize();
  run();
  return { refresh() { if (!raf) draw(0, true); } };
}

// ------------------------------------------------------------- frame --

function frame(rb, catalog) {
  if (typeof rb.ship === 'string' && rb.ship) $('ship-line').textContent = `${rb.ship} · Hangar bay`;
  if (typeof catalog.title === 'string' && catalog.title) {
    $('hangar-title').textContent = catalog.title;
    document.title = `${catalog.title} · ${rb.title}`;
  }
  const intro = $('intro');
  intro.textContent = catalog.intro;
  intro.hidden = !catalog.intro;
  const disclaimer = $('disclaimer');
  disclaimer.textContent = rb.disclaimer;
  disclaimer.hidden = !rb.disclaimer;
  $('footer-mark').textContent = [rb.title, rb.ship].filter(Boolean).join(' · ');
  $('console-eyebrow').textContent = rb.ship || 'Console';
}

function renderLocked(rb, catalog) {
  const gates = String(rb.method?.name ?? 'the Six Gates').replace(/^The /, 'the ');
  const level = rb.method?.minimumRule?.level;
  $('unlock-rule').textContent =
    `Clear ${gates} at readiness Level ${level} or above to earn launch clearance and open the hangar.`;
  $('locked').hidden = false;

  $('manifest-list').replaceChildren(...catalog.models.map((m) => h('li', {},
    h('span', { class: 'manifest__name', text: m.name }),
    h('span', { class: 'manifest__pub', text: m.publisher }),
  )));
  $('manifest').hidden = false;
}

// ------------------------------------------------------------- catalog --

const copyTimers = new WeakMap();

async function copyCommand(text, code, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* permission refused: fall through */ }
  if (!ok) {
    // Older or insecure contexts: select the command (the "$" prompt is a
    // pseudo-element, so it is not part of the selection) and try the
    // legacy copy. If even that is refused, the selection stays for the
    // pilot to copy by hand.
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(code);
    sel.removeAllRanges();
    sel.addRange(range);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    if (ok) sel.removeAllRanges();
  }
  btn.textContent = ok ? 'Copied' : 'Selected';
  btn.dataset.state = ok ? 'copied' : 'selected';
  announce(ok ? `Copied: ${text}` : `Selected: ${text}. Press Control C, or Command C, to copy it.`);
  clearTimeout(copyTimers.get(btn));
  copyTimers.set(btn, setTimeout(() => {
    btn.textContent = 'Copy';
    delete btn.dataset.state;
  }, 2400));
}

function command(text) {
  const code = h('code', { class: 'cmd__text', text });
  const btn = h('button', { type: 'button', class: 'cmd__copy', 'aria-label': `Copy: ${text}`, text: 'Copy' });
  btn.addEventListener('click', () => copyCommand(text, code, btn));
  return h('div', { class: 'cmd' }, code, btn);
}

function sourceLink(m) {
  const u = safeHttps(m.source);
  if (!u) return null;
  const shown = (u.host + u.pathname).replace(/\/$/, '');
  return h('a', { class: 'card__source', href: u.href, target: '_blank', rel: 'noopener noreferrer' },
    shown,
    h('span', { class: 'visually-hidden', text: ` (source for ${m.name}, opens in a new tab)` }),
    h('span', { 'aria-hidden': 'true', text: ' ↗' }),
  );
}

function card(m) {
  return h('li', { class: 'card', 'data-openness': m.openness, 'data-tag': m.ollama },
    h('div', { class: 'card__head' },
      h('h3', { class: 'card__name', text: m.name }),
      h('span', { class: 'badge', text: OPENNESS[m.openness] ?? m.openness }),
    ),
    h('p', { class: 'card__publisher', text: m.publisher }),
    h('p', { class: 'card__licence' },
      h('span', { class: 'card__key', text: 'Licence' }),
      m.licence,
      h('span', { class: 'visually-hidden', text: ', licence kind:' }),
      h('span', { class: 'kind', 'data-kind': m.licenceKind, text: LICENCE_KIND[m.licenceKind] ?? m.licenceKind }),
    ),
    h('p', { class: 'card__note', text: m.note }),
    command(`ollama pull ${m.ollama}`),
    h('div', { class: 'card__foot' },
      sourceLink(m),
      h('span', { class: 'card__installed', hidden: true, text: 'Installed on this server' }),
    ),
  );
}

function renderCatalog(catalog) {
  $('cards').replaceChildren(...catalog.models.map(card));
  $('caveat').textContent = catalog.caveat;
  $('caveat').hidden = !catalog.caveat;
  $('catalog').hidden = false;
  $('jump').hidden = false;
}

/** Mark the cards whose model the fleet server actually has installed (real data from /api/copilot/status). */
function markInstalled(tags) {
  const bases = new Set(tags.map(baseTag));
  for (const el of document.querySelectorAll('.card[data-tag]')) {
    el.querySelector('.card__installed').hidden = !bases.has(el.dataset.tag);
  }
}

// ------------------------------------------------------------- console --

const chat = {
  catalog: null,
  runtime: null,
  els: null,          // the ready-state elements, while the console is ready
  history: [],        // [{ role, content, el }] — what the next request sends as context
  controller: null,   // AbortController of the answer in flight
  streaming: false,
  pinned: true,       // follow new tokens unless the pilot scrolled up to read
  model: null,        // last picked tag, kept across a model-list refresh
};

function modeBadge(mode) {
  const badge = $('mode-badge');
  badge.dataset.mode = mode;
  badge.querySelector('.mode__text').textContent = mode === 'fleet' ? 'Fleet server' : 'Solo mode';
}

function hangarName(tag) {
  const m = chat.catalog.models.find((x) => x.ollama === baseTag(tag));
  return m ? m.name : null;
}

function runtimeSteps() {
  const rt = chat.runtime;
  if (!rt || !Array.isArray(rt.steps)) return null;
  const link = safeHttps(rt.url);
  return [
    h('h4', { class: 'label label--sub', text: 'Run it yourself' }),
    h('ol', { class: 'steps' }, rt.steps.map((s) => h('li', {}, withCode(s)))),
    link ? h('a', { class: 'runtime-link', href: link.href, target: '_blank', rel: 'noopener noreferrer' },
      `${rt.name} · ${link.host}`,
      h('span', { class: 'visually-hidden', text: ' (opens in a new tab)' }),
      h('span', { 'aria-hidden': 'true', text: ' ↗' })) : null,
  ];
}

function checkAgainButton() {
  const b = h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: 'Check again' });
  b.addEventListener('click', () => initConsole({ focus: true }));
  return h('div', { class: 'actions' }, b);
}

function showConsole(node, { focus = false } = {}) {
  chat.els = null;
  $('console-body').replaceChildren(node);
  if (focus) {
    const heading = node.querySelector('h3');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }
}

const REASONS = {
  not_configured: 'This fleet server has no model runtime configured, so the console is off.',
  unreachable: 'The model server is not reachable right now.',
};

const consoleViews = {
  checking: () => h('p', { class: 'console__checking', role: 'status', text: 'Checking the console…' }),

  solo: () => h('div', { class: 'console__state' },
    h('h3', { text: 'Solo mode: no model connected' }),
    h('p', { text: 'The SI console runs on the fleet server, which relays it to an open-source model on your own machine through Ollama. This copy of the site is static files, so there is no server and no model here.' }),
    runtimeSteps(),
  ),

  off: ({ reason }) => h('div', { class: 'console__state' },
    h('h3', { text: 'No open-source model connected' }),
    h('p', { text: REASONS[reason] ?? 'The console status could not be read.' }),
    runtimeSteps(),
    checkAgainButton(),
  ),

  noModels: () => h('div', { class: 'console__state' },
    h('h3', { text: 'No hangar model installed' }),
    h('p', { text: 'Ollama is reachable, but none of the hangar models is installed on it. Pull one, then check again.' }),
    h('ul', { class: 'cmds' }, chat.catalog.models.map((m) => h('li', {}, command(`ollama pull ${m.ollama}`)))),
    checkAgainButton(),
  ),

  needsFleet: () => h('div', { class: 'console__state' },
    h('h3', { text: 'Fleet clearance needed' }),
    h('p', { text: 'Your clearance is a solo record kept on this device. The console needs launch clearance signed by this fleet server: fly the Six Gates here to earn it.' }),
    h('div', { class: 'actions' }, h('a', { class: 'btn btn--primary', href: 'play.html', text: 'Play Nova Run' })),
  ),
};

let consoleRun = 0;

async function initConsole({ focus = false } = {}) {
  const run = ++consoleRun;
  stopAnswer(); // a rebuilt console must not leave an answer streaming into nowhere
  showConsole(consoleViews.checking());
  const { mode } = await connect();
  if (run !== consoleRun) return;
  modeBadge(mode);
  if (mode !== 'fleet') return showConsole(consoleViews.solo(), { focus });

  let status;
  try {
    status = await copilotStatus();
  } catch {
    status = { available: false, models: [], reason: 'unreachable' };
  }
  if (run !== consoleRun) return; // a newer check superseded this one
  const models = Array.isArray(status.models) ? status.models.filter((t) => typeof t === 'string' && hangarName(t)) : [];
  markInstalled(models);

  if (!status.available || models.length === 0) {
    if (status.reason === 'no_hangar_model' || (status.available && models.length === 0)) {
      return showConsole(consoleViews.noModels(), { focus });
    }
    return showConsole(consoleViews.off({ reason: status.reason }), { focus });
  }
  const c = getClearance();
  if (!c || c.kind !== 'fleet' || !c.token) return showConsole(consoleViews.needsFleet(), { focus });
  renderChat(models, { focus });
}

// ------------------------------------------------------------- chat --

function setChatState(tone, text) {
  const el = chat.els?.state;
  if (!el) return;
  el.dataset.tone = tone;
  el.querySelector('.chat__state-text').textContent = text;
}

function emptyState() {
  return h('div', { class: 'chat__empty' },
    h('p', { class: 'chat__hint', text: 'Ask about the Charter or the Six Gates, or start with one of these:' }),
    h('div', { class: 'starters' }, STARTERS.map((s) => {
      const b = h('button', { type: 'button', class: 'starter', text: s });
      b.addEventListener('click', () => ask(s));
      return b;
    })),
  );
}

function modelOptions(select, models) {
  const keep = chat.model && models.includes(chat.model) ? chat.model : models[0];
  select.replaceChildren(...models.map((tag) => h('option', { value: tag, text: `${hangarName(tag)} · ${tag}` })));
  select.value = keep;
  chat.model = keep;
}

function renderChat(models, { focus = false } = {}) {
  const select = h('select', { class: 'select', id: 'si-model' });
  modelOptions(select, models);
  select.addEventListener('change', () => { chat.model = select.value; });

  const state = h('p', { class: 'chat__state', role: 'status', 'data-tone': 'ready' },
    h('span', { class: 'chat__dot', 'aria-hidden': 'true' }),
    h('span', { class: 'chat__state-text', text: 'Ready' }),
  );

  // The log announces finished turns; aria-busy holds it quiet while tokens stream in.
  const log = h('div', { class: 'chat__log', id: 'si-log', role: 'log', 'aria-label': 'Console transcript', 'aria-busy': 'false', tabindex: '0' });
  log.addEventListener('scroll', () => {
    chat.pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  });

  const input = h('textarea', {
    id: 'si-prompt', rows: '3', maxlength: String(MAX_CHARS),
    placeholder: 'Ask about a gate, an article or a use case', autocomplete: 'off',
  });
  const send = h('button', { type: 'submit', class: 'btn btn--primary', text: 'Send' });
  const stop = h('button', { type: 'button', class: 'btn btn--stop', disabled: true, text: 'Stop' });
  const clear = h('button', { type: 'button', class: 'btn btn--quiet', text: 'New conversation' });
  const form = h('form', { class: 'composer', 'aria-label': 'Ask the SI console' },
    h('label', { class: 'visually-hidden', for: 'si-prompt', text: 'Your question for the SI console' }),
    input,
    h('div', { class: 'composer__row' }, clear, h('div', { class: 'composer__go' }, send, stop)),
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value;
    if (!text.trim() || chat.streaming) return;
    input.value = '';
    ask(text);
  });
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter is a new line; never mid-composition (IME).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  stop.addEventListener('click', stopAnswer);
  clear.addEventListener('click', () => {
    if (chat.streaming) return;
    chat.history = [];
    log.replaceChildren(emptyState());
    setChatState('ready', 'Ready');
    input.focus();
  });

  const root = h('div', { class: 'chat' },
    h('div', { class: 'chat__bar' },
      h('div', { class: 'chat__pick' }, h('label', { for: 'si-model', text: 'Model' }), select),
      state,
    ),
    log,
    form,
    h('p', { class: 'chat__fine', text: 'Stop, or Esc while an answer streams, is the human override: it ends the answer on the server as well. Only the last 12 messages are sent as context, and they live in this tab alone; dimmed ones have dropped out. The server logs the model, duration and token count, never the text.' }),
  );

  // Rebuilding the console (after "Check again") keeps the conversation.
  if (chat.history.length) {
    for (const m of chat.history) log.append(m.el);
  } else {
    log.append(emptyState());
  }

  showConsole(root);
  chat.els = { root, select, state, log, input, send, stop, clear, form };
  if (focus) input.focus();
}

function pilotMessage(text) {
  return h('div', { class: 'msg msg--pilot' },
    h('p', { class: 'msg__label', text: 'Pilot' }),
    h('p', { class: 'msg__text', text }),
  );
}

function siMessage(model) {
  const text = document.createTextNode('');
  const body = h('p', { class: 'msg__text' });
  body.append(text);
  const el = h('article', { class: 'msg msg--si is-streaming' },
    h('p', { class: 'msg__label', text: `SI-generated · ${model} · orientation, not legal advice` }),
    body,
  );
  return { el, text };
}

function note(text) {
  return h('p', { class: 'msg__note', text });
}

function scrollLog(force = false) {
  const log = chat.els?.log;
  if (!log) return;
  if (force) chat.pinned = true;
  if (chat.pinned) log.scrollTop = log.scrollHeight;
}

function setStreaming(on, model) {
  const els = chat.els;
  const had = document.activeElement;
  chat.streaming = on;
  els.send.disabled = on;
  els.stop.disabled = !on;
  els.select.disabled = on;
  els.clear.disabled = on;
  els.log.setAttribute('aria-busy', on ? 'true' : 'false');
  if (on) {
    setChatState('streaming', `Answering · ${model}`);
    // Whatever started the answer may just have been disabled or removed:
    // put the pilot's hand on the override instead of dropping focus.
    if (had === els.send || !els.root.contains(had)) els.stop.focus();
  } else if (had === els.stop || had === document.body) {
    els.input.focus();
  }
}

function stopAnswer() {
  if (chat.controller) chat.controller.abort();
}

/** Commit a finished exchange to the context, dropping (and dimming) the oldest beyond 12. */
function commit(userMsg, answer, siEl) {
  const all = [...chat.history, userMsg, { role: 'assistant', content: clip(answer), el: siEl }];
  const kept = all.slice(-MAX_HISTORY);
  for (const m of all.slice(0, all.length - kept.length)) m.el?.classList.add('is-forgotten');
  chat.history = kept;
}

async function ask(raw) {
  const els = chat.els;
  const text = clip(String(raw).trim());
  if (!els || !text || chat.streaming) return;
  const model = els.select.value;
  if (!model) return;

  els.log.querySelector('.chat__empty')?.remove();
  const userEl = pilotMessage(text);
  els.log.append(userEl);
  const userMsg = { role: 'user', content: text, el: userEl };
  const outgoing = [...chat.history, userMsg].slice(-MAX_HISTORY);
  const si = siMessage(model);
  els.log.append(si.el);
  scrollLog(true);

  const controller = new AbortController();
  chat.controller = controller;
  setStreaming(true, model);

  let answer = '';
  let result;
  try {
    result = await askCopilot({
      model,
      messages: outgoing.map(({ role, content }) => ({ role, content })),
      signal: controller.signal,
      onToken: (t) => {
        if (typeof t !== 'string' || !t) return;
        answer += t;
        si.text.appendData(t);
        scrollLog();
      },
    });
  } catch {
    result = controller.signal.aborted
      ? { ok: false, error: 'stopped', message: 'Stopped by the pilot.' }
      : { ok: false, error: 'network', message: 'The console could not reach the server.' };
  }
  // The console may have been rebuilt meanwhile; only touch it if it is still ours.
  if (chat.controller === controller) chat.controller = null;
  si.el.classList.remove('is-streaming');
  if (chat.els !== els) {
    chat.streaming = false;
    return;
  }
  setStreaming(false);

  const said = answer.trim().length > 0;
  if (result.ok) {
    if (said) {
      commit(userMsg, answer, si.el);
    } else {
      si.el.append(note('The model returned no text.'));
      userEl.classList.add('is-forgotten');
    }
    setChatState('ready', 'Ready');
    announce('Answer complete.');
  } else if (result.error === 'stopped') {
    si.el.classList.add('is-stopped');
    si.el.append(note('Stopped by the pilot · human override'));
    if (said) commit(userMsg, answer, si.el);
    else userEl.classList.add('is-forgotten');
    setChatState('stopped', 'Stopped by the pilot');
    announce('Answer stopped.');
  } else {
    if (said) {
      si.el.append(note('Interrupted'));
      commit(userMsg, answer, si.el);
    } else {
      si.el.remove();
      userEl.classList.add('is-forgotten');
    }
    showError(result);
  }
  scrollLog();
}

function showError(r) {
  const els = chat.els;
  const noClearance = r.error === 'no_clearance';
  const actions = [];
  if (noClearance) {
    actions.push(h('a', { class: 'btn btn--primary btn--small', href: 'play.html', text: 'Fly the Six Gates again' }));
  } else if (r.error === 'copilot_offline' || r.error === 'network' || r.error === 'unknown_model') {
    const b = h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: 'Check the console again' });
    b.addEventListener('click', () => initConsole({ focus: true }));
    actions.push(b);
  }
  els.log.append(h('div', { class: 'msg msg--error', role: 'alert' },
    h('p', { class: 'msg__label', text: noClearance ? 'No valid clearance' : 'Console error' }),
    h('p', { class: 'msg__text', text: r.message || 'The console stopped with an error.' }),
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  ));
  if (noClearance) {
    // The server refused the token (expired, or signed by an earlier server
    // run). Nothing will work until the pilot flies again, so say so and
    // lock the composer rather than let them type into a dead line.
    setChatState('error', 'Clearance expired or invalid');
    els.input.disabled = true;
    els.send.disabled = true;
    els.select.disabled = true;
    els.input.placeholder = 'Fly the Six Gates again to renew your clearance';
  } else {
    setChatState('error', 'Error');
  }
}

// Esc anywhere is the override while an answer streams.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chat.streaming) {
    e.preventDefault();
    stopAnswer();
  }
});

// ------------------------------------------------------------- boot --

async function main() {
  const clearance = getClearance();
  const dust = startDust();
  setStatus(clearance);
  setDoor(clearance, dust);

  let rb;
  let catalog;
  try {
    [rb, catalog] = await Promise.all([getRulebook(), getModels()]);
  } catch {
    const err = $('load-error');
    err.textContent = 'The hangar data could not be loaded. Reload the page to try again.';
    err.hidden = false;
    return;
  }

  frame(rb, catalog);
  chat.catalog = catalog;
  chat.runtime = catalog.runtime;

  if (!clearance) {
    renderLocked(rb, catalog);
    return;
  }
  renderCatalog(catalog);
  $('console').hidden = false;
  initConsole();
}

main();
