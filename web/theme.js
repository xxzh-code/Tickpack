// Theme + canvas palettes for the Tickpack web shell.
//
// Persistence flows through the host adapter (host.storageGet/Set); this module
// only decides *which* theme to use and applies it to <html data-theme>. The
// canvas renderers get plain palette objects from CANVAS_THEMES.

export const THEME_KEY = 'tickpack.theme';
export const THEMES = ['light', 'dark'];
export const THEME_COLORS = { light: '#eef1f4', dark: '#0b0f14' };

export function themeColor(theme) {
  return THEME_COLORS[theme === 'light' ? 'light' : 'dark'];
}

/** True when neither a stored preference nor ?theme= decides the theme. */
export function shouldFollowSystem(initial) {
  return !!(initial && initial.auto);
}

/**
 * @param {{storageGet:Function}} host
 * @param {string|null} forced  debug `?theme=light|dark` (never persisted)
 */
export function resolveInitialTheme(host, forced) {
  if (forced === 'light' || forced === 'dark') return { theme: forced, forced: true, auto: false };
  let saved = null;
  try {
    saved = host && typeof host.storageGet === 'function' ? host.storageGet(THEME_KEY) : null;
  } catch {
    saved = null;
  }
  if (saved === 'light' || saved === 'dark') return { theme: saved, forced: false, auto: false };
  const prefersLight = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: light)').matches;
  return { theme: prefersLight ? 'light' : 'dark', forced: false, auto: true };
}

export function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  const root = document.documentElement;
  root.dataset.theme = next;
  root.style.colorScheme = next;
  const meta = document.querySelector && document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', themeColor(next));
  return next;
}

export function persistTheme(host, theme) {
  try {
    if (host && typeof host.storageSet === 'function') host.storageSet(THEME_KEY, theme);
  } catch {
    /* persistence is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Canvas palettes (flat: solid fills, 1px strokes, no gradients/glows).
// ---------------------------------------------------------------------------
export const CANVAS_THEMES = {
  dark: {
    canvasBg: '#0d1117',
    canvasEdge: '#232c38',
    planeBg: '#0f141b',
    boardFill: 'rgba(255, 255, 255, 0.022)',
    boardEdge: 'rgba(148, 163, 184, 0.22)',
    grid: 'rgba(148, 163, 184, 0.10)',
    gridMajor: 'rgba(148, 163, 184, 0.17)',
    axis: 'rgba(45, 212, 191, 0.30)',
    label: '#7d8ea3',
    labelDim: '#5b6b7e',
    pen: '#2dd4bf',
    penInk: '#04211f',
    penRing: 'rgba(45, 212, 191, 0.55)',
    particle: '#e3b341',
    tileEdge: 'rgba(0, 0, 0, 0.42)',
    tileGloss: 'rgba(255, 255, 255, 0.16)',
    timeline: {
      rail: '#2a3441',
      ruler: '#64748b',
      rulerDim: '#475569',
      text: '#7d8ea3',
      textMuted: '#5b6b7e',
      playhead: '#2dd4bf',
      progress: '#2dd4bf',
      hover: 'rgba(226, 232, 240, 0.35)',
      tipBg: '#11161d',
      tipBorder: '#2a3441',
      tipText: '#e6edf3',
      end: '#e3b341',
    },
  },
  light: {
    canvasBg: '#ffffff',
    canvasEdge: '#d7dee6',
    planeBg: '#f8fafc',
    boardFill: 'rgba(15, 23, 42, 0.025)',
    boardEdge: 'rgba(15, 23, 42, 0.22)',
    grid: 'rgba(15, 23, 42, 0.08)',
    gridMajor: 'rgba(15, 23, 42, 0.14)',
    axis: 'rgba(15, 118, 110, 0.32)',
    label: '#475569',
    labelDim: '#64748b',
    pen: '#0f766e',
    penInk: '#ffffff',
    penRing: 'rgba(15, 118, 110, 0.45)',
    particle: '#b45309',
    tileEdge: 'rgba(15, 23, 42, 0.30)',
    tileGloss: 'rgba(255, 255, 255, 0.35)',
    timeline: {
      rail: '#cbd5e1',
      ruler: '#475569',
      rulerDim: '#64748b',
      text: '#475569',
      textMuted: '#64748b',
      playhead: '#0f766e',
      progress: '#0f766e',
      hover: 'rgba(15, 23, 42, 0.35)',
      tipBg: '#ffffff',
      tipBorder: '#cbd5e1',
      tipText: '#0f172a',
      end: '#b45309',
    },
  },
};

export function canvasTheme(theme) {
  return CANVAS_THEMES[theme === 'light' ? 'light' : 'dark'];
}
