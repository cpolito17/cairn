/**
 * Toast state and lifetimes. PROJECT-SPEC.md §8.4 (Toasts), §6.8.
 *
 * Separate from the app store on purpose: the store in `store.ts` is the shape
 * the architecture fixed, and transient UI notices are not part of it. Keeping
 * them apart also means `mutate()` can raise a failure toast without any
 * component in the loop.
 *
 * The timers live here rather than in the component so a re-render cannot
 * restart a countdown, and so the `visibilitychange` rule — a toast does not
 * burn its lifetime while the tab is in the background — is enforced in one
 * place for every toast at once.
 */

import { create } from 'zustand';

export type ToastTone = 'error' | 'success' | 'info';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  tone: ToastTone;
  /** One line. §8.4 gives toasts a single line and no body copy. */
  message: string;
  action?: ToastAction | undefined;
  /** Total visible lifetime in ms, excluding time spent with the tab hidden. */
  duration: number;
}

/** Most toasts on screen at once. Older ones are dropped from the back. */
const MAX_VISIBLE = 3;

const DEFAULT_DURATION = 5000;
/** A toast the user is expected to act on gets longer. */
const ACTIONABLE_DURATION = 8000;

interface ToastStore {
  toasts: Toast[];
  push(toast: Omit<Toast, 'id' | 'duration'> & { duration?: number }): string;
  dismiss(id: string): void;
  clear(): void;
}

export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],

  push(input) {
    const id = crypto.randomUUID();
    const duration =
      input.duration ?? (input.action ? ACTIONABLE_DURATION : DEFAULT_DURATION);
    const toast: Toast = { id, duration, ...input };

    const next = [...get().toasts, toast];
    // Oldest first in the array, newest last: the newest is the front of the
    // stack, so overflow is trimmed from the head.
    const dropped = next.slice(0, Math.max(0, next.length - MAX_VISIBLE));
    for (const stale of dropped) clearTimer(stale.id);

    set({ toasts: next.slice(-MAX_VISIBLE) });
    startTimer(id, duration);
    return id;
  },

  dismiss(id) {
    clearTimer(id);
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
  },

  clear() {
    for (const toast of get().toasts) clearTimer(toast.id);
    set({ toasts: [] });
  },
}));

/** Convenience wrappers so callers do not repeat the tone literal. */
export const toast = {
  error(message: string, action?: ToastAction): string {
    return useToasts.getState().push({ tone: 'error', message, action });
  },
  info(message: string, action?: ToastAction): string {
    return useToasts.getState().push({ tone: 'info', message, action });
  },
  success(message: string, action?: ToastAction): string {
    return useToasts.getState().push({ tone: 'success', message, action });
  },
};

/* --- lifetimes ------------------------------------------------------------- */

interface Timer {
  handle: number;
  /** Time left when the timer was last started. */
  remaining: number;
  /** When that start happened, so a pause can subtract the elapsed part. */
  startedAt: number;
}

const timers = new Map<string, Timer>();

function startTimer(id: string, remaining: number): void {
  if (typeof window === 'undefined') return;
  // A hidden tab does not start the clock at all — the toast waits for the
  // user to come back rather than expiring unseen.
  if (document.visibilityState === 'hidden') {
    timers.set(id, { handle: 0, remaining, startedAt: 0 });
    return;
  }
  const handle = window.setTimeout(() => {
    timers.delete(id);
    useToasts.getState().dismiss(id);
  }, remaining);
  timers.set(id, { handle, remaining, startedAt: Date.now() });
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (!timer) return;
  if (timer.handle !== 0) clearTimeout(timer.handle);
  timers.delete(id);
}

/** Freeze every countdown, banking what is left of each. */
function pauseTimers(): void {
  for (const [id, timer] of timers) {
    if (timer.handle === 0) continue;
    clearTimeout(timer.handle);
    const elapsed = Date.now() - timer.startedAt;
    timers.set(id, {
      handle: 0,
      remaining: Math.max(0, timer.remaining - elapsed),
      startedAt: 0,
    });
  }
}

function resumeTimers(): void {
  for (const [id, timer] of timers) {
    if (timer.handle !== 0) continue;
    startTimer(id, timer.remaining);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pauseTimers();
    else resumeTimers();
  });
}
