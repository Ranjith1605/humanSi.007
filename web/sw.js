// The service worker: HumanSI Synergy as an app that opens offline
// (docs/CITY.md, "Install and offline"). Registered by js/pwa.js.
//
//   install   precache the app shell into one versioned cache
//   activate  delete older HumanSI caches, take control of open pages
//   fetch     same-origin GET inside the scope only:
//             pages   network first, cached copy when offline (or when the
//                     network hangs), cached index.html for a page never seen
//             assets  stale-while-revalidate: instant from the cache, refreshed
//                     in the background for the next visit
//             never   api/ (live answers or the solo marker, never a stale
//                     copy), event streams, videos and byte ranges
//
// Bump VERSION whenever the shell list changes or a release must reach
// installed copies at once: it is the only cache-busting mechanism. A new
// version waits until every tab of the old one is closed (no skipWaiting), so
// a running game never has its modules swapped underneath it.
//
// The site lives at a sub-path on GitHub Pages (/humanSi.007/web/) and at the
// root on the Go server, so every URL here is resolved against the
// registration's scope, never written as an absolute path.

const VERSION = '1';
const PREFIX = 'humansi-shell-';
const CACHE = PREFIX + VERSION;
const SCOPE = self.registration.scope;
const at = (path) => new URL(path, SCOPE).href;

// The offline fallback for any page: without it the install must fail, so
// the browser tries again on the next visit instead of keeping a hollow app.
const PAGES = ['index.html', 'play.html', 'city.html', 'inspect.html', 'hangar.html'];

// Everything those pages load. Best effort: a miss is logged and filled in at
// runtime the next time a page asks for it. Videos are never precached (they
// are megabytes, and the poster stands in for them).
const SHELL = [
  'manifest.webmanifest',
  'assets/icons/icon.svg',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/icons/apple-touch-icon.png',
  'assets/img/briefing-poster-16x9.webp',
  'assets/img/briefing-poster-9x16.webp',
  'assets/img/comms-captain.webp',
  'assets/img/comms-navigator.webp',
  'assets/img/crew-briefing.webp',

  'css/tokens.css',
  'css/landing.css',
  'css/game.css',
  'css/city.css',
  'css/inspect.css',
  'css/hangar.css',

  'data/rulebook.json',
  'data/models.json',
  'data/glassbox.json',
  'data/city.json',

  'js/pwa.js',
  'js/api.js',
  'js/scoring.js',
  'js/landing.js',
  'js/hangar.js',

  'js/game/main.js',
  'js/game/audio.js',
  'js/game/backgrounds.js',
  'js/game/camera.js',
  'js/game/engine.js',
  'js/game/entities.js',
  'js/game/font.js',
  'js/game/game.js',
  'js/game/input.js',
  'js/game/level.js',
  'js/game/mechanics.js',
  'js/game/paint.js',
  'js/game/particles.js',
  'js/game/physics.js',
  'js/game/player.js',
  'js/game/records.js',
  'js/game/render.js',
  'js/game/sprites.js',
  'js/game/tiles.js',
  'js/game/ui.js',
  'js/game/worlds.js',
  'js/game/levels/index.js',
  'js/game/levels/g1-purpose-rift.js',
  'js/game/levels/g2-triage-belt.js',
  'js/game/levels/g3-dignity-expanse.js',
  'js/game/levels/g4-oversight-nebula.js',
  'js/game/levels/g5-adoption-drift.js',
  'js/game/levels/g6-lifecycle-orbit.js',

  'js/glassbox/main.js',
  'js/glassbox/logic.js',

  'js/city/main.js',
  'js/city/engine.js',
  'js/city/core.js',
  'js/city/camera.js',
  'js/city/citizens.js',
  'js/city/collision.js',
  'js/city/hud.js',
  'js/city/input.js',
  'js/city/interactions.js',
  'js/city/perf.js',
  'js/city/places.js',
  'js/city/player.js',
  'js/city/world.js',
  'js/city/skyway.js',
  'js/city/skypod.js',
  'js/city/roadster.js',
  'vendor/three/three.module.js',
];

// Small batches: a phone on a weak signal is not asked for 80 files at once.
const BATCH = 6;
// How long a page waits on a hanging network before the cached copy is shown.
const PAGE_TIMEOUT_MS = 3000;

async function store(cache, path) {
  // 'no-cache' revalidates with the server (a cheap 304 when nothing
  // changed), so a new version never stores a copy the HTTP cache kept from
  // the previous release.
  const res = await fetch(new Request(at(path), { cache: 'no-cache' }));
  if (res.status !== 200 || res.redirected) throw new Error(`${res.status} ${path}`);
  await cache.put(at(path), res);
}

async function precache() {
  const cache = await caches.open(CACHE);
  const entries = [...PAGES.map((p) => [p, true]), ...SHELL.map((p) => [p, false])];
  const missed = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(([path]) => store(cache, path)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j].status === 'fulfilled') continue;
      const [path, required] = batch[j];
      if (required) throw new Error(`HumanSI: cannot cache ${path}: ${results[j].reason}`);
      missed.push(path);
    }
  }
  if (missed.length) console.warn(`HumanSI: ${missed.length} shell file(s) not cached yet:`, missed);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Only our own caches: other projects on the same github.io origin share
    // this CacheStorage.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
    // The page request starts while the worker boots, so network-first costs
    // no extra round trip.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

/** Network first; the cached page when offline or slow; index.html for a page never cached. */
async function page(event) {
  const cache = await caches.open(CACHE);
  // A query string never changes a static page, so one copy per page.
  const url = new URL(event.request.url);
  url.search = '';
  url.hash = '';
  const key = url.href;

  const network = (async () => {
    const res = (await event.preloadResponse) || (await fetch(event.request));
    // A redirected response cannot be replayed for a navigation (Safari
    // refuses it), and an error page is not the page.
    if (res.status === 200 && !res.redirected) event.waitUntil(cache.put(key, res.clone()));
    return res;
  })();
  // When the cached copy wins the race, the network still finishes and
  // refreshes the cache for next time.
  event.waitUntil(network.catch(() => {}));

  const timeout = new Promise((resolve) => setTimeout(resolve, PAGE_TIMEOUT_MS, 'slow'));
  const first = await Promise.race([network.catch(() => 'offline'), timeout]);
  if (first instanceof Response) return first;

  const cached = await cache.match(key, { ignoreVary: true });
  if (cached) return cached;
  if (first === 'slow') {
    try {
      return await network;
    } catch { /* went offline while waiting: fall through */ }
  }
  return (await cache.match(at('index.html'), { ignoreVary: true })) || Response.error();
}

/** Stale-while-revalidate. */
async function asset(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request, { ignoreVary: true });
  const fresh = fetch(event.request).then((res) => {
    if (res.status === 200 && res.type === 'basic') event.waitUntil(cache.put(event.request, res.clone()));
    return res;
  });
  if (!cached) return fresh;
  event.waitUntil(fresh.catch(() => {}));
  return cached;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(SCOPE)) return;
  // DevTools can issue this combination, and fetch() rejects it.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const path = request.url.slice(SCOPE.length);
  if (path === 'api' || path.startsWith('api/') || path.startsWith('api?')) return;
  if ((request.headers.get('accept') || '').includes('text/event-stream')) return;
  if (request.headers.has('range') || request.destination === 'video' || request.destination === 'audio' ||
      /\.(?:webm|mp4)$/i.test(new URL(request.url).pathname)) return;
  event.respondWith(request.mode === 'navigate' ? page(event) : asset(event));
});
