/**
 * Collapse state that survives a reload. PROJECT-SPEC.md §6.5, §6.7.
 *
 * Two surfaces collapse and both have to remember: Up Next per context, the
 * Completed group per board. That is the same behaviour twice, so it is written
 * once — the key is the only difference.
 *
 * Reads are lazy (the initializer runs on mount, not on every render) and every
 * storage call is guarded: private-mode Safari throws on `localStorage`, and
 * losing persistence must not lose the collapse itself.
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

export const upNextKey = (context: string): string => `cairn:collapse:upnext:${context}`;
export const completedKey = (boardId: string): string => `cairn:collapse:completed:${boardId}`;
