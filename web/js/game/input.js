// Input: keyboard, Gamepad API and on-screen touch buttons, merged into one
// small set of actions. Presses are latched as edges so a tap shorter than a
// simulation step is never lost, and released only after the simulation has
// consumed them.

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowDown: 'down', KeyS: 'down',
  ArrowUp: 'jump', KeyW: 'jump', Space: 'jump', KeyZ: 'jump', KeyK: 'jump',
  KeyX: 'pulse', KeyJ: 'pulse', Enter: 'pulse', NumpadEnter: 'pulse',
};

const ACTIONS = ['left', 'right', 'down', 'jump', 'pulse'];

export class Input {
  constructor() {
    this.keys = new Map(); // action → number of sources holding it
    this.held = new Set(); // key codes currently down
    this.touch = new Set();
    this.pad = new Set();
    this.presses = { jump: 0, pulse: 0 };
    this.enabled = false; // only while flying; menus own the keyboard otherwise
    this.onPause = null;
    this.onMute = null;
    this.padPrev = [];
    this.padMenu = null; // (action) => void, for gamepad navigation in overlays
    this.lastDevice = 'keyboard';

    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => this.keyup(e));
    window.addEventListener('blur', () => this.clear());
  }

  isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  keydown(e) {
    if (this.isTyping(e)) return;
    if (e.code === 'KeyM' && !e.repeat) {
      this.onMute?.();
      return;
    }
    if ((e.code === 'KeyP' || e.code === 'Escape') && !e.repeat) {
      if (this.onPause?.(e)) e.preventDefault();
      return;
    }
    if (!this.enabled) return;
    const action = KEYMAP[e.code];
    if (!action) return;
    e.preventDefault();
    this.lastDevice = 'keyboard';
    if (this.held.has(e.code)) return;
    this.held.add(e.code);
    if (action === 'jump' || action === 'pulse') this.presses[action]++;
  }

  keyup(e) {
    this.held.delete(e.code);
  }

  clear() {
    this.held.clear();
    this.touch.clear();
    this.pad.clear();
    this.presses.jump = 0;
    this.presses.pulse = 0;
  }

  /** Touch buttons call these with an action name. */
  touchDown(action) {
    if (!this.touch.has(action) && (action === 'jump' || action === 'pulse')) this.presses[action]++;
    this.touch.add(action);
    this.lastDevice = 'touch';
  }

  touchUp(action) {
    this.touch.delete(action);
  }

  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const now = new Set();
    let gp = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) {
      this.pad.clear();
      return;
    }
    const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const ax = gp.axes[0] || 0;
    const ay = gp.axes[1] || 0;
    if (ax < -0.4 || b(14)) now.add('left');
    if (ax > 0.4 || b(15)) now.add('right');
    if (ay > 0.55 || b(13)) now.add('down');
    if (ay < -0.55 || b(12)) now.add('up');
    if (b(0)) now.add('jump');
    if (b(2) || b(1)) now.add('pulse');
    if (b(9)) now.add('start');
    const prev = this.padPrev;
    const edge = (a) => now.has(a) && !prev.includes(a);
    if (now.size) this.lastDevice = 'gamepad';
    if (edge('start')) this.onPause?.(null);
    if (this.enabled) {
      if (edge('jump')) this.presses.jump++;
      if (edge('pulse')) this.presses.pulse++;
    } else if (this.padMenu) {
      if (edge('up') || edge('left')) this.padMenu('prev');
      if (edge('down') || edge('right')) this.padMenu('next');
      if (edge('jump')) this.padMenu('activate');
      if (edge('pulse')) this.padMenu('back');
    }
    this.pad = now;
    this.padPrev = [...now];
  }

  isDown(action) {
    if (!this.enabled) return false;
    if (this.touch.has(action) || this.pad.has(action)) return true;
    for (const code of this.held) if (KEYMAP[code] === action) return true;
    return false;
  }

  /** Snapshot for one simulation step; consumes latched presses. */
  sample() {
    const s = {
      left: this.isDown('left'),
      right: this.isDown('right'),
      down: this.isDown('down'),
      jump: this.isDown('jump'),
      pulse: this.isDown('pulse'),
      jumpPressed: false,
      pulsePressed: false,
    };
    if (this.enabled) {
      if (this.presses.jump > 0) { s.jumpPressed = true; this.presses.jump--; }
      if (this.presses.pulse > 0) { s.pulsePressed = true; this.presses.pulse--; }
    } else {
      this.presses.jump = 0;
      this.presses.pulse = 0;
    }
    // A press that has already been released still counts as held for the
    // step that consumes it, so a quick tap gives a short hop, not nothing.
    if (s.jumpPressed) s.jump = true;
    return s;
  }
}

export { ACTIONS };
