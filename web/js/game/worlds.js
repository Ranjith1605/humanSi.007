// Per-world palettes shared by tiles, sprites, particles and the HUD accent.
// One world per gate, following the palette table in docs/ARCHITECTURE.md.

export const WORLDS = {
  crystal: {
    accent: '#ff7ae0',
    gem: ['#ffffff', '#ffb8f4', '#ff5fd6', '#b02aa8', '#4a0f52'],
    light: '#ff9cf0',
    ambient: { kind: 'motes', colors: ['#ff9cf0', '#c58bff', '#ffffff'], rate: 10 },
    music: { lead: 'pulse25', arp: 'pulse12', bass: 'triangle', swing: 0 },
  },
  rigs: {
    accent: '#ff5a4a',
    gem: ['#ffffff', '#ffe2a8', '#ffb547', '#c9661c', '#4a1e0a'],
    light: '#ffb070',
    ambient: { kind: 'sparks', colors: ['#ffcf7a', '#ff7a3a', '#ffffff'], rate: 7 },
    music: { lead: 'square', arp: 'pulse25', bass: 'pulse25', swing: 0 },
  },
  biodome: {
    accent: '#7dff8a',
    gem: ['#ffffff', '#c8ffd8', '#5dffa6', '#1f9e5a', '#0a3a22'],
    light: '#fff3b0',
    ambient: { kind: 'pollen', colors: ['#fff3b0', '#d8ff9a', '#ffffff'], rate: 9 },
    music: { lead: 'pulse25', arp: 'triangle', bass: 'triangle', swing: 0.12 },
  },
  datacity: {
    accent: '#66e1ff',
    gem: ['#ffffff', '#c8f6ff', '#66e1ff', '#1f7ab8', '#0a2242'],
    light: '#66e1ff',
    ambient: { kind: 'rain', colors: ['#7fd8ff', '#a8e8ff'], rate: 70 },
    music: { lead: 'pulse12', arp: 'pulse25', bass: 'square', swing: 0 },
  },
  engineering: {
    accent: '#ffb547',
    gem: ['#ffffff', '#fff0b8', '#ffcf3a', '#c98a12', '#4a2e06'],
    light: '#ffc870',
    ambient: { kind: 'embers', colors: ['#ffcf7a', '#ff9a3c', '#fff0c0'], rate: 8 },
    music: { lead: 'square', arp: 'pulse12', bass: 'pulse25', swing: 0.1 },
  },
  station: {
    accent: '#ffcf7a',
    gem: ['#ffffff', '#fff6dc', '#ffe08a', '#c99a2e', '#4a3410'],
    light: '#fff0c8',
    ambient: { kind: 'twinkle', colors: ['#ffffff', '#ffe9b0', '#bfe6ff'], rate: 6 },
    music: { lead: 'pulse25', arp: 'triangle', bass: 'triangle', swing: 0 },
  },
};

export function worldOf(id) {
  return WORLDS[id] || WORLDS.crystal;
}
