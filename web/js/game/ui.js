// DOM overlays: title, briefing, HUD, pause, gate, readiness, finale, the
// minimum-rule ending and the debrief. Every Rule Book sentence shown here is
// read from rulebook.json at runtime; the strings in this file are short UI
// chrome only. Overlays are dialogs with focus management and full keyboard
// support (and gamepad navigation through input.js).

import { formatTime, levelRecord, reached } from './records.js';
import { correctVerdicts } from '../scoring.js';
import { HULL_CELLS } from './game.js';
import { novaPortrait } from './sprites.js';

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Split "PASS: text" into its verdict label and the rest. */
export function splitOption(text) {
  const m = /^(PASS|REVISE|STOP):\s*(.*)$/s.exec(text);
  return m ? { label: m[1], rest: m[2] } : { label: '', rest: text };
}

/** Find the Rule Book text behind a citation id (module, article or integrity rule). */
export function lookupCite(rulebook, id) {
  const mod = rulebook.method.modules.find((m) => m.id === id);
  if (mod) return { id, title: mod.name, text: mod.question, extra: mod.anchor, color: mod.color };
  for (const v of rulebook.charter.values) {
    const a = v.articles.find((x) => x.id === id);
    if (a) return { id, title: `${a.title}`, text: a.text, extra: v.name, color: v.color };
  }
  const r = rulebook.method.integrity.find((x) => x.id === id);
  if (r) return { id, title: r.title, text: r.text, extra: '' };
  return { id, title: id, text: '', extra: '' };
}

export function portrait(src, monogram, label, drawn) {
  const wrap = h('div', { class: 'portrait', 'data-mono': monogram, role: 'img', 'aria-label': label });
  const img = h('img', { src, alt: '', width: 96, height: 96, decoding: 'async' });
  // Missing art falls back to a drawn stand-in: the pixel sprite, or a monogram.
  const fail = () => {
    img.remove();
    wrap.classList.add('portrait--mono');
    if (drawn) {
      const c = h('canvas', { class: 'portrait-sprite', width: 32, height: 32, 'aria-hidden': 'true' });
      c.getContext('2d').drawImage(drawn(), 0, 0);
      wrap.append(c);
    } else wrap.append(h('span', { class: 'portrait-mono', 'aria-hidden': 'true', text: monogram }));
  };
  img.addEventListener('error', fail, { once: true });
  wrap.append(img);
  return wrap;
}

export class UI {
  constructor({ input, audio }) {
    this.input = input;
    this.audio = audio;
    this.root = document.getElementById('overlay');
    this.hud = document.getElementById('hud');
    this.live = document.getElementById('live');
    this.touch = document.getElementById('touch');
    this.keyHandler = null;
    this.current = null;
    this.hudCache = {};
    this.buildHUD();
    this.buildTouch();
    input.padMenu = (a) => this.padNav(a);
    // Enter is also the pulse key: a held key's auto-repeat must never click
    // through a gate answer or a briefing the pilot has not read.
    this.root.addEventListener('keydown', (e) => {
      if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
    }, true);
    audio.onMuteChange(() => this.syncMute());
  }

  announce(text) {
    if (this.live) this.live.textContent = text;
  }

  // ------------------------------------------------------------ overlay ----

  show(el, { label, keys, kind } = {}) {
    this.clearKeys();
    this.root.replaceChildren(el);
    this.root.hidden = false;
    this.root.dataset.kind = kind || '';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    if (label) el.setAttribute('aria-labelledby', label);
    this.current = el;
    if (keys) {
      this.keyHandler = (e) => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
        keys(e);
      };
      document.addEventListener('keydown', this.keyHandler);
    }
    this.root.scrollTop = 0;
    requestAnimationFrame(() => {
      const first = el.querySelector('[data-autofocus]') || el.querySelector(FOCUSABLE);
      if (first) first.focus({ preventScroll: true });
    });
  }

  clearKeys() {
    if (this.keyHandler) document.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
  }

  hide() {
    this.clearKeys();
    this.root.hidden = true;
    this.root.replaceChildren();
    this.current = null;
  }

  padNav(action) {
    if (!this.current) return;
    const items = [...this.current.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (action === 'next') items[(i + 1) % items.length].focus();
    else if (action === 'prev') items[(i - 1 + items.length) % items.length].focus();
    else if (action === 'activate') {
      const el = i >= 0 ? items[i] : items[0];
      el.click();
    } else if (action === 'back') {
      const back = this.current.querySelector('[data-back]');
      back?.click();
    }
  }

  muteButton() {
    const b = h('button', { class: 'btn btn--ghost btn--mute', type: 'button', 'data-mute': '1', onclick: () => this.audio.toggleMute() });
    this.paintMute(b);
    return b;
  }

  paintMute(b) {
    b.textContent = this.audio.muted ? 'Sound off · M' : 'Sound on · M';
    b.setAttribute('aria-pressed', this.audio.muted ? 'true' : 'false');
  }

  syncMute() {
    document.querySelectorAll('[data-mute]').forEach((b) => this.paintMute(b));
    const hb = document.getElementById('hud-mute');
    if (hb) {
      hb.textContent = this.audio.muted ? 'Sound off' : 'Sound on';
      hb.setAttribute('aria-pressed', this.audio.muted ? 'true' : 'false');
    }
  }

  // ----------------------------------------------------------- screens ----

  showLoading(text) {
    this.show(h('section', { class: 'panel panel--center' }, h('p', { class: 'kicker', text })), { kind: 'loading' });
  }

  showDevError(title, problems) {
    const el = h('section', { class: 'panel panel--error' },
      h('p', { class: 'kicker', text: 'Developer error' }),
      h('h2', { id: 'dev-h', text: title }),
      h('p', { text: 'The game will not fly a level that disagrees with the Rule Book.' }),
      h('ul', { class: 'errlist' }, problems.map((p) => h('li', { text: p }))),
    );
    this.show(el, { label: 'dev-h', kind: 'error' });
  }

  showTitle({ rulebook, levels, mode, callsign, onStart, onPractice }) {
    const n = reached();
    const err = h('p', { class: 'field-error', id: 'cs-err', 'aria-live': 'polite' });
    const input = h('input', {
      id: 'callsign', name: 'callsign', class: 'input', autocomplete: 'nickname', maxlength: 16,
      spellcheck: 'false', 'aria-describedby': 'cs-hint cs-err', value: callsign || '', placeholder: 'e.g. Aurora-7',
    });
    const getCallsign = () => input.value;
    const start = h('button', { class: 'btn btn--primary btn--big', type: 'submit', 'data-autofocus': callsign ? '1' : null, text: 'Start run' });
    const form = h('form', { class: 'title-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      const msg = onStart(getCallsign());
      if (msg) { err.textContent = msg; input.focus(); }
    } },
    h('label', { for: 'callsign', class: 'label', text: 'Callsign' }),
    h('div', { class: 'title-row' }, input, start),
    h('p', { class: 'hint', id: 'cs-hint', text: '2–16 letters, digits, space, _ . -' }),
    err);
    if (!callsign) input.setAttribute('data-autofocus', '1');

    const chips = rulebook.sectors.map((s, i) => {
      const mod = rulebook.method.modules.find((m) => m.id === s.moduleId);
      const rec = levelRecord(s.id);
      const open = i < n;
      const seal = rec?.seal && rec.seal !== 'none' ? rec.seal : null;
      return h('li', {},
        h('button', {
          class: `chip${open ? '' : ' chip--locked'}`, type: 'button', disabled: !open,
          style: { '--accent': mod?.color || '#66e1ff' },
          'aria-label': open ? `Practice gate ${i + 1}, ${s.name}` : `Gate ${i + 1}, not reached yet`,
          onclick: () => {
            const msg = onPractice(i, getCallsign());
            if (msg) { err.textContent = msg; input.focus(); }
          },
        },
        h('span', { class: 'chip-gate', text: `G${i + 1}` }),
        h('span', { class: 'chip-name', text: open ? s.name : 'Locked' }),
        open && rec?.bestTimeMs != null ? h('span', { class: 'chip-time', text: formatTime(rec.bestTimeMs) }) : null,
        seal ? h('span', { class: `seal seal--${seal}`, text: seal }) : null));
    });

    const novaCanvas = h('canvas', { class: 'title-nova', width: 32, height: 32, 'aria-hidden': 'true' });
    const el = h('section', { class: 'panel panel--title' },
      h('div', { class: 'title-brand' },
        h('p', { class: 'kicker' }, `${rulebook.title} · ${rulebook.method.name}`),
        h('div', { class: 'title-logo' }, novaCanvas, h('h1', { id: 'title-h', class: 'logo', text: 'Nova Run' })),
        h('p', { class: `badge badge--${mode}` }, mode === 'fleet' ? 'Fleet server · shared board' : 'Solo · scores stay on this device')),
      form,
      h('div', { class: 'title-select' },
        h('h2', { class: 'h3', text: 'Practice a gate you have reached' }),
        h('ul', { class: 'chips' }, chips),
        h('p', { class: 'hint', text: 'A full run always starts at Gate 1.' })),
      h('details', { class: 'controls' },
        h('summary', { text: 'Controls' }),
        h('dl', { class: 'keys' },
          kv('Move', '← → or A D'),
          kv('Jump', 'Space, Z, K, W or ↑ · hold for height'),
          kv('Glide', 'press jump again in the air and hold'),
          kv('Harmony pulse', 'X, J or Enter'),
          kv('Drop / look down', '↓ or S'),
          kv('Pause · Mute', 'P or Esc · M'),
          kv('Gamepad', 'stick or D-pad, A jump, X or B pulse, Start'),
          kv('Touch', 'on-screen buttons'))),
      h('p', { class: 'disclaimer', text: rulebook.disclaimer }),
      h('nav', { class: 'title-links', 'aria-label': 'Site' },
        h('a', { href: 'index.html', text: '← The Rule Book' }),
        h('a', { href: 'hangar.html', text: 'Model Hangar' }),
        this.muteButton()));
    this.show(el, { label: 'title-h', kind: 'title' });
    return { novaCanvas };
  }

  showBriefing({ index, total, sector, module, practice, onLaunch, onBack }) {
    const hint = {
      harmonize: 'Pulse: X, J or Enter',
      chain: 'Alternate cyan and gold',
      scan: 'Stand beside each beacon',
      assist: 'Stand beside each capsule',
      review: 'Stand beside an amber terminal',
      integrity: 'Every red core is avoidable',
    }[sector.mechanic];
    const launch = h('button', { class: 'btn btn--primary btn--big', type: 'button', 'data-autofocus': '1', text: 'Launch', onclick: onLaunch });
    const el = h('section', { class: 'panel panel--brief', style: { '--accent': module.color } },
      h('p', { class: 'kicker' }, practice ? `Practice · Gate ${index + 1} of ${total}` : `Gate ${index + 1} of ${total}`),
      h('h2', { id: 'brief-h', class: 'brief-title', text: sector.name }),
      h('p', { class: 'brief-module' }, h('b', { text: module.id }), ` ${module.name}`),
      h('div', { class: 'brief-question' },
        h('p', { class: 'label', text: 'Gate question' }),
        h('p', { class: 'question', text: module.question })),
      h('div', { class: 'comms' },
        h('div', { class: 'comm' },
          portrait('assets/img/comms-captain.webp', 'C', 'The Captain'),
          h('div', { class: 'comm-text' }, h('p', { class: 'comm-who', text: 'Captain' }), h('p', { text: module.job }))),
        h('div', { class: 'comm' },
          portrait('assets/img/comms-navigator.webp', 'N', 'Nova, the navigator', novaPortrait),
          h('div', { class: 'comm-text' }, h('p', { class: 'comm-who', text: 'Nova' }), h('p', { text: sector.briefing })))),
      hint ? h('p', { class: 'brief-hint', text: hint }) : null,
      h('div', { class: 'actions' }, launch,
        onBack ? h('button', { class: 'btn btn--ghost', type: 'button', 'data-back': '1', text: 'Title', onclick: onBack }) : null));
    this.show(el, {
      label: 'brief-h',
      kind: 'briefing',
      keys: (e) => {
        if (e.code === 'Space' && document.activeElement === document.body) { e.preventDefault(); onLaunch(); }
      },
    });
  }

  showPause({ practice, onResume, onRestart, onQuit }) {
    const el = h('section', { class: 'panel panel--center panel--pause' },
      h('h2', { id: 'pause-h', class: 'h2', text: 'Paused' }),
      h('div', { class: 'stack' },
        h('button', { class: 'btn btn--primary', type: 'button', 'data-autofocus': '1', 'data-back': '1', text: 'Resume', onclick: onResume }),
        h('button', { class: 'btn', type: 'button', text: 'Restart level', onclick: onRestart }),
        this.muteButton(),
        h('button', { class: 'btn btn--ghost', type: 'button', text: practice ? 'Back to title' : 'Abandon run', onclick: onQuit })));
    this.show(el, { label: 'pause-h', kind: 'pause' });
  }

  /**
   * The gate: an integrity audit, then each scenario answered PASS / REVISE /
   * STOP (keys 1–3), explained with the cited Rule Book texts, then a summary.
   * `finish(verdicts)` returns the summary data; `onContinue` moves on.
   */
  showGate({ rulebook, index, sector, module, run, finish, onContinue }) {
    const verdicts = [];
    let q = 0;
    const sc = rulebook.scoring;
    const panel = h('section', { class: 'panel panel--gate', style: { '--accent': module.color } });
    const header = h('header', { class: 'gate-head' },
      h('p', { class: 'kicker' }, `Gate ${index + 1} · ${module.id}`),
      h('h2', { id: 'gate-h', class: 'h2', tabindex: '-1', 'data-autofocus': '1', text: module.name }),
      h('p', { class: 'question', text: module.question }));
    const taken = run.mech.shortcuts;
    const audit = h('div', { class: `audit${taken ? ' audit--hit' : ''}` },
      h('p', { class: 'label', text: 'Integrity audit' }),
      h('p', {}, taken
        ? `${taken} shortcut${taken > 1 ? 's' : ''} taken: +${sc.shortcutGain} each at the time, −${sc.shortcutPenalty} each now, integrity −${sc.integrityPerShortcut} each.`
        : 'No shortcuts taken in this sector.'));
    const body = h('div', { class: 'gate-body', 'aria-live': 'polite' });
    panel.append(header, audit, body);

    const renderScenario = () => {
      const g = sector.gate[q];
      const opts = g.options.map((o, i) => {
        const { label, rest } = splitOption(o);
        return h('button', {
          class: 'option', type: 'button', 'data-i': i,
          onclick: () => choose(i),
        }, h('span', { class: 'key', text: String(i + 1) }), label ? h('span', { class: `verdict verdict--${label.toLowerCase()}`, text: label }) : null, h('span', { class: 'opt-text', text: rest }));
      });
      body.replaceChildren(
        h('p', { class: 'kicker', text: `Scenario ${q + 1} of ${sector.gate.length}` }),
        h('p', { class: 'scenario', tabindex: '-1', text: g.scenario }),
        h('div', { class: 'options', role: 'group', 'aria-label': 'Your verdict: keys 1, 2 or 3' }, opts));
      // Focus the scenario, not an answer: a verdict always takes a deliberate
      // key (1–3, Tab then Enter, or a click), never a stray pulse press.
      if (q > 0) requestAnimationFrame(() => body.querySelector('.scenario')?.focus({ preventScroll: true }));
    };

    let answered = false;
    const choose = (i) => {
      if (answered) return;
      answered = true;
      const g = sector.gate[q];
      verdicts[q] = i;
      const right = i === g.answer;
      this.audio.sfx(right ? 'correct' : 'wrong');
      body.querySelectorAll('.option').forEach((b) => {
        const k = Number(b.dataset.i);
        b.disabled = true;
        if (k === g.answer) b.classList.add('option--answer');
        if (k === i) b.classList.add(right ? 'option--right' : 'option--wrong');
      });
      const ans = splitOption(g.options[g.answer]).label;
      const meaning = rulebook.method.verdicts.find((v) => v.label === ans)?.meaning;
      const cites = g.cites.map((id) => lookupCite(rulebook, id));
      const last = q === sector.gate.length - 1;
      const next = h('button', { class: 'btn btn--primary', type: 'button', text: last ? 'Gate result' : 'Next scenario', onclick: () => {
        answered = false;
        q++;
        if (q < sector.gate.length) renderScenario();
        else renderSummary();
      } });
      body.append(h('div', { class: `feedback ${right ? 'feedback--right' : 'feedback--wrong'}` },
        h('p', { class: 'feedback-head' }, right ? 'Correct' : 'Not this time', ans ? ` · the verdict is ${ans}` : ''),
        meaning ? h('p', { class: 'meaning', text: meaning }) : null,
        h('p', { text: g.explain }),
        h('ul', { class: 'cites' }, cites.map((c) => h('li', { style: c.color ? { '--cite': c.color } : null },
          h('b', { text: c.id }), ` ${c.title}`, c.extra ? h('span', { class: 'cite-extra', text: ` · ${c.extra}` }) : null,
          c.text ? h('span', { class: 'cite-text', text: c.text }) : null))),
        h('div', { class: 'actions' }, next)));
      requestAnimationFrame(() => next.focus({ preventScroll: true }));
    };

    const renderSummary = () => {
      const s = finish(verdicts.slice());
      const correct = correctVerdicts(sector, s.result);
      body.replaceChildren(
        h('p', { class: 'kicker', text: 'Gate result' }),
        h('dl', { class: 'stats' },
          stat('Sector score', String(s.score)),
          stat('Verdicts', `${correct} of ${sector.gate.length}`),
          stat('Time', formatTime(s.result.timeMs)),
          stat('Completion', `${s.completion}%`)),
        h('p', { class: 'seal-line' },
          s.seal !== 'none' ? h('span', { class: `seal seal--${s.seal}`, text: s.seal }) : null,
          s.records.newTime ? h('span', { class: 'pb', text: 'New best time' }) : null,
          s.records.newSeal && s.seal !== 'none' ? h('span', { class: 'pb', text: 'New seal' }) : null),
        h('p', { class: 'hint', text: 'Seals and best times are personal records kept on this device.' }),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn--primary btn--big', type: 'button', 'data-autofocus': '1', text: s.nextLabel, onclick: onContinue })));
      requestAnimationFrame(() => body.querySelector('.btn--primary')?.focus({ preventScroll: true }));
    };

    renderScenario();
    this.show(panel, {
      label: 'gate-h',
      kind: 'gate',
      keys: (e) => {
        if (!e.repeat && ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3'].includes(e.code) && !answered && q < sector.gate.length) {
          const i = Number(e.code.slice(-1)) - 1;
          if (i < sector.gate[q].options.length) {
            e.preventDefault();
            choose(i);
          }
        }
      },
    });
  }

  showReadiness({ rulebook, correct, total, level, onContinue }) {
    const levels = rulebook.scoring.readinessLevels;
    const min = rulebook.method.minimumRule;
    const el = h('section', { class: 'panel panel--center panel--ready' },
      h('p', { class: 'kicker', text: 'Readiness' }),
      h('h2', { id: 'ready-h', class: 'big-number' }, 'Level ', h('span', { text: String(level) })),
      h('p', { class: 'lead', text: `${correct} of ${total} gate verdicts correct` }),
      h('ol', { class: 'ladder', 'aria-label': 'Readiness levels' }, levels.map((l) => h('li', {
        class: `${l.level === level ? 'is-current' : ''}${l.level === min.level ? ' is-min' : ''}`,
      }, h('b', { text: `L${l.level}` }), h('span', { text: `${l.minCorrect}+` })))),
      h('p', { class: 'rule', text: min.text }),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn--primary btn--big', type: 'button', 'data-autofocus': '1', text: 'Continue', onclick: onContinue })));
    this.show(el, { label: 'ready-h', kind: 'readiness' });
  }

  /** Launch finale. `clearance` is a promise resolving to the submission outcome. */
  showFinale({ rulebook, reducedMotion, clearance, onDebrief }) {
    const portraitMode = window.innerHeight > window.innerWidth;
    const shape = portraitMode ? '9x16' : '16x9';
    const media = h('div', { class: 'finale-media', 'aria-hidden': 'true' });
    const poster = `assets/img/briefing-poster-${shape}.webp`;
    if (reducedMotion) {
      media.append(posterImg(shape));
    } else {
      const v = h('video', { autoplay: true, muted: true, loop: true, playsinline: true, poster, preload: 'auto' },
        h('source', { src: `assets/video/briefing-${shape}.webm`, type: 'video/webm' }),
        h('source', { src: `assets/video/briefing-${shape}.mp4`, type: 'video/mp4' }));
      v.muted = true;
      const fallback = () => { v.replaceWith(posterImg(shape)); };
      v.querySelectorAll('source')[1].addEventListener('error', fallback, { once: true });
      v.addEventListener('error', fallback, { once: true });
      media.append(v);
      v.play?.().catch(() => {});
    }
    const status = h('p', { class: 'clearance-status', 'aria-live': 'polite', text: 'Recording your run…' });
    const link = h('div', { class: 'clearance' }, status);
    const ch = rulebook.charter;
    const el = h('section', { class: 'finale' }, media,
      h('div', { class: 'finale-copy' },
        h('p', { class: 'kicker', text: 'Launch' }),
        h('h2', { id: 'fin-h', class: 'finale-head', text: ch.vision.headline }),
        h('p', { class: 'lead', text: ch.vision.body }),
        h('p', { class: 'oath-head', text: ch.oath.headline }),
        h('p', { text: ch.oath.body }),
        link,
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', 'data-autofocus': '1', text: 'Debrief', onclick: onDebrief }))));
    this.show(el, { label: 'fin-h', kind: 'finale' });
    Promise.resolve(clearance).then((res) => {
      if (res && res.clearance) {
        link.replaceChildren(h('a', { class: 'btn btn--primary btn--big btn--gold', href: 'hangar.html' }, 'Clearance granted → Model Hangar'));
        if (res.mode === 'solo') link.append(h('p', { class: 'hint', text: 'Solo mode: clearance is a record on this device.' }));
      } else {
        // Server messages end with their own full stop; do not add a second one.
        status.textContent = res?.error ? `Clearance not recorded: ${String(res.error.message).replace(/[.\s]+$/, '')}. You can retry from the debrief.` : 'Clearance not recorded.';
      }
    });
  }

  showMinimumEnding({ rulebook, level, allCleared, onFlyAgain, onDebrief }) {
    const min = rulebook.method.minimumRule;
    const el = h('section', { class: 'panel panel--center panel--min' },
      h('p', { class: 'kicker', text: allCleared ? `Readiness Level ${level}` : 'Run ended' }),
      h('h2', { id: 'min-h', class: 'h2', text: min.text }),
      h('p', { class: 'lead', text: `Launch needs Level ${min.level}.` }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn--primary btn--big', type: 'button', 'data-autofocus': '1', text: 'Fly again', onclick: onFlyAgain }),
        h('button', { class: 'btn', type: 'button', text: 'Debrief', onclick: onDebrief })));
    this.show(el, { label: 'min-h', kind: 'ending' });
  }

  showHullOut({ sectorName, onContinue }) {
    const el = h('section', { class: 'panel panel--center panel--over' },
      h('p', { class: 'kicker', text: 'Hull breached' }),
      h('h2', { id: 'over-h', class: 'h2', text: `The run ends in ${sectorName}` }),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn--primary btn--big', type: 'button', 'data-autofocus': '1', text: 'Debrief', onclick: onContinue })));
    this.show(el, { label: 'over-h', kind: 'over' });
  }

  showPracticeEnd({ sector, cleared, onRetry, onTitle }) {
    const el = h('section', { class: 'panel panel--center' },
      h('p', { class: 'kicker', text: 'Practice' }),
      h('h2', { id: 'pe-h', class: 'h2', text: cleared ? `${sector.name} cleared` : `Hull breached in ${sector.name}` }),
      h('p', { class: 'hint', text: 'Practice flights are not submitted to any board.' }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn--primary', type: 'button', 'data-autofocus': '1', text: 'Fly it again', onclick: onRetry }),
        h('button', { class: 'btn', type: 'button', text: 'Title', onclick: onTitle })));
    this.show(el, { label: 'pe-h', kind: 'practice' });
  }

  /**
   * Debrief: per-level breakdown, totals from scoring.js, the submission
   * outcome and the board. `submit()` (re)tries the submission.
   */
  showDebrief({ rulebook, results, summary, seals, mode, callsign, submission, submit, loadBoard, subscribe, onFlyAgain, onTitle }) {
    const rows = rulebook.sectors.map((s, i) => {
      const r = results[i];
      const score = summary.perSector[i];
      return h('tr', {},
        h('th', { scope: 'row' }, h('span', { class: 'mono', text: `G${i + 1}` }), ` ${s.name}`),
        h('td', { class: 'col-status', text: r ? (r.cleared ? 'Cleared' : 'Not cleared') : '—' }),
        h('td', { class: 'num', text: score === undefined ? '—' : String(score) }),
        h('td', { class: 'num', text: r ? formatTime(r.timeMs) : '—' }),
        h('td', {}, seals[i] && seals[i] !== 'none' ? h('span', { class: `seal seal--${seals[i]}`, text: seals[i] }) : r && !r.cleared ? 'Not cleared' : '—'));
    });
    const subLine = h('div', { class: 'submission', 'aria-live': 'polite' }, h('p', { text: 'Submitting…' }));
    const boardList = h('ol', { class: 'board' });
    const boardNote = h('p', { class: 'hint' });
    const feed = h('ul', { class: 'feed', 'aria-live': 'polite' });
    const hangarSlot = h('div', { class: 'hangar-slot' });
    const el = h('section', { class: 'panel panel--debrief' },
      h('p', { class: 'kicker' }, `Debrief · ${callsign}`),
      h('h2', { id: 'deb-h', class: 'h2', text: summary.rankName }),
      h('dl', { class: 'stats stats--wide' },
        stat('Score', String(summary.score)),
        stat('Integrity', String(summary.integrity)),
        stat('Readiness', `Level ${summary.readinessLevel}`),
        stat('Gates cleared', `${summary.sectorsCleared} of ${rulebook.sectors.length}`)),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'levels' },
          h('caption', { class: 'visually-hidden', text: 'Per-gate results' }),
          h('thead', {}, h('tr', {}, ['Gate', 'Status', 'Score', 'Time', 'Seal'].map((t) => h('th', { scope: 'col', class: t === 'Status' ? 'col-status' : null, text: t })))),
          h('tbody', {}, rows))),
      subLine,
      hangarSlot,
      h('div', { class: 'board-wrap' },
        h('h3', { class: 'h3', text: mode === 'fleet' ? 'Fleet board' : 'This device' }),
        boardList, boardNote,
        mode === 'fleet' ? h('div', { class: 'feed-wrap' }, h('h3', { class: 'h3', text: 'Live from the fleet' }), feed) : null),
      h('p', { class: 'hint', text: mode === 'fleet' ? 'The server recomputes every score.' : 'Solo mode: scores stay on this device.' }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn--primary btn--big', type: 'button', 'data-autofocus': '1', text: 'Fly again', onclick: onFlyAgain }),
        h('button', { class: 'btn', type: 'button', text: 'Title', onclick: onTitle })));
    this.show(el, { label: 'deb-h', kind: 'debrief' });

    let myId = null;
    const renderBoard = async () => {
      const b = await loadBoard();
      boardList.replaceChildren();
      if (b.error) boardNote.textContent = b.error;
      else if (!b.entries.length) boardNote.textContent = 'No runs on this board yet.';
      else boardNote.textContent = mode === 'fleet' ? `${b.total} run${b.total === 1 ? '' : 's'} on the board.` : `${b.total} run${b.total === 1 ? '' : 's'} on this device.`;
      b.entries.forEach((e, i) => boardList.append(h('li', { class: e.id === myId ? 'is-me' : '' },
        h('span', { class: 'mono rank-no', text: `${i + 1}` }),
        h('span', { class: 'who', text: e.callsign }),
        h('span', { class: 'mono', text: String(e.score) }),
        h('span', { class: 'rank-name', text: e.rankName }))));
    };

    const showOutcome = (res) => {
      subLine.replaceChildren();
      if (res.error) {
        const retry = h('button', { class: 'btn', type: 'button', text: 'Retry submission' });
        const wait = res.error.retryAfterSec;
        // The server's rate-limit message already names the wait, so the
        // countdown lives on the button rather than being said twice.
        subLine.append(h('p', { class: 'error-line', text: `Not submitted: ${res.error.message}` }));
        if (wait) {
          let left = Math.ceil(wait);
          retry.disabled = true;
          retry.textContent = `Retry in ${left} s`;
          const tick = setInterval(() => {
            left--;
            if (!retry.isConnected || left <= 0) {
              clearInterval(tick);
              retry.disabled = false;
              retry.textContent = 'Retry submission';
            } else retry.textContent = `Retry in ${left} s`;
          }, 1000);
        }
        retry.addEventListener('click', async () => {
          subLine.replaceChildren(h('p', { text: 'Submitting…' }));
          showOutcome(await submit());
        });
        subLine.append(retry);
      } else {
        myId = res.entry.id;
        subLine.append(h('p', {}, res.mode === 'fleet' ? 'On the fleet board at ' : 'Saved on this device at ', h('b', { text: `#${res.placement}` }), '.'));
        if (res.clearance) {
          hangarSlot.replaceChildren(h('a', { class: 'btn btn--primary btn--gold', href: 'hangar.html' }, 'Clearance granted → Model Hangar'));
        }
      }
      renderBoard();
    };
    Promise.resolve(submission).then(showOutcome);

    if (mode === 'fleet' && subscribe) {
      const stop = subscribe((entry) => {
        feed.prepend(h('li', {}, h('b', { text: entry.callsign }), ` ${entry.score} · ${entry.rankName}`));
        while (feed.children.length > 8) feed.lastChild.remove();
        renderBoard();
      });
      this.onLeave = stop;
    }
  }

  leaveDebrief() {
    this.onLeave?.();
    this.onLeave = null;
  }

  // --------------------------------------------------------------- HUD ----

  buildHUD() {
    const cells = h('div', { class: 'hud-cells', id: 'hud-cells', role: 'img', 'aria-label': 'Hull' });
    for (let i = 0; i < HULL_CELLS; i++) cells.append(h('i', {}));
    this.hud.replaceChildren(
      h('div', { class: 'hud-left' },
        cells,
        h('div', { class: 'hud-chip hud-int', id: 'hud-int-wrap' }, h('span', { class: 'lbl', text: 'Integrity' }), h('b', { id: 'hud-int', text: '100' }))),
      h('div', { class: 'hud-mid' },
        h('b', { class: 'hud-gate', id: 'hud-gate', text: 'G1' }),
        h('span', { class: 'hud-time mono', id: 'hud-time', text: '00:00.0' })),
      h('div', { class: 'hud-right' },
        h('div', { class: 'hud-chip hud-gems' }, h('span', { class: 'gem-ico', 'aria-hidden': 'true' }), h('span', { class: 'visually-hidden', text: 'Gems ' }), h('b', { id: 'hud-gems', text: '0/0' })),
        h('div', { class: 'hud-chip hud-mech' }, h('span', { class: 'lbl', id: 'hud-mech-l', text: '' }), h('b', { id: 'hud-mech', text: '' })),
        h('div', { class: 'hud-streak', id: 'hud-streak', 'aria-hidden': 'true' }),
        h('button', { class: 'hud-btn', id: 'hud-pause', type: 'button', 'aria-label': 'Pause', text: 'II' })));
  }

  showHUD(on) {
    this.hud.hidden = !on;
    this.touch.hidden = !on || !this.touchEnabled;
    document.body.classList.toggle('is-flying', on);
    document.body.classList.toggle('has-touch', !!this.touchEnabled);
  }

  updateHUD(run, integrity) {
    const c = this.hudCache;
    const set = (id, v) => {
      if (c[id] === v) return;
      c[id] = v;
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    if (c.cells !== run.cells) {
      c.cells = run.cells;
      const cells = document.getElementById('hud-cells');
      [...cells.children].forEach((el, i) => el.classList.toggle('off', i >= run.cells));
      cells.setAttribute('aria-label', `Hull ${run.cells} of ${HULL_CELLS} cells`);
      cells.classList.remove('hit');
      void cells.offsetWidth;
      cells.classList.add('hit');
    }
    set('hud-int', String(integrity));
    const iw = document.getElementById('hud-int-wrap');
    iw.classList.toggle('flash', run.fx.integrityFlash > 0);
    iw.classList.toggle('low', integrity < 100);
    set('hud-gate', `G${run.levelIndex + 1}`);
    set('hud-time', formatTime(run.timeMs));
    set('hud-gems', `${run.mech.cores}/${run.sector.spawn.cores}`);
    const m = run.mech.hudCounter();
    set('hud-mech-l', m ? m.label : '');
    set('hud-mech', m ? (run.sector.mechanic === 'integrity' ? `${m.value}` : `${m.value}/${m.max}`) : '');
    const st = run.streak >= 2 ? `×${run.streak}` : '';
    set('hud-streak', st);
    // The chain chip shows which kind of pod came last (cyan SI, gold human).
    const last = run.sector.mechanic === 'chain' ? run.mech.chainLast || '' : '';
    if (c.last !== last) {
      c.last = last;
      document.querySelector('.hud-mech').dataset.last = last;
    }
  }

  // ------------------------------------------------------------- touch ----

  buildTouch() {
    const input = this.input;
    const pad = h('div', { class: 'tpad', 'aria-hidden': 'true' },
      h('span', { class: 'tbtn tbtn--l', text: '◀' }), h('span', { class: 'tbtn tbtn--r', text: '▶' }));
    const jump = h('button', { class: 'tbtn tbtn--jump', type: 'button', 'aria-label': 'Jump', text: 'Jump' });
    const pulse = h('button', { class: 'tbtn tbtn--pulse', type: 'button', 'aria-label': 'Harmony pulse', text: 'Pulse' });
    const down = h('button', { class: 'tbtn tbtn--down', type: 'button', 'aria-label': 'Down', text: '▼' });
    this.touch.replaceChildren(h('div', { class: 'touch-left' }, down, pad), h('div', { class: 'touch-right' }, pulse, jump));

    const padPointers = new Map();
    const padUpdate = () => {
      let l = false;
      let r = false;
      const rect = pad.getBoundingClientRect();
      for (const x of padPointers.values()) {
        if (x < rect.left + rect.width / 2) l = true; else r = true;
      }
      if (l) input.touchDown('left'); else input.touchUp('left');
      if (r) input.touchDown('right'); else input.touchUp('right');
      pad.dataset.l = l ? '1' : '';
      pad.dataset.r = r ? '1' : '';
    };
    const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* pointer already gone */ } };
    pad.addEventListener('pointerdown', (e) => { e.preventDefault(); capture(pad, e.pointerId); padPointers.set(e.pointerId, e.clientX); padUpdate(); });
    pad.addEventListener('pointermove', (e) => { if (padPointers.has(e.pointerId)) { padPointers.set(e.pointerId, e.clientX); padUpdate(); } });
    const padEnd = (e) => { padPointers.delete(e.pointerId); padUpdate(); };
    pad.addEventListener('pointerup', padEnd);
    pad.addEventListener('pointercancel', padEnd);
    for (const [el, action] of [[jump, 'jump'], [pulse, 'pulse'], [down, 'down']]) {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); capture(el, e.pointerId); input.touchDown(action); el.classList.add('on'); });
      const end = () => { input.touchUp(action); el.classList.remove('on'); };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
    }
    this.touch.addEventListener('contextmenu', (e) => e.preventDefault());
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    this.touchEnabled = !!coarse || 'ontouchstart' in window;
    window.addEventListener('touchstart', () => {
      if (!this.touchEnabled) {
        this.touchEnabled = true;
        document.body.classList.add('has-touch');
        if (!this.hud.hidden) this.touch.hidden = false;
      }
    }, { passive: true, once: true });
  }
}

function kv(k, v) {
  return [h('dt', { text: k }), h('dd', { text: v })];
}

function stat(k, v) {
  return h('div', { class: 'stat' }, h('dt', { text: k }), h('dd', { text: v }));
}

function posterImg(shape) {
  const pic = h('picture', {},
    h('source', { srcset: `assets/img/briefing-poster-${shape}.webp`, type: 'image/webp' }),
    h('img', { src: `assets/img/briefing-poster-${shape}.jpg`, alt: '' }));
  pic.querySelector('img').addEventListener('error', () => pic.classList.add('is-missing'), { once: true });
  return pic;
}
