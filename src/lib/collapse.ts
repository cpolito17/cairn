/**
 * The small per-surface view preferences that survive a reload.
 * PROJECT-SPEC.md §6.5, §6.7.
 *
 * Three of them now: Up Next's collapse per context, the Completed group's per
 * board, and how many rows Up Next is grown to per context. That is the same
 * behaviour three times, so it is written once — the key is the only
 * difference.
 *
 * **These stay in `localStorage` rather than the server settings document**,
 * unlike working hours. The rule is the one V2 §2 drew for the theme: a
 * preference that has to be right before the first paint cannot wait on a
 * fetch, and a strip that renders at one height and then jumps to another when
 * `/api/state` lands is exactly the jarring change §8.5 exists to prevent. It
 * also means these are per device, which is the honest reading of "how much of
 * this do I want on screen" — a phone and a desktop are not asking the same
 * question.
 *
 * Reads are lazy (the initializer runs on mount, not on every render) and every
 * storage call is guarded: private-mode Safari throws on `localStorage`, and
 * losing persistence must not lose the state itself.
 */

import { useCallback, useState } from 'react';

function read(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === '1';
  } catch {
    return fallback;
  }
}

function write(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Storage denial costs persistence, not the toggle.
  }
}

/** `[collapsed, toggle]` for `key`, persisted across reloads. */
export function usePersistedCollapse(
  key: string,
  defaultCollapsed = false,
): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => read(key, defaultCollapsed));

  const toggle = useCallback(() => {
    setCollapsed((was) => {
      write(key, !was);
      return !was;
    });
  }, [key]);

  return [collapsed, toggle];
}

/**
 * `[value, set]` for an integer preference clamped to `[min, max]`, persisted.
 *
 * The clamp is applied on read as well as on write, so a stored value from a
 * build with a different ceiling — or a hand-edited one — lands inside the
 * range rather than rendering a strip nothing can shrink.
 */
export function usePersistedCount(
  key: string,
  fallback: number,
  min: number,
  max: number,
): [number, (next: number) => void] {
  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, Math.round(value))),
    [min, max],
  );

  const [count, setCount] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      const parsed = stored === null ? Number.NaN : Number(stored);
      return Number.isFinite(parsed) ? clamp(parsed) : fallback;
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (next: number) => {
      const value = clamp(next);
      setCount(value);
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // Storage denial costs persistence, not the change.
      }
    },
    [key, clamp],
  );

  return [count, set];
}

export const upNextKey = (context: string): string => `cairn:collapse:upnext:${context}`;
export const completedKey = (boardId: string): string => `cairn:collapse:completed:${boardId}`;
export const upNextRowsKey = (context: string): string => `cairn:rows:upnext:${context}`;
