// Block palette + color math for the world renderer and timeline marks.
// Colors are hand-picked to match the in-game textures at a glance, on a dark UI.

const clampByte = (v) => Math.min(255, Math.max(0, Math.round(v)));

function hexToRgb(hex) {
  let h = String(hex || '#888888').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => clampByte(v).toString(16).padStart(2, '0')).join('');
}

/** amt in [-1, 1]: negative darkens toward black, positive lightens toward white. */
export function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const target = amt >= 0 ? 255 : 0;
  const p = Math.abs(amt);
  return rgbToHex(r + (target - r) * p, g + (target - g) * p, b + (target - b) * p);
}

export function withAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgbToHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

export function normalizeBlock(name) {
  return String(name || 'air').replace(/^minecraft:/, '').trim();
}

/** The palette called out in the design brief, plus a few useful neighbours. */
export const BLOCK_PALETTE = {
  stone: '#8c8c8c',
  cobblestone: '#787878',
  smooth_stone: '#9a9a9a',
  andesite: '#8a8a8a',
  iron_block: '#d8d8d8',
  gold_block: '#f6d33c',
  redstone_block: '#d02a2a',
  emerald_block: '#29d67a',
  lapis_block: '#2f5bd6',
  diamond_block: '#5fe8e0',
  coal_block: '#1c1c1c',
  grass_block: '#58a83c',
  dirt: '#7a5230',
  sand: '#e0d6a8',
  oak_planks: '#9b6a3a',
  white_wool: '#eeeeee',
  black_wool: '#222222',
  gray_wool: '#8a8a8a',
  light_gray_wool: '#c8c8c8',
  purple_wool: '#8a3fd0',
  blue_wool: '#3c4bd0',
  red_wool: '#d02a2a',
  green_wool: '#3a7a3a',
  glass: '#a8e6ff',
  glowstone: '#ffd97a',
  quartz_block: '#ece6dc',
  obsidian: '#241a33',
  netherrack: '#6d2b2b',
  snow_block: '#f4fbff',
  water: '#3d6fd6',
  clay: '#a0a6b2',
  terracotta: '#a0522d',
};

/** Pick a color for any block id, deterministic for unknown ones. */
export function blockColor(name) {
  const n = normalizeBlock(name);
  if (BLOCK_PALETTE[n]) return BLOCK_PALETTE[n];
  // sensible family fallbacks before hashing
  if (n.endsWith('_wool')) {
    const base = n.slice(0, -5);
    if (base === 'light_blue') return '#7fd3e8';
    if (base === 'lime') return '#7dd63c';
    if (base === 'pink') return '#e88fb8';
    if (base === 'cyan') return '#2fb8b8';
    if (base === 'orange') return '#e0862c';
    if (base === 'yellow') return '#e8d040';
  }
  if (n.includes('glass')) return '#a8e6ff';
  if (n.endsWith('_block')) {
    let hsh = 0;
    for (let i = 0; i < n.length; i++) hsh = (hsh * 31 + n.charCodeAt(i)) >>> 0;
    return hslToHex(hsh % 360, 58, 58);
  }
  let hsh = 0;
  for (let i = 0; i < n.length; i++) hsh = (hsh * 33 + n.charCodeAt(i)) >>> 0;
  return hslToHex(hsh % 360, 42, 56);
}

export function isGlass(name) {
  return normalizeBlock(name).includes('glass');
}
