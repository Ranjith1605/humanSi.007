// Registers the service worker (web/sw.js) so HumanSI Synergy installs as an
// app and opens offline. Nothing else lives here: every page loads this one
// small module, and a page must work the same without it.
//
// The worker's URL is resolved from this module, not from the page, so it is
// web/sw.js both under the GitHub Pages sub-path (/humanSi.007/web/) and at
// the Go server's root; its default scope is then that same directory.
// Service workers need a secure context (https, or http://localhost), so a
// plain-http LAN address simply skips this.

if ('serviceWorker' in navigator && window.isSecureContext) {
  const register = () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url).href).catch((err) => {
      console.warn('HumanSI: offline mode unavailable, service worker not registered.', err);
    });
  };
  // Wait for the page's own load so the precache (three.js alone is 1.3 MB)
  // never competes with the first paint for bandwidth.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
