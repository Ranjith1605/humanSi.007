// WebAudio chiptune. Each world has a short looping theme built by a tiny
// step sequencer (bass, arpeggio, a lead line and drums) from the level's
// `music: { bpm, key }`, plus synthesised sound effects. Nothing plays until
// the first user gesture, M mutes, and the choice is remembered.

const MUTE_KEY = 'humansi.nova.muted';
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** "F#m", "A minor", "Eb", "C major" → { root: semitone, minor } */
export function parseKey(key) {
  const m = /^\s*([A-Ga-g])([#b♯♭]?)\s*(.*)$/.exec(String(key || 'C'));
  if (!m) return { root: 0, minor: false };
  let root = NOTE[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') root += 1;
  if (m[2] === 'b' || m[2] === '♭') root -= 1;
  const rest = m[3].toLowerCase();
  const minor = /^(m(?!aj)|min|minor)/.test(rest);
  return { root: (root + 12) % 12, minor };
}

const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Per-world arrangement: chord progression (scale degrees), patterns and voices.
const STYLE = {
  crystal: { prog: [0, 5, 2, 6], bass: 'x...x.x.x...x.x.', arp: 'updown', lead: 'x..x..x.x...x.x.', kick: 'x.......x.......', snare: '....x.......x...', hat: '..x...x...x...x.', waves: ['pulse25', 'pulse12', 'triangle'] },
  rigs: { prog: [0, 0, 5, 6], bass: 'x.x.x.x.x.x.x.x.', arp: 'up', lead: 'x...x.x...x.x.x.', kick: 'x...x...x...x...', snare: '....x.......x..x', hat: 'x.x.x.x.x.x.x.x.', waves: ['square', 'pulse25', 'pulse25'] },
  biodome: { prog: [0, 4, 5, 3], bass: 'x..x..x.x..x..x.', arp: 'broken', lead: 'x.x...x.x.x.x...', kick: 'x.....x...x.....', snare: '....x.......x...', hat: '..x...x...x...xx', waves: ['pulse25', 'triangle', 'triangle'] },
  datacity: { prog: [0, 3, 5, 4], bass: 'x..x..x...x..x..', arp: 'up', lead: '..x.x..x..x.x...', kick: 'x.........x.....', snare: '....x.......x...', hat: 'xxx.xxx.xxx.xxx.', waves: ['pulse12', 'pulse25', 'square'] },
  engineering: { prog: [0, 6, 5, 4], bass: 'x.xx..x.x.xx..x.', arp: 'down', lead: 'x...x..x..x.x...', kick: 'x..x....x..x....', snare: '....x.......x...', hat: 'x.xxx.xxx.xxx.xx', waves: ['square', 'pulse12', 'pulse25'] },
  station: { prog: [0, 5, 3, 4], bass: 'x.......x...x...', arp: 'updown', lead: 'x.....x.x...x...', kick: 'x.......x.......', snare: '........x.......', hat: '..x...x...x...x.', waves: ['pulse25', 'triangle', 'triangle'] },
};

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try { this.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* storage blocked: default on */ }
    this.theme = null;
    this.timer = null;
    this.waves = {};
    this.glideT = 0;
    this.listeners = [];
  }

  /** Must be called from a user gesture handler. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.34;
    this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.7;
    this.sfxBus.connect(this.master);
    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    for (const duty of [0.125, 0.25]) {
      const n = 32;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let k = 1; k < n; k++) {
        real[k] = Math.sin(2 * Math.PI * k * duty) / (k * Math.PI);
        imag[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (k * Math.PI);
      }
      this.waves[duty === 0.125 ? 'pulse12' : 'pulse25'] = ctx.createPeriodicWave(real, imag);
    }
    if (this.pendingTheme) {
      const t = this.pendingTheme;
      this.pendingTheme = null;
      this.playTheme(t.world, t.music);
    }
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setMuted(m) {
    this.muted = !!m;
    try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* best effort */ }
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.02);
    for (const fn of this.listeners) fn(this.muted);
  }

  toggleMute() {
    this.setMuted(!this.muted);
  }

  onMuteChange(fn) {
    this.listeners.push(fn);
  }

  osc(type, freq, t0) {
    const o = this.ctx.createOscillator();
    if (this.waves[type]) o.setPeriodicWave(this.waves[type]);
    else o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    return o;
  }

  /** One enveloped note. */
  tone(type, freq, t0, dur, vol, bus, opts = {}) {
    const ctx = this.ctx;
    const o = this.osc(type, freq, t0);
    const g = ctx.createGain();
    const a = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol * (opts.sustain ?? 0.5)), t0 + a + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(opts.slide, t0 + (opts.slideT ?? dur));
    if (opts.vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = opts.vibrato;
      lg.gain.value = freq * 0.02;
      lfo.connect(lg);
      lg.connect(o.frequency);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.05);
    }
    o.connect(g);
    g.connect(bus);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  noise(t0, dur, vol, bus, filter = 'highpass', freq = 6000, q = 0.7, slideTo) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 1;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t0);
    if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(bus);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.02);
  }

  // -------------------------------------------------------------- music ----

  playTheme(world, music) {
    if (!this.ctx) {
      this.pendingTheme = { world, music };
      return;
    }
    this.stopTheme();
    const style = STYLE[world] || STYLE.crystal;
    const { root, minor } = parseKey(music?.key);
    const bpm = Math.min(200, Math.max(70, Number(music?.bpm) || 128));
    const scale = minor ? MINOR : MAJOR;
    const rnd = seeded(world.length * 131 + root * 7 + bpm);
    // A two-bar lead motif expressed as chord-tone indices, reused per chord.
    const motif = [];
    for (let i = 0; i < 16; i++) motif.push(Math.floor(rnd() * 5));
    const motifB = motif.map((v, i) => (i > 9 ? (v + 2) % 6 : v));
    this.theme = {
      world, style, root, scale, bpm,
      step: 0,
      next: this.ctx.currentTime + 0.08,
      motif, motifB,
      paused: false,
    };
    this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicBus.gain.setValueAtTime(0.34, this.ctx.currentTime);
    this.timer = setInterval(() => this.schedule(), 25);
  }

  stopTheme() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.theme = null;
  }

  pauseTheme(paused) {
    if (!this.theme || !this.ctx) return;
    this.theme.paused = paused;
    this.musicBus.gain.setTargetAtTime(paused ? 0.0001 : 0.34, this.ctx.currentTime, 0.05);
    if (!paused) this.theme.next = this.ctx.currentTime + 0.05;
  }

  /** Fade the music down (gate overlays) without stopping the loop. */
  duck(on) {
    if (!this.ctx || !this.theme) return;
    this.musicBus.gain.setTargetAtTime(on ? 0.12 : 0.34, this.ctx.currentTime, 0.2);
  }

  degreeNote(deg, octave) {
    const th = this.theme;
    const n = th.scale.length;
    const o = Math.floor(deg / n);
    const i = ((deg % n) + n) % n;
    return 12 * (octave + o + 1) + th.root + th.scale[i];
  }

  schedule() {
    const th = this.theme;
    if (!th || th.paused || !this.ctx) return;
    const ctx = this.ctx;
    const stepDur = 60 / th.bpm / 4;
    if (th.next < ctx.currentTime - 0.2) th.next = ctx.currentTime + 0.02;
    while (th.next < ctx.currentTime + 0.14) {
      this.playStep(th, th.step, th.next, stepDur);
      th.next += stepDur;
      th.step = (th.step + 1) % 128;
    }
  }

  playStep(th, step, t, sd) {
    const st = th.style;
    const s16 = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const half = step >= 64;
    const deg = st.prog[bar];
    const [leadW, arpW, bassW] = st.waves;
    const bus = this.musicBus;
    const swingT = st.swing && s16 % 2 === 1 ? sd * st.swing : 0;
    const tt = t + swingT;

    if (st.bass[s16] === 'x') {
      const oct = s16 % 4 === 2 && st.bass === STYLE.rigs.bass ? 3 : 2;
      this.tone(bassW, mtof(this.degreeNote(deg, oct)), tt, sd * 1.7, 0.32, bus, { sustain: 0.6 });
    }
    // Arpeggio over the chord (degree, +2, +4), climbing an octave.
    const chord = [deg, deg + 2, deg + 4, deg + 7];
    let ai;
    if (st.arp === 'up') ai = s16 % 4;
    else if (st.arp === 'down') ai = 3 - (s16 % 4);
    else if (st.arp === 'updown') ai = [0, 1, 2, 3, 2, 1][s16 % 6];
    else ai = [0, 2, 1, 3][s16 % 4];
    this.tone(arpW, mtof(this.degreeNote(chord[ai], 4)), tt, sd * 0.8, 0.07, bus, { sustain: 0.3 });

    // Lead: the motif on chord tones, second half varied.
    if (st.lead[s16] === 'x' && (bar % 2 === 0 || half)) {
      const m = (half ? th.motifB : th.motif)[(s16 + (bar % 2) * 8) % 16];
      const tones = [deg, deg + 2, deg + 4, deg + 7, deg + 9, deg + 5];
      this.tone(leadW, mtof(this.degreeNote(tones[m], 5)), tt, sd * 2.2, 0.085, bus, { sustain: 0.55, vibrato: 5.5 });
    }

    // Drums.
    if (st.kick[s16] === 'x') {
      this.tone('sine', 150, tt, 0.16, 0.6, bus, { slide: 42, slideT: 0.12, sustain: 0.3 });
    }
    if (st.snare[s16] === 'x') {
      this.noise(tt, 0.12, 0.28, bus, 'bandpass', 1800, 0.8);
      this.tone('triangle', 190, tt, 0.07, 0.12, bus, { slide: 120 });
    }
    if (st.hat[s16] === 'x') this.noise(tt, s16 % 4 === 2 ? 0.06 : 0.03, 0.09, bus, 'highpass', 7500);
  }

  // ---------------------------------------------------------------- sfx ----

  sfx(name, opt = {}) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + 0.005;
    const b = this.sfxBus;
    switch (name) {
      case 'jump':
        this.tone('pulse25', 300, t, 0.12, 0.18, b, { slide: 680, slideT: 0.09 });
        break;
      case 'glide':
        this.noise(t, 0.07, 0.07, b, 'bandpass', 900 + Math.random() * 400, 2);
        this.tone('pulse12', 110 + Math.random() * 20, t, 0.05, 0.05, b);
        break;
      case 'land':
        this.noise(t, 0.07, 0.12 * Math.min(1, (opt.impact || 10) / 18), b, 'lowpass', 500);
        break;
      case 'spring':
        this.tone('triangle', 220, t, 0.32, 0.3, b, { slide: 980, slideT: 0.22, vibrato: 18 });
        break;
      case 'boost':
        this.noise(t, 0.22, 0.16, b, 'bandpass', 500, 1.2, 3200);
        this.tone('pulse25', 400, t, 0.18, 0.08, b, { slide: 1200 });
        break;
      case 'gem': {
        const pent = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31];
        const n = 79 + pent[Math.min(pent.length - 1, opt.streak || 0)];
        this.tone('pulse12', mtof(n), t, 0.09, 0.14, b);
        this.tone('pulse12', mtof(n + 7), t + 0.05, 0.14, 0.11, b);
        break;
      }
      case 'pod-link': {
        const n = 76 + Math.min(12, (opt.streak || 0) * 2);
        this.tone('triangle', mtof(n), t, 0.12, 0.22, b);
        this.tone('triangle', mtof(n + 4), t + 0.06, 0.12, 0.2, b);
        this.tone('triangle', mtof(n + 7), t + 0.12, 0.2, 0.2, b);
        break;
      }
      case 'pod-start':
        this.tone('triangle', mtof(76), t, 0.16, 0.2, b);
        break;
      case 'pod-break':
        this.tone('square', 180, t, 0.25, 0.14, b, { slide: 110 });
        this.tone('square', 190, t, 0.25, 0.1, b, { slide: 116 });
        break;
      case 'shortcut':
        this.tone('pulse25', 880, t, 0.08, 0.16, b);
        this.tone('pulse25', 830, t + 0.08, 0.1, 0.14, b);
        this.tone('square', 220, t + 0.16, 0.3, 0.14, b, { slide: 90 });
        break;
      case 'scan':
        [0, 4, 7, 12].forEach((k, i) => this.tone('triangle', mtof(72 + k), t + i * 0.07, 0.2, 0.2, b));
        break;
      case 'tick':
        this.tone('sine', 1200 + (opt.p || 0) * 800, t, 0.03, 0.04, b);
        break;
      case 'assist':
        [0, 4, 7, 12, 16].forEach((k, i) => this.tone('pulse25', mtof(67 + k), t + i * 0.06, 0.18, 0.13, b));
        this.noise(t + 0.3, 0.4, 0.05, b, 'highpass', 9000);
        break;
      case 'review':
        this.tone('square', 660, t, 0.08, 0.1, b);
        this.tone('square', 990, t + 0.09, 0.16, 0.1, b);
        break;
      case 'calm':
        this.tone('sine', mtof(84), t, 0.5, 0.18, b, { sustain: 0.4 });
        this.tone('sine', mtof(91), t + 0.05, 0.45, 0.1, b, { sustain: 0.4 });
        this.tone('triangle', mtof(79), t + 0.1, 0.5, 0.12, b);
        break;
      case 'stun':
        this.tone('square', 900, t, 0.16, 0.12, b, { slide: 180 });
        this.noise(t, 0.1, 0.1, b, 'highpass', 3000);
        break;
      case 'pulse':
        this.tone('sine', 420, t, 0.3, 0.2, b, { slide: 1500, slideT: 0.25, vibrato: 24 });
        this.tone('triangle', 840, t + 0.02, 0.25, 0.08, b, { slide: 2400, slideT: 0.2 });
        break;
      case 'hurt':
        this.noise(t, 0.18, 0.3, b, 'lowpass', 1800);
        this.tone('square', 320, t, 0.25, 0.18, b, { slide: 90 });
        break;
      case 'fall':
        this.tone('triangle', 700, t, 0.5, 0.2, b, { slide: 120, slideT: 0.45 });
        break;
      case 'checkpoint':
        [0, 7, 12].forEach((k, i) => this.tone('pulse25', mtof(74 + k), t + i * 0.08, 0.18, 0.13, b));
        break;
      case 'crumble':
        this.noise(t, 0.2, 0.12, b, 'bandpass', 700, 1);
        break;
      case 'secret':
        [0, 3, 7, 10, 14].forEach((k, i) => this.tone('pulse12', mtof(72 + k), t + i * 0.07, 0.16, 0.12, b));
        break;
      case 'bonk':
        this.tone('square', 160, t, 0.06, 0.1, b);
        break;
      case 'gate':
        [0, 4, 7, 12, 16, 19, 24].forEach((k, i) => this.tone('pulse25', mtof(64 + k), t + i * 0.06, 0.24, 0.14, b));
        this.tone('triangle', mtof(52), t + 0.42, 0.8, 0.25, b);
        break;
      case 'select':
        this.tone('pulse12', 880, t, 0.05, 0.08, b);
        break;
      case 'confirm':
        this.tone('pulse25', 660, t, 0.07, 0.1, b);
        this.tone('pulse25', 990, t + 0.06, 0.1, 0.1, b);
        break;
      case 'correct':
        [0, 4, 7, 12].forEach((k, i) => this.tone('pulse25', mtof(72 + k), t + i * 0.07, 0.2, 0.13, b));
        break;
      case 'wrong':
        this.tone('triangle', mtof(62), t, 0.2, 0.2, b);
        this.tone('triangle', mtof(57), t + 0.16, 0.35, 0.2, b);
        break;
      case 'over':
        [12, 7, 3, 0].forEach((k, i) => this.tone('triangle', mtof(60 + k), t + i * 0.16, 0.3, 0.2, b));
        break;
      case 'launch':
        [0, 7, 12, 16, 19, 24].forEach((k, i) => this.tone('pulse25', mtof(60 + k), t + i * 0.12, 0.5, 0.12, b, { vibrato: 6 }));
        this.noise(t, 1.6, 0.08, b, 'lowpass', 400, 0.7, 3000);
        break;
      default:
        break;
    }
  }
}
