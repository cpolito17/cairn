/**
 * The router. History API, four routes, no dependency.
 *
 * The History API rather than a piece of component state is the whole point:
 * the browser's back and forward buttons have to work, and a hard reload on
 * `/board/:id` has to render that board. A state-machine "router" gets both
 * wrong, and gets them wrong quietly.
 *
 * The login screen is not a route. It is rendered when there is no session,
 * whatever the path — which is what lets the user land back where they were
 * after unlocking (§6.1) instead of at `/login`.
 */

import { useCallback, useSyncExternalStore, type ReactNode } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'board'; id: string }
  | { name: 'archived' }
  | { name: 'notFound'; path: string };

export function parseRoute(pathname: string): Route {
  if (pathname === '/') return { name: 'home' };
  if (pathname === '/archived') return { name: 'archived' };

  const board = /^\/board\/([^/]+)$/.exec(pathname);
  if (board) return { name: 'board', id: decodeURIComponent(board[1]) };

  return { name: 'notFound', path: pathname };
}

export function boardPath(id: string): string {
  return `/board/${encodeURIComponent(id)}`;
}

/* --- subscription ---------------------------------------------------------- */

const listeners = new Set<() => void>();

/**
 * The snapshot is the pathname string, not a parsed object: `useSyncExternalStore`
 * compares snapshots by identity, and a fresh object every call would re-render
 * without end. Parsing happens above it, in the hook.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): string {
  return window.location.pathname;
}

/** The server render has no location; the shell's home route is the answer. */
function serverSnapshot(): string {
  return '/';
}

function notify(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  // Back and forward. `pushState` does not fire this, which is why `navigate`
  // notifies for itself.
  window.addEventListener('popstate', notify);
}

/** Navigate within the app. `replace` swaps the entry instead of adding one. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return;
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  // A new page starts at the top; the browser only does this for real loads.
  window.scrollTo(0, 0);
  notify();
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return parseRoute(pathname);
}

/* --- link ------------------------------------------------------------------ */

interface LinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
  children: ReactNode;
}

/**
 * A real `<a href>` that navigates in-app. It stays an anchor so middle-click,
 * cmd-click, and "open in new tab" keep working — those are exactly the cases
 * the modifier check below hands back to the browser.
 */
export function Link({ to, replace, onClick, children, ...rest }: LinkProps) {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      event.preventDefault();
      navigate(to, replace === undefined ? {} : { replace });
    },
    [to, replace, onClick],
  );

  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
