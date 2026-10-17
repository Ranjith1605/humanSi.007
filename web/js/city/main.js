// Synergy City entry point. Kept tiny on purpose: the loop and wiring live in
// engine.js. If anything throws during setup, fall back to the plain links.
import { start } from './engine.js';

start().catch((err) => {
  console.error('Synergy City failed to start:', err);
  const fb = document.getElementById('fallback');
  const ld = document.getElementById('loading');
  if (ld) ld.hidden = true;
  if (fb) fb.hidden = false;
});
