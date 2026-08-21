/**
 * The router. History API, route table, no dependency.
 *
 * The History API rather than a piece of component state is the whole point:
 * the browser's back and forward buttons have to work, and a hard reload on
 * `/board/:id` — or on `/planner` — has to render that screen. A state-machine
 * "router" gets both wrong, and gets them wrong quietly.
 *
 * The login screen is not a route. It is rendered when there is no session,
 * whatever the path — which is what lets the user land back where they were
 * after unlocking (§6.1) instead of at `/login`.
 *
 * **Routes and views are not the same thing** (V2 §4.1). `/board/:id` and
 * `/archived` sit *under* Boards rather than beside it, and `/demo` is an entry
 * alias for the Boards home. `viewOf` keeps that mapping next to `parseRoute`
 * so the header does not maintain a second route table of its own.
 */

import { useCallback, useSyncExternalStore, type ReactNode } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'board'; id: string }
  | { name: 'archived' }
  | { name: 'blockers' }
  | { name: 'planner' }
  | { name: 'notFound'; path: string };

/** What the header's segmented control switches between (V2 §4.1). */
export const VIEWS = ['boards', 'blockers', 'planner'] as const;

export type View = (typeof VIEWS)[number];

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '/demo') return { name: 'home' };
  if (pathname === '/archived') return { name: 'archived' };
  if (pathname === '/blockers') return { name: 'blockers' };
  if (pathname === '/planner') return { name: 'planner' };

  const board = /^\/board\/([^/]+)$/.exec(pathname);
  if (board) return { name: 'board', id: decodeURIComponent(board[1]) };

  return { name: 'notFound', path: pathname };
}

/**
 * Which view a route belongs to, or null where the selector has no answer.
 *
 * Null is only ever `notFound` — a path that is not part of the app has no
 * view, and showing one selected there would claim otherwise. Every real route
 * maps: `board` and `archived` to `boards`, which is the whole point of the
 * function.
 */
export function viewOf(route: Route): View | null {
  switch (route.name) {
    case 'home':
    case 'board':
    case 'archived':
      return 'boards';
    case 'blockers':
      return 'blockers';
    case 'planner':
      return 'planner';
    case 'notFound':
      return null;
  }
}

/**
 * Where selecting a view goes. Selecting from `/board/:id` lands on the view's
 * *root* (V2 §4.1) — including Boards, which is why choosing Boards from a
 * board is a navigation to `/` rather than a no-op.
 */
export const VIEW_ROOTS: Record<View, string> = {
  boards: '/',
  blockers: '/blockers',
  planner: '/planner',
};

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

/**
 * State carried across one navigation.
 *
 * Only Up Next uses it: tapping an entry pushes to that board and briefly
 * highlights the row (§6.7). The id rides in the history entry rather than in a
 * module variable so a hard reload of the board — a real navigation the app did
 * not make — simply has no state and highlights nothing, which is right.
 */
export interface NavState {
  highlightTaskId?: string;
}

/** Navigate within the app. `replace` swaps the entry instead of adding one. */
export function navigate(
  path: string,
  options: { replace?: boolean; state?: NavState } = {},
): void {
  const state = options.state ?? null;
  if (path === window.location.pathname) {
    // Same path, new intent: the destination screen still has to see the
    // state, and a no-op return would swallow it.
    if (state) {
      window.history.replaceState(state, '', path);
      notify();
    }
    return;
  }
  if (options.replace) window.history.replaceState(state, '', path);
  else window.history.pushState(state, '', path);
  // A new page starts at the top; the browser only does this for real loads.
  window.scrollTo(0, 0);
  notify();
}

/**
 * Read the state of the current history entry once, clearing it.
 *
 * Clearing matters: without it, every re-render of the board screen — and a
 * later back-navigation onto the same entry — would re-fire the highlight for a
 * task the user has long since dealt with.
 */
export function consumeNavState(): NavState | null {
  if (typeof window === 'undefined') return null;
  const state = window.history.state as NavState | null;
  if (!state || typeof state !== 'object') return null;
  window.history.replaceState(null, '', window.location.pathname);
  return state;
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
