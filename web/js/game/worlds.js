// Per-world palettes shared by tiles, sprites, particles and the HUD accent.
// One world per gate, following the palette table in docs/ARCHITECTURE.md.

export const WORLDS = {
  crystal: {
    accent: '#ff7ae0',
    // Gems use a colour that contrasts with the world, so they never blend in.
    gem: ['#ffffff', '#fff3b0', '#ffd64a', '#c98a12', '#4a2a06'],
    light: '#ff9cf0',
    ambient: { kind: 'motes', colors: ['#ff9cf0', '#c58bff', '#ffffff'], rate: 10 },
  },
  rigs: {
    accent: '#ff5a4a',
    gem: ['#ffffff', '#ffe2a8', '#ffb547', '#c9661c', '#4a1e0a'],
    light: '#ffb070',
    ambient: { kind: 'sparks', colors: ['#ffcf7a', '#ff7a3a', '#ffffff'], rate: 7 },
  },
  biodome: {
    accent: '#7dff8a',
    gem: ['#ffffff', '#ffd0c0', '#ff6a4a', '#b8261e', '#4a0a0a'],
    light: '#fff3b0',
    ambient: { kind: 'pollen', colors: ['#fff3b0', '#d8ff9a', '#ffffff'], rate: 9 },
  },
  datacity: {
    accent: '#66e1ff',
    gem: ['#ffffff', '#ffd0f4', '#ff6bd5', '#b02aa8', '#4a0f52'],
    light: '#66e1ff',
    ambient: { kind: 'rain', colors: ['#7fd8ff', '#a8e8ff'], rate: 70 },
  },
  engineering: {
    accent: '#ffb547',
    gem: ['#ffffff', '#c8f6ff', '#66e1ff', '#1f7ab8', '#0a2242'],
    light: '#ffc870',
    ambient: { kind: 'embers', colors: ['#ffcf7a', '#ff9a3c', '#fff0c0'], rate: 8 },
  },
  station: {
    accent: '#ffcf7a',
    gem: ['#ffffff', '#fff6dc', '#ffe08a', '#c99a2e', '#4a3410'],
    light: '#fff0c8',
    ambient: { kind: 'twinkle', colors: ['#ffffff', '#ffe9b0', '#bfe6ff'], rate: 6 },
  },
};

export function worldOf(id) {
  return WORLDS[id] || WORLDS.crystal;
}
