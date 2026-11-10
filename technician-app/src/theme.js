// Light, dark or follow the system. Stored in localStorage; applied as data-mode on <html>,
// which the token file keys on.
const KEY = 'support.theme';
export const THEMES = ['light', 'dark', 'system'];

export function loadTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : 'system';
  } catch (_) {
    return 'system';
  }
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch (_) {
    // no storage: the choice lasts until the app closes
  }
}

export function resolveMode(theme, prefersDark) {
  return theme === 'dark' || (theme === 'system' && prefersDark) ? 'dark' : 'light';
}

// Applies the theme now and when the system's choice changes. Returns a function that stops listening.
export function applyTheme(theme, root = document.documentElement, media = window.matchMedia?.('(prefers-color-scheme: dark)')) {
  const set = () => {
    root.dataset.mode = resolveMode(theme, !!media?.matches);
  };
  set();
  if (theme !== 'system' || !media?.addEventListener) return () => {};
  media.addEventListener('change', set);
  return () => media.removeEventListener('change', set);
}
