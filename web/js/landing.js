// Landing page: the public face of the Rule Book and of Nova Run.
//
// Every word of the Rule Book shown here comes from rulebook.json (through
// api.js, which also decides fleet vs solo) and is set with textContent or
// text nodes, never innerHTML. This file only arranges the words; the page
// chrome in index.html stays short. Colours come from the rule book too and
// are applied through the CSSOM (style.setProperty), which the CSP allows,
// unlike inline style attributes.

import { connect, getRulebook, getModels, getLeaderboard, subscribeFleet } from './api.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const portrait = matchMedia('(orientation: portrait)');
const HEX = /^#[0-9a-f]{3,8}$/i;
const VERDICT_ACCENT = { pass: 'var(--pass)', revise: 'var(--revise)', stop: 'var(--stop)' };
const BOARD_LIMIT = 10;
const FEED_LIMIT = 5;

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
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** One accent colour per value, gate or verdict, from the rule book. */
function accent(el, color) {
  if (typeof color === 'string' && (HEX.test(color) || color.startsWith('var(--'))) {
    el.style.setProperty('--accent', color);
  }
  return el;
}

function bind(name, text) {
  for (const el of document.querySelectorAll(`[data-bind="${name}"]`)) el.textContent = text;
}

function onMediaChange(mq, fn) {
  if (mq.addEventListener) mq.addEventListener('change', fn);
  else mq.addListener(fn); // Safari < 14
}

// ------------------------------------------------------------- reveal --

// Scroll reveal is opt-in from here: without JavaScript, without
// IntersectionObserver or with reduced motion nothing is ever hidden.
let revealer = null;

function armReveal() {
  if (reduceMotion.matches || !('IntersectionObserver' in window)) return;
  // A deep link (index.html#gates) wants its target in place at once; a
  // card still sliding in would land the scroll a few pixels off.
  if (location.hash.length > 1) return;
  revealer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      revealer.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
  document.documentElement.classList.add('reveal-on');
  onMediaChange(reduceMotion, () => { if (reduceMotion.matches) revealAll(); });
  window.addEventListener('beforeprint', revealAll);
}

function revealAll() {
  for (const el of document.querySelectorAll('.reveal')) el.classList.add('is-in');
  if (revealer) revealer.disconnect();
  revealer = null;
}

function reveal(el) {
  if (revealer && el) {
    el.classList.add('reveal');
    revealer.observe(el);
  }
  return el;
}

// ---------------------------------------------------------- hero video --

function heroVideo() {
  const hero = document.querySelector('.hero');
  const video = hero && hero.querySelector('.hero__video');
  const img = hero && hero.querySelector('.hero__poster img');
  if (!video) return;

  // If a poster variant is missing, fall back to the full illustration
  // rather than an empty frame.
  if (img) {
    const fallback = () => {
      for (const s of img.parentElement.querySelectorAll('source')) s.remove();
      img.src = 'assets/img/crew-briefing.jpg';
    };
    if (img.complete && img.naturalWidth === 0 && img.currentSrc) fallback();
    else img.addEventListener('error', fallback, { once: true });
  }

  const saveData = !!(navigator.connection && navigator.connection.saveData);
  const allowed = () => !reduceMotion.matches && !saveData;
  let variant = null;
  let inView = true;

  video.muted = true;
  video.defaultMuted = true;
  video.addEventListener('playing', () => hero.classList.add('is-playing'));
  video.addEventListener('emptied', () => hero.classList.remove('is-playing'));

  const play = () => {
    if (!variant || !inView || document.hidden || !allowed()) return;
    const p = video.play();
    // Autoplay can be refused (low-power mode, data saver); the poster stays.
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };

  const apply = () => {
    const want = portrait.matches ? '9x16' : '16x9';
    video.poster = `assets/img/briefing-poster-${want}.webp`;
    if (!allowed()) {
      // Reduced motion: the poster only, nothing loads, nothing autoplays.
      if (variant) {
        video.pause();
        video.replaceChildren();
        video.removeAttribute('src');
        video.load();
        variant = null;
      }
      return;
    }
    if (want !== variant) {
      variant = want;
      video.replaceChildren(
        h('source', { src: `assets/video/briefing-${want}.webm`, type: 'video/webm' }),
        h('source', { src: `assets/video/briefing-${want}.mp4`, type: 'video/mp4' }),
      );
      video.preload = 'auto';
      video.load();
    }
    play();
  };

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      if (inView) play();
      else video.pause();
    }).observe(hero);
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? video.pause() : play()));
  onMediaChange(portrait, apply);
  onMediaChange(reduceMotion, apply);
  apply();
}

// --------------------------------------------------------------- chrome --

function topbar() {
  const bar = document.getElementById('topbar');
  const hero = document.querySelector('.hero');
  if (!bar) return;
  if (!hero || !('IntersectionObserver' in window)) {
    bar.classList.add('is-solid');
    return;
  }
  // Transparent over the hero, glass once the hero has scrolled away.
  new IntersectionObserver(([e]) => bar.classList.toggle('is-solid', !e.isIntersecting), {
    rootMargin: `-${bar.offsetHeight || 60}px 0px 0px 0px`,
  }).observe(hero);
}

function modeBadge(mode) {
  const badge = document.getElementById('mode-badge');
  if (!badge) return;
  badge.dataset.mode = mode;
  badge.querySelector('.mode__text').textContent =
    mode === 'fleet' ? 'Fleet server' : 'Solo · scores stay on this device';
}

// ------------------------------------------------------------- sections --

function indexArticles(rb) {
  const index = new Map();
  for (const value of rb.charter.values) {
    for (const article of value.articles) index.set(article.id, { value, article });
  }
  return index;
}

function renderHero(rb) {
  bind('title', rb.title);
  bind('subtitle', rb.subtitle);
  bind('ship', rb.ship);
  bind('shipSuffix', ` · ${rb.ship}`);
}

function renderTeaser(rb, modules) {
  bind('minLevel', String(rb.method.minimumRule.level));
  // The navigator portrait is generated media; if it is missing, drop the
  // figure rather than show a broken image. The copy stands on its own.
  const comms = document.querySelector('.teaser__comms');
  const portraitImg = comms && comms.querySelector('img');
  if (portraitImg) {
    const drop = () => { comms.hidden = true; };
    if (portraitImg.complete && portraitImg.naturalWidth === 0 && portraitImg.currentSrc) drop();
    else portraitImg.addEventListener('error', drop, { once: true });
  }
  document.getElementById('worlds').replaceChildren(
    ...rb.sectors.map((s) => {
      const m = modules.get(s.moduleId);
      if (!m) return null;
      return accent(
        h('li', {}, h('a', { href: `#gate-${m.gate}` }, h('span', { class: 'mono', text: m.gate }), s.name)),
        m.color,
      );
    }).filter(Boolean),
  );
  reveal(document.querySelector('.teaser__panel'));
}

function renderCharter(rb) {
  const c = rb.charter;
  bind('missionHeadline', c.mission.headline);
  bind('missionBody', c.mission.body);
  reveal(document.querySelector('#charter .section__head'));
  reveal(document.querySelector('.mission'));
  document.getElementById('values').replaceChildren(
    ...c.values.map((v) => reveal(accent(
      h('li', { class: 'value', id: `value-${v.id}` },
        h('div', { class: 'value__head' },
          // U+FE0E asks for the text form of the glyph, never an emoji.
          h('span', { class: 'value__glyph', 'aria-hidden': 'true', text: `${v.glyph}︎` }),
          h('h4', { class: 'value__name', text: v.name }),
          h('p', { class: 'value__summary', text: v.summary })),
        h('ol', { class: 'articles', 'aria-label': `${v.name} articles` },
          v.articles.map((a) => h('li', { class: 'article', id: `article-${a.id}` },
            h('h5', { class: 'article__title' },
              h('span', { class: 'article__id mono', text: a.id }),
              h('span', { text: a.title })),
            h('p', { class: 'article__text', text: a.text }))))),
      v.color,
    ))),
  );
}

function metaField(label, dd) {
  return h('div', {}, h('dt', { text: label }), dd);
}

function renderGates(rb, articles) {
  const m = rb.method;
  bind('methodName', m.name);
  bind('methodSummary', m.summary);
  bind('methodGeneralisation', m.generalisation);
  bind('minRule', m.minimumRule.text);
  reveal(document.querySelector('#gates .section__head'));
  reveal(document.querySelector('.gates__intro'));

  document.getElementById('verdicts').replaceChildren(
    ...m.verdicts.map((v) => reveal(accent(
      h('li', { class: 'verdict' },
        h('span', { class: 'verdict__label', text: v.label }),
        h('p', { class: 'verdict__meaning', text: v.meaning })),
      VERDICT_ACCENT[v.id] || 'var(--cyan)',
    ))),
  );

  document.getElementById('gate-list').replaceChildren(
    ...m.modules.map((mod) => {
      const sector = rb.sectors.find((s) => s.moduleId === mod.id);
      const chips = mod.articles.map((id) => {
        const hit = articles.get(id);
        if (!hit) return null;
        return accent(
          h('a', { class: 'chip', href: `#article-${id}` }, h('span', { class: 'mono', text: id }), hit.article.title),
          hit.value.color,
        );
      }).filter(Boolean);
      return reveal(accent(
        h('li', { class: 'gate', id: `gate-${mod.gate}` },
          h('div', { class: 'gate__rail' },
            h('span', { class: 'gate__id', 'aria-hidden': 'true', text: mod.gate }),
            h('span', { class: 'gate__module mono', text: mod.id }),
            h('h3', { class: 'gate__name' }, h('span', { class: 'visually-hidden', text: `${mod.gate}: ` }), mod.name),
            sector && h('p', { class: 'gate__world mono', text: `Nova Run · ${sector.name}` })),
          h('div', { class: 'gate__body' },
            h('p', { class: 'gate__question', text: mod.question }),
            h('dl', { class: 'gate__meta' },
              metaField('The job', h('dd', { class: 'gate__job', text: mod.job })),
              metaField('Artefacts', h('dd', {},
                h('ul', { class: 'gate__artefacts' }, mod.artefacts.map((a) => h('li', { text: a }))))),
              metaField('Anchor', h('dd', { class: 'gate__anchor', text: mod.anchor })),
              chips.length > 0 && metaField('Charter articles', h('dd', {}, h('div', { class: 'chips' }, chips)))))),
        mod.color,
      ));
    }),
  );

  document.getElementById('triggers').replaceChildren(...m.triggers.map((t) => h('li', { text: t })));
  reveal(document.querySelector('.triggers'));
  reveal(document.querySelector('.minimum'));
}

function renderStages(rb) {
  const stages = rb.method.stages;
  // "SHU", "HA", "RI" in the data; the heading reads them as one word, Shu-Ha-Ri.
  bind('stagesTitle', stages.map((s) => s.name.charAt(0) + s.name.slice(1).toLowerCase()).join('-'));
  reveal(document.querySelector('#shu-ha-ri .section__head'));
  document.getElementById('stages').replaceChildren(
    ...stages.map((s) => reveal(h('li', { class: 'stage' },
      h('h3', { class: 'stage__name', text: s.name }),
      h('p', { class: 'stage__motto', text: s.motto }),
      h('p', { class: 'stage__text', text: s.text })))),
  );
}

function renderCrew(rb) {
  const roles = rb.method.crewRoles;
  const half = Math.ceil(roles.length / 2);
  const item = (r) => h('li', { class: 'role' },
    h('span', { class: 'role__seat', 'aria-hidden': 'true' }),
    h('span', { text: r.name }));
  const a = document.getElementById('roles-a');
  const b = document.getElementById('roles-b');
  a.setAttribute('aria-label', 'Crew roles');
  b.setAttribute('aria-label', 'Crew roles, continued');
  a.replaceChildren(...roles.slice(0, half).map(item));
  b.replaceChildren(...roles.slice(half).map(item));
  reveal(document.querySelector('#crew .section__head'));
  reveal(document.querySelector('.crew__stage'));
}

function renderIntegrity(rb) {
  reveal(document.querySelector('#integrity .section__head'));
  document.getElementById('rules').replaceChildren(
    ...rb.method.integrity.map((r) => reveal(h('li', { class: 'rule', id: `rule-${r.id}` },
      h('span', { class: 'rule__id mono', text: r.id }),
      h('h3', { class: 'rule__title', text: r.title }),
      h('p', { class: 'rule__text', text: r.text })))),
  );
}

function renderVision(rb) {
  const c = rb.charter;
  bind('visionHeadline', c.vision.headline);
  bind('visionBody', c.vision.body);
  bind('oathHeadline', c.oath.headline);
  bind('oathBody', c.oath.body);
  reveal(document.querySelector('.vision__headline'));
  reveal(document.querySelector('.oath'));
}

function renderFooter(rb) {
  const d = document.getElementById('disclaimer');
  d.textContent = rb.disclaimer;
  d.hidden = false;
}

// ---------------------------------------------------------------- board --

const fmt = new Intl.NumberFormat('en');

function isEntry(e) {
  return e && typeof e === 'object' && typeof e.id === 'string' && typeof e.callsign === 'string' &&
    Number.isFinite(e.score) && typeof e.createdAt === 'string';
}

// Same order as the board itself (api.js and the server): best score first,
// earlier run first on a tie.
function byScore(a, b) {
  return b.score - a.score || a.createdAt.localeCompare(b.createdAt);
}

function runRow(e, place, gates, isNew) {
  return h('li', { class: isNew ? 'run is-new' : 'run' },
    h('span', { class: 'run__place mono', text: String(place).padStart(2, '0') }),
    h('span', { class: 'run__who' },
      h('span', { class: 'run__callsign', text: e.callsign }),
      e.rankName && h('span', { class: 'run__rank', text: String(e.rankName) })),
    h('span', { class: 'run__meta mono' },
      h('span', { text: `${e.sectorsCleared}/${gates} gates` }),
      h('span', { text: `integrity ${e.integrity}` }),
      h('span', { text: `readiness ${e.readinessLevel}` }),
      e.cleared === true && h('span', { class: 'run__clear', text: 'launch clearance' })),
    h('span', { class: 'run__score mono' }, fmt.format(e.score), h('span', { class: 'visually-hidden', text: ' points' })));
}

function board(rb, mode) {
  const section = document.getElementById('board');
  const list = document.getElementById('board-list');
  const empty = document.getElementById('board-empty');
  const totalEl = document.getElementById('board-total');
  const feedWrap = document.getElementById('feed-wrap');
  const feed = document.getElementById('feed');
  const gates = rb.sectors.length;
  const fleet = mode === 'fleet';

  document.getElementById('board-eyebrow').textContent = fleet ? 'Fleet server' : 'Solo mode';
  document.getElementById('board-title').textContent = fleet ? 'Fleet board' : 'Solo log';
  document.getElementById('board-mode').textContent = fleet
    ? 'Shared by every pilot on this server. The server re-scores every run, and new runs appear here as they land.'
    : 'No fleet server is running here, so there is no shared board. These are the runs flown in this browser; scores stay on this device.';
  reveal(section.querySelector('.board__panel'));

  const state = { entries: [], total: 0, error: null };

  const draw = (newId = null) => {
    list.replaceChildren(...state.entries.map((e, i) => runRow(e, i + 1, gates, e.id === newId)));
    list.hidden = state.entries.length === 0;
    empty.hidden = state.entries.length > 0;
    empty.textContent = state.error
      ? 'The fleet board is unavailable right now. Try again in a moment.'
      : fleet
        ? 'Nobody has flown yet. The first run to land on this server will appear here.'
        : 'Nobody has flown yet on this device. Finish a run and it will appear here.';
    totalEl.hidden = !(state.total > state.entries.length);
    totalEl.textContent = `Top ${state.entries.length} of ${fmt.format(state.total)} runs`;
  };

  const load = async () => {
    const res = await getLeaderboard(BOARD_LIMIT).catch(() => ({ entries: [], total: 0, error: 'unavailable' }));
    state.entries = (res.entries || []).filter(isEntry);
    state.total = Number.isFinite(res.total) ? res.total : state.entries.length;
    state.error = res.error || null;
    draw();
  };

  const land = (entry) => {
    if (!isEntry(entry) || state.entries.some((x) => x.id === entry.id)) return;
    state.total += 1;
    state.error = null;
    state.entries = [...state.entries, entry].sort(byScore).slice(0, BOARD_LIMIT);
    draw(entry.id);
    const at = new Date(entry.createdAt);
    feed.prepend(h('li', {},
      h('time', {
        datetime: entry.createdAt,
        text: Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }),
      `${entry.callsign} landed with ${fmt.format(entry.score)} points`));
    while (feed.children.length > FEED_LIMIT) feed.lastElementChild.remove();
    feedWrap.hidden = false;
  };

  let unsubscribe = () => {};
  const listen = () => {
    unsubscribe();
    unsubscribe = subscribeFleet(land);
  };

  load().then(() => { if (fleet) listen(); });

  if (fleet) {
    // A page restored from the back-forward cache missed whatever landed meanwhile.
    window.addEventListener('pagehide', () => unsubscribe());
    window.addEventListener('pageshow', (ev) => { if (ev.persisted) load().then(listen); });
  } else {
    // Solo runs are written by the game, possibly in another tab: re-read
    // this browser's log whenever it may have changed.
    window.addEventListener('storage', () => load());
    window.addEventListener('pageshow', (ev) => { if (ev.persisted) load(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  }
}

// ----------------------------------------------------------------- main --

const SECTIONS = ['nova-run', 'charter', 'gates', 'shu-ha-ri', 'crew', 'integrity', 'vision', 'board'];

async function main() {
  topbar();
  heroVideo();
  armReveal();

  const status = document.getElementById('load-state');
  const slow = setTimeout(() => {
    status.textContent = 'Loading the Rule Book…';
    status.hidden = false;
  }, 400);

  // Probe once, then fetch: getRulebook() also calls connect(), and two
  // calls in flight at the same time would each probe api/health.
  const { mode } = await connect();
  modeBadge(mode);

  let rb;
  try {
    rb = await getRulebook();
  } catch {
    clearTimeout(slow);
    status.replaceChildren(
      'The Rule Book could not be loaded. It is also readable as data in ',
      h('a', { href: 'data/rulebook.json', text: 'data/rulebook.json' }),
      '.');
    status.hidden = false;
    return;
  }
  clearTimeout(slow);
  status.hidden = true;

  const modules = new Map(rb.method.modules.map((m) => [m.id, m]));
  renderHero(rb);
  renderTeaser(rb, modules);
  renderCharter(rb);
  renderGates(rb, indexArticles(rb));
  renderStages(rb);
  renderCrew(rb);
  renderIntegrity(rb);
  renderVision(rb);
  renderFooter(rb);
  for (const id of SECTIONS) document.getElementById(id).hidden = false;

  getModels().then((cat) => {
    if (typeof cat.title === 'string' && cat.title) bind('hangar', cat.title);
    const n = Array.isArray(cat.models) ? cat.models.length : 0;
    if (n > 0) bind('hangarCount', `, a catalog of ${n} open-source and open-weight models`);
  }).catch(() => { /* the link still works; the count is simply not shown */ });

  board(rb, mode);

  // Arriving at index.html#gates and the like: the target did not exist
  // until now, so the browser could not scroll to it on load.
  if (location.hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) {
      try { target.scrollIntoView({ block: 'start', behavior: 'instant' }); } catch { target.scrollIntoView(); }
    }
  }
}

main();
