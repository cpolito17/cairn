/**
 * Destination preservation across a forced logout. PROJECT-SPEC.md §6.1.
 *
 * When any request comes back 401 the client records where the user was trying
 * to be; the login screen consumes it after a successful unlock and goes there
 * instead of the default home. `sessionStorage` is the right store: it is
 * per-tab and dies with the tab, so a stale destination cannot resurface days
 * later in a different window.
 *
 * The router lands in a later issue. This module is the whole of the contract
 * until then.
 */

const KEY = 'cairn:redirect';

/**
 * Remember a path to return to. Only same-origin absolute paths are kept — a
 * value that survives to a `navigate()` call must not be able to point off-site.
 */
export function setRedirect(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//')) return;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    // Private-mode storage denial is not worth failing a login over.
  }
}

/** Read and clear the stored path. Null when there was none. */
export function takeRedirect(): string | null {
  try {
    const path = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return path && path.startsWith('/') && !path.startsWith('//') ? path : null;
  } catch {
    return null;
  }
}
