/**
 * Boot.
 *
 * One question on load: is there a live session? `GET /api/session` answers it,
 * and until it does nothing is rendered — flashing the login screen at someone
 * who is already signed in is worse than a beat of blank.
 *
 * The app shell, the router, and the store all arrive in issue 4. What stands
 * here is an authenticated placeholder plus the one piece of §9.2 this issue
 * owns: the log-out affordance in the header.
 */

import { useEffect, useState } from 'react';
import { setRedirect } from './lib/redirect';
import { Login } from './screens/Login';

type Auth = 'checking' | 'in' | 'out';

export function App() {
  const [auth, setAuth] = useState<Auth>('checking');

  useEffect(() => {
    let live = true;

    fetch('/api/session')
      .then((response) => {
        if (!live) return;
        if (response.status === 204) {
          setAuth('in');
          return;
        }
        // A 401 from anywhere is the signal to drop to the login screen. Keep
        // the destination so the unlock returns the user to it (§6.1).
        const here = window.location.pathname + window.location.search;
        if (here !== '/') setRedirect(here);
        setAuth('out');
      })
      .catch(() => {
        if (live) setAuth('out');
      });

    return () => {
      live = false;
    };
  }, []);

  if (auth === 'checking') return null;
  if (auth === 'out') return <Login />;
  return <SignedIn onSignedOut={() => setAuth('out')} />;
}

function SignedIn({ onSignedOut }: { onSignedOut: () => void }) {
  async function logOut() {
    // Idempotent server-side, so even a failed response should still drop this
    // view back to the login screen.
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      window.history.replaceState(null, '', '/');
      onSignedOut();
    }
  }

  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between px-gutter py-4">
        <span className="text-board-title text-text" style={{ letterSpacing: '-0.02em' }}>
          Cairn
        </span>
        <button
          type="button"
          onClick={logOut}
          className="rounded-chip px-3 py-2 text-meta text-accent transition-transform
                     active:scale-[0.97]"
          style={{
            transitionDuration: '160ms',
            transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
          }}
        >
          Log out
        </button>
      </header>

      <main className="flex min-h-[60dvh] items-center justify-center px-gutter">
        <p className="text-body text-text-secondary">Signed in.</p>
      </main>
    </div>
  );
}
