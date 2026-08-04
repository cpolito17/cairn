/**
 * Theme resolution and persistence. PROJECT-SPEC.md §8.2, §8.5.
 *
 * There are four themes, cycled from the overflow menu. Two of them — Dark and
 * Light — are also what `prefers-color-scheme` can resolve to, which is why
 * `systemTheme()` is narrower than `Theme`: the OS has an opinion about light
 * versus dark and none at all about Ocean versus Forest.
 *
 * The choice is **per context**: Personal and Work each hold their own theme
 * and each is stored under its own key, so the theme becomes part of what
 * distinguishes the two tabs rather than a single app-wide setting. Switching
 * tabs re-applies that tab's theme; changing the theme in one leaves the other
 * exactly as it was.
 *
 * The rule is otherwise a two-stage one, and it is per context too: a context
 * follows `prefers-color-scheme` until the user picks a theme *in that
 * context*, then that pick wins forever after. So a stored value is an
 * *override*, not a cache of the current theme — nothing writes to it on boot,
 * and its absence is meaningful.
 *
 * `data-theme` on `<html>` is the only thing that flips the tokens, so it is
 * set from module scope rather than from an effect: an effect runs after the
 * first paint, which is exactly one frame of the wrong theme.
 */

import type { Context } from '../../shared/types';

/** The cycle order, and the only source of truth for how many themes exist. */
export const THEMES = ['dark', 'light', 'ocean', 'forest'] as const;

export type Theme = (typeof THEMES)[number];

/** What a theme is called in the menu. */
export const THEME_LABELS: Record<Theme, string> = {
  dark: 'Dark',
  light: 'Light',
  ocean: 'Ocean',
  forest: 'Forest',
};

const keyFor = (context: Context): string => `cairn:theme:${context}`;

/**
 * The pre-split key. It is read as a fallback so an existing install keeps the
 * theme it had — in both contexts — instead of snapping back to the system
 * preference the first time the app loads after the split. It is never written.
 */
const LEGACY_KEY = 'cairn:theme';

function isTheme(value: unknown): value is Theme {
  return THEMES.includes(value as Theme);
}

/** The next theme in the cycle, wrapping at the end. */
export function nextTheme(theme: Theme): Theme {
  const at = THEMES.indexOf(theme);
  // An unrecognised current theme lands on the first one rather than throwing.
  return THEMES[(at + 1) % THEMES.length] ?? THEMES[0];
}

/** This context's override, or null while the user has never chosen one in it. */
export function readStoredTheme(context: Context): Theme | null {
  try {
    const stored = localStorage.getItem(keyFor(context)) ?? localStorage.getItem(LEGACY_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    // Private-mode storage denial degrades to "no override", not to a crash.
    return null;
  }
}

export function storeTheme(context: Context, theme: Theme): void {
  try {
    localStorage.setItem(keyFor(context), theme);
  } catch {
    // Same: the theme still applies for this session, it just will not persist.
  }
}

export function systemTheme(): Extract<Theme, 'dark' | 'light'> {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** A context's override if it has one, otherwise the system preference. */
export function initialTheme(context: Context): Theme {
  return readStoredTheme(context) ?? systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/**
 * Watch the OS preference and report it.
 *
 * Whether the report is *acted* on belongs to the store rather than here: the
 * "only while no override exists" rule is now per context, and the context is
 * the store's to know. See `followSystemTheme`.
 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const listener = (event: MediaQueryListEvent) => {
    onChange(event.matches ? 'light' : 'dark');
  };
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
