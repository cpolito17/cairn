/**
 * Login. PROJECT-SPEC.md §9.1, §6.1, §8.4 (buttons, inputs), §8.5 (press
 * feedback, the error shake).
 *
 * Full viewport, vertically centered, narrow measure. The wordmark, one
 * password field, one primary pill. Nothing else — no links, no secondary
 * actions, no marketing. Four states: idle, submitting, error, rate limited.
 *
 * This screen owns its own state — it is the one surface that exists before the
 * store does — but its request goes through `lib/api.ts` like every other, so
 * nothing in the app calls `fetch` itself. On success it navigates to the
 * preserved destination, which reboots the app with a live session.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, login } from '../lib/api';
import { OUT_CURVE, prefersReducedMotion } from '../lib/motion';
import { takeRedirect } from '../lib/redirect';

/** The shake: a short horizontal wiggle, well under the 300ms ceiling. */
const SHAKE_MS = 240;

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string }
  | { kind: 'rateLimited'; secondsLeft: number };

/** "1:30" / "45s" — the cooling-off period, stated plainly. */
function formatCooldown(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function Login() {
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const fieldRef = useRef<HTMLInputElement>(null);
  const shakeRef = useRef<Animation | null>(null);

  const submitting = status.kind === 'submitting';
  const rateLimited = status.kind === 'rateLimited';
  const disabled = submitting || rateLimited;

  /**
   * One horizontal wiggle on the field, transform only.
   *
   * Driven imperatively rather than by toggling a CSS animation class: a class
   * toggle cannot be re-triggered reliably for consecutive failures, whereas
   * cancelling the in-flight animation and starting a new one always restarts
   * cleanly from the live value. Under `prefers-reduced-motion: reduce` the
   * movement is dropped entirely — nothing runs, not even a shortened version.
   */
  const shake = useCallback(() => {
    const el = fieldRef.current;
    if (!el || prefersReducedMotion()) return;

    shakeRef.current?.cancel();
    shakeRef.current = el.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-6px)' },
        { transform: 'translateX(5px)' },
        { transform: 'translateX(-3px)' },
        { transform: 'translateX(0)' },
      ],
      { duration: SHAKE_MS, easing: OUT_CURVE },
    );
  }, []);

  // The rate-limit countdown. The button re-enables the moment it elapses.
  useEffect(() => {
    if (status.kind !== 'rateLimited') return;
    if (status.secondsLeft <= 0) {
      setStatus({ kind: 'idle' });
      return;
    }
    const timer = window.setTimeout(() => {
      setStatus({ kind: 'rateLimited', secondsLeft: status.secondsLeft - 1 });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [status]);

  // Don't leave an animation running against an unmounted node.
  useEffect(() => () => shakeRef.current?.cancel(), []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || password.length === 0) return;

    setStatus({ kind: 'submitting' });

    try {
      await login(password);
      window.location.assign(takeRedirect() ?? '/');
      return;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;

      if (err.unreachable) {
        setStatus({ kind: 'error', message: "Couldn't reach the server. Check your connection." });
        shake();
        return;
      }

      if (err.status >= 500) {
        setStatus({ kind: 'error', message: 'Something went wrong on the server.' });
        shake();
        return;
      }

      // 401. The body distinguishes rate-limited from wrong-password only by
      // the presence of `retryAfter` — that difference exists for the owner's
      // benefit and is the only one.
      setPassword('');
      if (err.retryAfter !== undefined) {
        setStatus({ kind: 'rateLimited', secondsLeft: err.retryAfter });
      } else {
        setStatus({ kind: 'error', message: 'That password was not accepted.' });
      }
      shake();
    }
  }

  const message =
    status.kind === 'error'
      ? status.message
      : status.kind === 'rateLimited'
        ? `Too many attempts. Try again in ${formatCooldown(status.secondsLeft)}.`
        : null;

  return (
    <main className="flex min-h-dvh items-center justify-center px-gutter">
      <div className="w-full max-w-[22rem]">
        <h1
          className="mb-8 text-center text-hero text-text"
          style={{ fontWeight: 600, letterSpacing: '-0.03em' }}
        >
          Cairn
        </h1>

        <form onSubmit={onSubmit} noValidate>
          <label
            htmlFor="password"
            className="mb-2 block text-text-secondary"
            style={{ fontSize: '13px', fontWeight: 500 }}
          >
            Password
          </label>

          <input
            id="password"
            ref={fieldRef}
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            disabled={disabled}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={status.kind === 'error' || rateLimited}
            aria-describedby={message ? 'password-message' : undefined}
            className="w-full rounded-control border-0 bg-surface-2 px-4 text-text outline-none
                       placeholder:text-text-tertiary focus:outline-2 focus:outline-accent
                       disabled:opacity-60"
            style={{ height: 'var(--button-height)', outlineOffset: '0px' }}
          />

          {message && (
            <p
              id="password-message"
              role="alert"
              className="mt-2 text-meta text-negative"
            >
              {message}
            </p>
          )}

          {/* §8.4: primary pill, 48px, accent fill, on-accent at 600, full
              width. Loading swaps the label for a spinner inside the same
              pill — the shape and both dimensions are fixed, so it cannot
              resize. §8.5: press feedback is scale(0.97) on pointer-down. */}
          <button
            type="submit"
            disabled={disabled}
            // The shared `.pressable` rule rather than a local
            // `active:scale-[0.97]`: press feedback is one behaviour, and the
            // hand-rolled copy missed both of the things that rule now carries
            // — the asymmetric press/release timing and the `:focus-visible`
            // exclusion that keeps Space and Enter from animating (§8.5).
            className="pressable mt-6 flex w-full items-center justify-center rounded-pill
                       bg-accent text-on-accent disabled:pointer-events-none
                       disabled:opacity-60"
            style={{ height: 'var(--button-height)', fontWeight: 600 }}
          >
            {submitting ? <Spinner /> : 'Unlock'}
          </button>
        </form>
      </div>
    </main>
  );
}

/**
 * The in-button spinner. Linear easing is legal here and nowhere else (§8.5).
 * Sized to the label's line box so the pill's height is unaffected.
 */
function Spinner() {
  return (
    <>
      <span
        aria-hidden="true"
        data-motion="essential"
        className="block rounded-pill"
        style={{
          width: '20px',
          height: '20px',
          border: '2px solid color-mix(in srgb, var(--on-accent) 30%, transparent)',
          borderTopColor: 'var(--on-accent)',
          animation: 'cairn-spin 700ms linear infinite',
        }}
      />
      <span className="sr-only">Unlocking</span>
    </>
  );
}
