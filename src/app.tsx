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
import { Button } from './components/ui/Button';
import { Dialog, DialogHeader } from './components/ui/Dialog';
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
import { Board } from './screens/Board';
import { ContextHome } from './screens/ContextHome';
import { Login } from './screens/Login';
import { Planner } from './screens/Planner';

type Auth = 'checking' | 'in' | 'out';

/**
 * `/demo` is an entry path, not a second version of the app. Start the local
 * demo backend before the session probe runs, then let the normal boot path do
 * the rest. An existing world survives a reload in the same tab.
 */
const directDemoEntry =
  typeof window !== 'undefined' && window.location.pathname === '/demo';

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
  return (
    <SignedIn
      onSignedOut={() => setAuth('out')}
      welcomeToDemo={directDemoEntry}
    />
  );
}

function rememberDestination(): void {
  const here = window.location.pathname + window.location.search;
  if (here !== '/') setRedirect(here);
}

function SignedIn({
  onSignedOut,
  welcomeToDemo,
}: {
  onSignedOut(): void;
  welcomeToDemo: boolean;
}) {
  const load = useStore((state) => state.load);
  const [demoWelcomeOpen, setDemoWelcomeOpen] = useState(welcomeToDemo);

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
      <AppShell onSignedOut={onSignedOut} suppressOverdueAudit={welcomeToDemo}>
        <Routes />
      </AppShell>
      <DemoWelcome open={demoWelcomeOpen} onClose={() => setDemoWelcomeOpen(false)} />
      <Toaster />
    </MotionConfig>
  );
}

function DemoWelcome({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Welcome to the demo">
      <DialogHeader title="Welcome to the demo" onClose={onClose} />

      <div className="space-y-3 text-body text-text-secondary">
        <p>
          This is the demo version of Cairn. Its sample world turns Homer&apos;s{' '}
          <em>The Odyssey</em> into a task plan: help Odysseus reach Ithaca, manage
          his crew, and organize the many problems he meets along the way.
        </p>
        <p>
          You can freely add, edit, schedule, complete, and reorder tasks. The
          demo stays in this browser tab, does not affect the live account, and
          is deleted when you leave it.
        </p>
      </div>

      <Button className="mt-6" fullWidth onClick={onClose}>
        Start exploring
      </Button>
    </Dialog>
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
