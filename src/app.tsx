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
 * Each screen owns its own loading, error, and empty states (§9.3, §9.4,
 * §9.8) rather than the shell blanking the whole content area: a failed read on
 * a board must still leave its header and its quick add usable, which is
 * impossible if the router swaps the screen out for a spinner.
 */

import { MotionConfig } from 'motion/react';
import { useEffect, useState } from 'react';
import { AppShell } from './components/AppShell';
import { Toaster } from './components/ui/Toast';
import * as api from './lib/api';
import { isDemo, startDemo } from './lib/demo';
import { refreshSubscription } from './lib/push';
import { setRedirect } from './lib/redirect';
import { Link, useRoute } from './lib/router';
import { subscribeToConnectivity, useStore } from './lib/store';
import { useToasts } from './lib/toasts';
import { Archived } from './screens/Archived';
import { Blockers } from './screens/Blockers';
import { Closed } from './screens/Closed';
import { Board } from './screens/Board';
import { ContextHome } from './screens/ContextHome';
import { Login } from './screens/Login';
import { Planner } from './screens/Planner';

type Auth = 'checking' | 'in' | 'out';

// `/demo` is a public entry alias backed entirely by per-tab browser storage.
// It never creates or reads data in the owner's authenticated workspace.
const directDemoEntry = typeof window !== 'undefined' && /^\/demo\/?$/.test(window.location.pathname);
if (directDemoEntry && !isDemo()) startDemo();

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
  const load = useStore((state) => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => subscribeToConnectivity(), []);

  // Push services rotate endpoints, and a browser can replace a subscription
  // without telling the page. Re-registering whatever this browser currently
  // holds, once per signed-in load, is what keeps the server's copy from going
  // quietly stale — the failure mode otherwise being a phone that stops
  // receiving anything and shows nothing wrong. It is a no-op on a device that
  // has never granted permission.
  useEffect(() => {
    void refreshSubscription();
  }, []);

  return (
    // `reducedMotion="user"` makes every motion component honour
    // prefers-reduced-motion without each one asking (§8.5).
    <MotionConfig reducedMotion="user">
      <AppShell onSignedOut={onSignedOut}>
        <Routes />
      </AppShell>
      <Toaster />
    </MotionConfig>
  );
}

function Routes() {
  const route = useRoute();

  switch (route.name) {
    case 'home':
      return <ContextHome />;
    case 'board':
      return <Board id={route.id} />;
    case 'archived':
      return <Archived />;
    case 'closed':
      return <Closed />;
    case 'blockers':
      return <Blockers />;
    case 'planner':
      return <Planner />;
    case 'notFound':
      return <NotFound path={route.path} />;
  }
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="py-12">
      <p className="text-body text-text-secondary">Nothing lives at {path}.</p>
      <p className="mt-4">
        <Link to="/" className="text-body text-accent">
          Back to your boards
        </Link>
      </p>
    </div>
  );
}
