/**
 * Boot, and the route table.
 *
 * Two questions, in order. Is there a live session? `GET /api/session` answers
 * it, and until it does nothing renders — flashing the login screen at someone
 * who is already signed in is worse than a beat of blank. Then: what is the
 * world? One `GET /api/state`, once, into the store.
 *
 * The login screen is rendered by state rather than routed to (§6.1), so the
 * URL the user was on survives a forced logout and they land back on it.
 *
 * The screens themselves are issue 5. What each route renders here is a
 * placeholder that proves the shell, the router, and the store are wired
 * together — including a scaffold "New board" action, the only thing in this
 * issue that can exercise the optimistic path end to end. Issue 5 replaces all
 * of it.
 */

import { MotionConfig } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { AppShell } from './components/AppShell';
import { Button } from './components/ui/Button';
import { SkeletonCard } from './components/ui/Skeleton';
import { Toaster } from './components/ui/Toast';
import * as api from './lib/api';
import { setRedirect } from './lib/redirect';
import { boardPath, Link, useRoute } from './lib/router';
import {
  createBoardSpec,
  endOfContext,
  selectBoardsFor,
  subscribeToConnectivity,
  useArchivedBoards,
  useBoard,
  useBoards,
  useStore,
} from './lib/store';
import { watchSystemTheme } from './lib/theme';
import { useToasts } from './lib/toasts';
import { Login } from './screens/Login';

type Auth = 'checking' | 'in' | 'out';

/**
 * Cached so React's StrictMode double-invoke — and any remount — asks the
 * server once. The same guard lives inside the store's `load()`.
 */
let sessionProbe: Promise<boolean> | null = null;

function probeSession(): Promise<boolean> {
  sessionProbe ??= api.getSession().catch(() => false);
  return sessionProbe;
}

export function App() {
  const [auth, setAuth] = useState<Auth>('checking');

  useEffect(() => {
    let live = true;
    void probeSession().then((signedIn) => {
      if (!live) return;
      if (!signedIn) rememberDestination();
      setAuth(signedIn ? 'in' : 'out');
    });
    return () => {
      live = false;
    };
  }, []);

  // The single forced-logout path. A 401 from any call lands here: the store is
  // cleared, the destination is kept, and the login screen takes over.
  useEffect(
    () =>
      api.onSessionLost(() => {
        useStore.getState().reset();
        useToasts.getState().clear();
        rememberDestination();
        sessionProbe = null;
        setAuth('out');
      }),
    [],
  );

  if (auth === 'checking') return null;
  if (auth === 'out') return <Login />;
  return <SignedIn onSignedOut={() => setAuth('out')} />;
}

function rememberDestination(): void {
  const here = window.location.pathname + window.location.search;
  if (here !== '/') setRedirect(here);
}

function SignedIn({ onSignedOut }: { onSignedOut(): void }) {
  const status = useStore((state) => state.status);
  const load = useStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => subscribeToConnectivity(), []);

  // The OS preference steers the theme only while the user has no override of
  // their own; `watchSystemTheme` is what enforces that.
  useEffect(() => watchSystemTheme((theme) => useStore.getState().followSystemTheme(theme)), []);

  return (
    // `reducedMotion="user"` makes every motion component honour
    // prefers-reduced-motion without each one asking (§8.5).
    <MotionConfig reducedMotion="user">
      <AppShell onSignedOut={onSignedOut}>
        {status === 'loading' ? (
          <LoadingState />
        ) : status === 'error' ? (
          <ErrorState />
        ) : (
          <Routes />
        )}
      </AppShell>
      <Toaster />
    </MotionConfig>
  );
}

function Routes() {
  const route = useRoute();

  switch (route.name) {
    case 'home':
      return <HomePlaceholder />;
    case 'board':
      return <BoardPlaceholder id={route.id} />;
    case 'archived':
      return <ArchivedPlaceholder />;
    case 'notFound':
      return <NotFoundPlaceholder path={route.path} />;
  }
}

/* --- states ---------------------------------------------------------------- */

/** Skeletons matching the real card geometry, never a lone centered spinner. */
function LoadingState() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

/** Plain language about what happened, plus a retry (§8.4). */
function ErrorState() {
  const load = useStore((state) => state.load);
  return (
    <div className="mx-auto max-w-sm py-12 text-center">
      <p className="text-body text-text-secondary">
        Couldn&rsquo;t load your boards. The connection may have dropped.
      </p>
      <div className="mt-6 flex justify-center">
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/* --- route placeholders (issue 5 replaces every one of these) --------------- */

function PlaceholderHeading({ children }: { children: ReactNode }) {
  return (
    <h1 className="mb-1 text-board-title text-text" style={{ letterSpacing: '-0.01em' }}>
      {children}
    </h1>
  );
}

function HomePlaceholder() {
  const context = useStore((state) => state.context);
  const boards = useBoards(context);

  function newBoard() {
    const state = useStore.getState();
    const name = `Board ${selectBoardsFor(state, context).length + 1}`;
    void state.mutate(createBoardSpec({ context, name, position: endOfContext(state, context) }));
  }

  return (
    <div>
      <PlaceholderHeading>{context === 'personal' ? 'Personal' : 'Work'}</PlaceholderHeading>
      <p className="text-body text-text-secondary">
        {boards.length} {boards.length === 1 ? 'board' : 'boards'} · the context home lands in
        issue 5.
      </p>

      <ul className="mt-section grid gap-3">
        {boards.map((board) => (
          <li key={board.id}>
            <Link
              to={boardPath(board.id)}
              data-board-name={board.name}
              className="pressable block rounded-card bg-surface px-5 py-4 text-row text-text"
              style={{ border: 'var(--hairline-width) solid var(--hairline)' }}
            >
              {board.name}
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-section">
        <Button variant="secondary" onClick={newBoard}>
          New board
        </Button>
      </div>
    </div>
  );
}

function BoardPlaceholder({ id }: { id: string }) {
  const board = useBoard(id);

  if (!board) {
    return (
      <div className="py-12 text-center">
        <p className="text-body text-text-secondary">That board no longer exists.</p>
      </div>
    );
  }

  return (
    <div>
      <PlaceholderHeading>{board.name}</PlaceholderHeading>
      <p className="text-body text-text-secondary">The board screen lands in issue 5.</p>
    </div>
  );
}

function ArchivedPlaceholder() {
  const context = useStore((state) => state.context);
  const archived = useArchivedBoards(context);

  return (
    <div>
      <PlaceholderHeading>Archived</PlaceholderHeading>
      <p className="text-body text-text-secondary">
        {archived.length} archived {archived.length === 1 ? 'board' : 'boards'} in this context ·
        the archived screen lands in issue 5.
      </p>
    </div>
  );
}

function NotFoundPlaceholder({ path }: { path: string }) {
  return (
    <div className="py-12 text-center">
      <p className="text-body text-text-secondary">Nothing lives at {path}.</p>
      <p className="mt-4">
        <Link to="/" className="text-body text-accent">
          Back to your boards
        </Link>
      </p>
    </div>
  );
}
