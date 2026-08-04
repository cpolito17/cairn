/**
 * Theme resolution and persistence. PROJECT-SPEC.md §8.2, §8.5; V2 §5.
 *
 * Eight themes, four dark and four light, chosen from a dropdown in the
 * settings sheet. There is no cycle any more: four themes could be walked past
 * in three taps, eight cannot, and a control whose only affordance is "next"
 * stops being a chooser somewhere around the fifth entry.
 *
 * The choice is **per context**: Personal and Work each hold their own theme
 * and each is stored under its own key, so the theme becomes part of what
 * distinguishes the two tabs rather than a single app-wide setting. Switching
 * tabs re-applies that tab's theme; changing the theme in one leaves the other
 * exactly as it was.
 *
 * It stays in `localStorage` rather than moving into the `settings` document
 * the Worker now holds, for one reason: it has to apply before the first paint.
 * A value that arrives with `GET /api/state` arrives several hundred
 * milliseconds after the login screen has already been painted in the wrong
 * palette, and there is no amount of care on the client that fixes that.
 *
 * A context with no stored choice gets `DEFAULT_THEME` — Ocean. The app used to
 * follow `prefers-color-scheme` until the user chose; it no longer does, and
 * that is the point of having a named default. Ocean is neither of the two
 * things the OS can ask for, so honouring the OS would mean the stated default
 * never actually appeared for anyone whose system had an opinion, which is
 * everyone. A stored value remains an *override*: nothing writes to it on boot,
 * and its absence is meaningful.
 *
 * `data-theme` on `<html>` is the only thing that flips the tokens, so it is
 * set from module scope rather than from an effect: an effect runs after the
 * first paint, which is exactly one frame of the wrong theme.
 */

import type { Context } from '../../shared/types';

/** Every theme that exists, and the only source of truth for how many there are. */
export const THEMES = [
  'ocean',
  'dark',
  'monokai-dark',
  'dusk',
  'light',
  'forest',
  'monokai-light',
  'slate',
] as const;

export type Theme = (typeof THEMES)[number];

/**
 * What a context looks like before the user has chosen. Kept in step with the
 * `:root` block in tokens.css and with `data-theme` in index.html, which is
 * what makes the first paint — the login screen — already correct.
 */
export const DEFAULT_THEME: Theme = 'ocean';

/** What a theme is called in the dropdown. */
export const THEME_LABELS: Record<Theme, string> = {
  ocean: 'Ocean',
  dark: 'Dark',
  'monokai-dark': 'Monokai Dark',
  dusk: 'Dusk',
  light: 'Light',
  forest: 'Forest',
  'monokai-light': 'Monokai Light',
  slate: 'Slate',
};

/**
 * The dropdown's two groups, in order (V2 §5.1). Deriving these from a
 * `register` field on each theme would be the same list written twice; this is
 * the list, and the dropdown renders it directly.
 */
export const THEME_GROUPS: readonly { label: string; themes: readonly Theme[] }[] = [
  { label: 'Dark', themes: ['ocean', 'dark', 'monokai-dark', 'dusk'] },
  { label: 'Light', themes: ['light', 'forest', 'monokai-light', 'slate'] },
];

export interface ThemeSwatch {
  bg: string;
  accent: string;
}

/**
 * Each theme's `--bg` and `--accent`, as JavaScript values.
 *
 * The split swatch has to paint a theme that is *not* the applied one, so it
 * cannot read these from CSS: `var(--bg)` inside the dropdown resolves to the
 * active theme's background for every row. Mounting a hidden `[data-theme]`
 * element and reading `getComputedStyle` off it would technically work and is
 * ruled out by V2 §5.1 — it forces a synchronous style recalculation per row on
 * every open to recover values that were known at build time.
 *
 * So this is a hand-maintained mirror of tokens.css. `Record<Theme, …>` keeps it
 * honest about *coverage* — a ninth theme fails to compile until it appears
 * here — but nothing can typecheck the hex values themselves. Changing a `--bg`
 * or an `--accent` there means changing it here, in the same commit.
 */
export const THEME_SWATCHES: Record<Theme, ThemeSwatch> = {
  ocean: { bg: '#071219', accent: '#38bdf8' },
  dark: { bg: '#0b0b0c', accent: '#ff8a3d' },
  'monokai-dark': { bg: '#1b1c18', accent: '#66d9ef' },
  dusk: { bg: '#100e17', accent: '#a78bfa' },
  light: { bg: '#fafaf9', accent: '#d9611c' },
  forest: { bg: '#f6f7f1', accent: '#2f7d4f' },
  'monokai-light': { bg: '#faf9f2', accent: '#0f7285' },
  slate: { bg: '#f5f7fa', accent: '#3b4cc0' },
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

/** A context's override if it has one, otherwise the default. */
export function initialTheme(context: Context): Theme {
  return readStoredTheme(context) ?? DEFAULT_THEME;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
