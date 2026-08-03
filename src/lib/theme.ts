/**
 * Theme resolution and persistence. PROJECT-SPEC.md §8.2, §8.5.
 *
 * The rule is a two-stage one: follow `prefers-color-scheme` until the user
 * picks a theme, then let that pick win forever after. So the stored value is
 * an *override*, not a cache of the current theme — nothing writes to it on
 * boot, and its absence is meaningful.
 *
 * `data-theme` on `<html>` is the only thing that flips the tokens, so it is
 * set from module scope rather than from an effect: an effect runs after the
 * first paint, which is exactly one frame of the wrong theme.
 */

export type Theme = 'dark' | 'light';

const KEY = 'cairn:theme';

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

/** The user's override, or null while they have never chosen one. */
export function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    // Private-mode storage denial degrades to "no override", not to a crash.
    return null;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Same: the theme still applies for this session, it just will not persist.
  }
}

export function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** The override if there is one, otherwise the system preference. */
export function initialTheme(): Theme {
  return readStoredTheme() ?? systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * Watch the OS preference. The callback fires only while no override exists —
 * once the user has chosen, the system flipping is not their instruction.
 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const listener = (event: MediaQueryListEvent) => {
    if (readStoredTheme() !== null) return;
    onChange(event.matches ? 'light' : 'dark');
  };
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
