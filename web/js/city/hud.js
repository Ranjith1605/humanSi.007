// Synergy City — the DOM HUD and screens (loading, pause, fallback).
export function makeHud() {
  const $ = (id) => document.getElementById(id);
  const districtEl = $('district');
  const promptEl = $('prompt');
  const promptLabel = $('prompt-label');
  const promptHint = $('prompt-hint');
  const toastEl = $('toast');
  const loading = $('loading');
  const loadFill = $('load-fill');
  const loadHint = $('load-hint');
  const pause = $('pause');
  const fallback = $('fallback');
  let toastTimer = 0;

  return {
    setDistrict(name) { districtEl.textContent = name; },
    prompt(label, hint) {
      promptLabel.textContent = label;
      promptHint.textContent = hint;
      promptEl.hidden = false;
    },
    clearPrompt() { promptEl.hidden = true; },
    toast(text, ms = 2200) {
      toastEl.textContent = text;
      toastEl.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
    },
    setLoading(p) {
      if (p == null) { loading.hidden = true; return; }
      loading.hidden = false;
      loadFill.style.width = `${Math.round(p * 100)}%`;
      if (p >= 1) loadHint.textContent = 'Ready. Walk with WASD or the arrow keys.';
    },
    showPause(on) { pause.hidden = !on; },
    onResume(fn) { $('resume').addEventListener('click', fn); },
    setControls(rows) {
      const dl = $('controls');
      dl.replaceChildren();
      for (const [k, v] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        dl.append(dt, dd);
      }
    },
    showFallback() {
      loading.hidden = true;
      fallback.hidden = false;
    },
  };
}
