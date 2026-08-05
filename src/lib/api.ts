/**
 * The API client. One typed function per endpoint from issue 3, and the only
 * module in the app that calls `fetch`.
 *
 * Two things are centralized here because they are wrong everywhere else:
 *
 * **401 is terminal.** Any call that comes back 401 means the session is gone,
 * and no amount of retrying will bring it back. The first such response fires
 * one global "session lost" event — once, not once per in-flight request — and
 * every caller sees a rejected promise. The app clears its state, records where
 * the user was, and drops to the login screen. Login and session probing are
 * deliberately exempt: a 401 from `POST /api/login` is a wrong password, not a
 * lost session.
 *
 * **A transport failure looks like an API failure.** An offline `fetch` rejects
 * with a `TypeError`; a 500 resolves. Callers should not have to care, so both
 * arrive as `ApiError` and the offline case gets `status: 0`.
 *
 * **Demo mode is switched here and nowhere else.** When this tab is running the
 * demo (`lib/demo`), every function below answers from a world held in the
 * browser instead of from the Worker. This is the only module in the app that
 * calls `fetch`, which is what makes one branch per endpoint the whole of the
 * integration — no screen, selector, or mutation spec knows the difference.
 */

import * as demo from './demo';
import type {
  AppState,
  Board,
  BoardAccent,
  Context,
  Difficulty,
  PlannerEvent,
  Settings,
  Task,
} from '../../shared/types';

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  /** Seconds to wait, when the server sent one. */
  readonly retryAfter: number | undefined;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }

  /** True when the request never made it out — offline, DNS, blocked. */
  get unreachable(): boolean {
    return this.status === 0;
  }
}

/* --- session-lost signal --------------------------------------------------- */

type SessionLostListener = () => void;

const sessionLostListeners = new Set<SessionLostListener>();
let sessionLost = false;

/**
 * Subscribe to the forced-logout signal. Returns an unsubscribe.
 *
 * The app registers exactly one of these; it is an event rather than a direct
 * call into the store so this module stays free of any dependency on it.
 */
export function onSessionLost(listener: SessionLostListener): () => void {
  sessionLostListeners.add(listener);
  return () => sessionLostListeners.delete(listener);
}

/**
 * Re-arm the signal after a successful login. Without this a second forced
 * logout in the same document would be swallowed by the latch below.
 */
export function armSessionLost(): void {
  sessionLost = false;
}

function fireSessionLost(): void {
  // Latched: three parallel requests failing together are one lost session.
  if (sessionLost) return;
  sessionLost = true;
  for (const listener of sessionLostListeners) listener();
}

/* --- transport ------------------------------------------------------------- */

interface CallOptions {
  method?: string;
  body?: unknown;
  /** Set for the auth endpoints, whose 401 is an answer rather than an outage. */
  ownsUnauthorized?: boolean;
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const { method = 'GET', body, ownsUnauthorized = false } = options;

  const init: RequestInit = {
    method,
    // Same-origin: the Worker serves the SPA and the API from one origin, so
    // the session cookie rides along without CORS ever entering the picture.
    credentials: 'same-origin',
  };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('Network unavailable', 0);
  }

  if (response.status === 401 && !ownsUnauthorized) {
    fireSessionLost();
    throw new ApiError('Session expired', 401);
  }

  if (!response.ok) {
    const { error, retryAfter } = await readError(response);
    throw new ApiError(error, response.status, retryAfter);
  }

  return response;
}

async function readError(
  response: Response,
): Promise<{ error: string; retryAfter: number | undefined }> {
  try {
    const body = (await response.json()) as { error?: unknown; retryAfter?: unknown };
    return {
      error: typeof body.error === 'string' ? body.error : `Request failed (${response.status})`,
      retryAfter: typeof body.retryAfter === 'number' ? body.retryAfter : undefined,
    };
  } catch {
    return { error: `Request failed (${response.status})`, retryAfter: undefined };
  }
}

async function callJson<T>(path: string, options: CallOptions = {}): Promise<T> {
  const response = await call(path, options);
  return (await response.json()) as T;
}

/* --- auth ------------------------------------------------------------------ */

/** True when a live session exists. Its 401 is an answer, not a lost session. */
export async function getSession(): Promise<boolean> {
  // A live demo world *is* a live session: the app boots straight into it on a
  // reload, without a round trip that would 401 and bounce back to login.
  if (demo.isDemo()) return true;
  try {
    await call('/api/session', { ownsUnauthorized: true });
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return false;
    throw err;
  }
}

/**
 * Unlock. Resolves on success; rejects with an `ApiError` carrying 401 for a
 * refused password, and `retryAfter` when the limiter is engaged (§6.1).
 */
export async function login(password: string): Promise<void> {
  await call('/api/login', { method: 'POST', body: { password }, ownsUnauthorized: true });
  armSessionLost();
}

/** Idempotent server-side; a failure here still drops the client to login. */
export async function logout(): Promise<void> {
  if (demo.isDemo()) {
    demo.endDemo();
    // The same path a lost session takes: the app clears the store, drops the
    // toasts, and renders login. Without it the demo's entities would still be
    // in a store whose `status` is already `ready`, and a real unlock in the
    // same tab would short-circuit its load and show them.
    fireSessionLost();
    return;
  }
  await call('/api/logout', { method: 'POST', ownsUnauthorized: true });
}

/* --- state ----------------------------------------------------------------- */

/** The whole world in one round trip. The app's only read. */
export function getState(): Promise<AppState> {
  if (demo.isDemo()) return demo.getState();
  return callJson<AppState>('/api/state');
}

/* --- boards ---------------------------------------------------------------- */

export interface BoardDraft {
  context: Context;
  name: string;
  description?: string | null;
  accent?: BoardAccent | null;
  position: string;
}

export interface BoardPatch {
  name?: string;
  description?: string | null;
  accent?: BoardAccent | null;
  position?: string;
  /** The wire says `archived: true`; the server records when. */
  archived?: boolean;
}

export function createBoard(draft: BoardDraft): Promise<Board> {
  if (demo.isDemo()) return demo.createBoard(draft);
  return callJson<Board>('/api/boards', { method: 'POST', body: draft });
}

export function updateBoard(id: string, patch: BoardPatch): Promise<Board> {
  if (demo.isDemo()) return demo.updateBoard(id, patch);
  return callJson<Board>(`/api/boards/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

export async function deleteBoard(id: string): Promise<void> {
  if (demo.isDemo()) return demo.deleteBoard(id);
  await call(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* --- tasks ----------------------------------------------------------------- */

export interface TaskDraft {
  boardId: string;
  name: string;
  notes?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  /** Minutes: a multiple of 15 in [15, 720], or null. */
  durationMinutes?: number | null;
  /** Epoch ms, snapped to the 15-minute grid, or null. */
  scheduledAt?: number | null;
  difficulty?: Difficulty | null;
  priority?: boolean;
  blocked?: boolean;
  /** Another task on the same board, or null. */
  dependsOn?: string | null;
  position: string;
}

export interface TaskPatch {
  name?: string;
  notes?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  /** Minutes: a multiple of 15 in [15, 720], or null. The server refuses
   *  anything else rather than rounding it. */
  durationMinutes?: number | null;
  /** Epoch ms snapped to the 15-minute grid, or null to unschedule. A start
   *  off the grid, or a block that would cross midnight, is a 400. */
  scheduledAt?: number | null;
  difficulty?: Difficulty | null;
  priority?: boolean;
  blocked?: boolean;
  /** Another task on the same board, or null to clear the link. */
  dependsOn?: string | null;
  position?: string;
  boardId?: string;
  /** The client never sends a timestamp — the server clocks completion (§6.5). */
  completed?: boolean;
}

export function createTask(draft: TaskDraft): Promise<Task> {
  if (demo.isDemo()) return demo.createTask(draft);
  return callJson<Task>('/api/tasks', { method: 'POST', body: draft });
}

export function updateTask(id: string, patch: TaskPatch): Promise<Task> {
  if (demo.isDemo()) return demo.updateTask(id, patch);
  return callJson<Task>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

export async function deleteTask(id: string): Promise<void> {
  if (demo.isDemo()) return demo.deleteTask(id);
  await call(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* --- planner events ------------------------------------------------------- */

export type EventDraft = Omit<PlannerEvent, 'id' | 'createdAt' | 'updatedAt'>;
export type EventPatch = Partial<Omit<EventDraft, 'context'>>;

// `/api/planner-events`, not the shorter `/api/events` — see the note on
// `handleEvents` in the Worker. A bare "events" path is a common ad-blocker
// false positive (it looks like an analytics beacon), and it was getting
// dropped client-side before ever reaching the server.
export function createEvent(draft: EventDraft): Promise<PlannerEvent> {
  if (demo.isDemo()) return demo.createEvent(draft);
  return callJson<PlannerEvent>('/api/planner-events', { method: 'POST', body: draft });
}

export function updateEvent(id: string, patch: EventPatch): Promise<PlannerEvent> {
  if (demo.isDemo()) return demo.updateEvent(id, patch);
  return callJson<PlannerEvent>(`/api/planner-events/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

export async function deleteEvent(id: string): Promise<void> {
  if (demo.isDemo()) return demo.deleteEvent(id);
  await call(`/api/planner-events/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* --- settings -------------------------------------------------------------- */

/**
 * Store the whole settings document and return what the server saved.
 *
 * There is no `getSettings`: the bootstrap read already carries them, so a
 * separate fetch would be a round trip for data the client has (V2 §3.2).
 */
export function putSettings(settings: Settings): Promise<Settings> {
  if (demo.isDemo()) return demo.putSettings(settings);
  return callJson<Settings>('/api/settings', { method: 'PUT', body: settings });
}
