/**
 * Wire types shared by the client and the Worker.
 *
 * These describe JSON on the wire, so every field is camelCase. The database
 * columns are snake_case; `worker/db.ts` owns that mapping and nothing else
 * should be aware of it. All timestamps are epoch milliseconds.
 */

/** The two fixed tabs. Not user-creatable. */
export type Context = 'personal' | 'work';

export const CONTEXTS: readonly Context[] = ['personal', 'work'] as const;

export function isContext(value: unknown): value is Context {
  return value === 'personal' || value === 'work';
}

/** The fixed duration options a task can carry. */
export type Duration = '15m' | '30m' | '1h' | '2h' | '4h' | 'half-day';

export const DURATIONS: readonly Duration[] = ['15m', '30m', '1h', '2h', '4h', 'half-day'] as const;

export function isDuration(value: unknown): value is Duration {
  return typeof value === 'string' && (DURATIONS as readonly string[]).includes(value);
}

/** 1..5, or null when the user has not set one. Unset is weighted as 3. */
export type Difficulty = 1 | 2 | 3 | 4 | 5;

/** The difficulty an unset task is weighted at. */
export const DEFAULT_DIFFICULTY: Difficulty = 3;

export function isDifficulty(value: unknown): value is Difficulty {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

export interface Board {
  id: string;
  context: Context;
  name: string;
  description: string | null;
  /** Fractional index within its context. See `shared/order.ts`. */
  position: string;
  /** Epoch ms when archived, or null while active. */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  boardId: string;
  name: string;
  notes: string | null;
  /** `YYYY-MM-DD`. */
  dueDate: string | null;
  /** `HH:MM`, 24h. Only meaningful when `dueDate` is set. */
  dueTime: string | null;
  duration: Duration | null;
  difficulty: Difficulty | null;
  /** Binary flag, not a scale. */
  priority: boolean;
  /**
   * The user's own "I am stuck on this" flag. Independent of `dependsOn`: this
   * one is asserted by hand and cleared by hand, and nothing resolves it.
   */
  blocked: boolean;
  /**
   * The task this one is waiting on, or null. Always another task on the *same
   * board*, never itself, and never a link that would close a cycle — the
   * Worker enforces all three.
   *
   * A task whose prerequisite is incomplete cannot be completed; see
   * `shared/dependencies.ts`, which is the only place that rule is written.
   */
  dependsOn: string | null;
  /** Fractional index within its board's active list. */
  position: string;
  createdAt: number;
  /** Epoch ms when completed, or null while active. */
  completedAt: number | null;
  updatedAt: number;
}

/** The whole world, as returned by the bootstrap read. */
export interface AppState {
  boards: Board[];
  tasks: Task[];
}

/** The only error shape the API emits. */
export interface ApiError {
  error: string;
  /** Seconds to wait before retrying, when the response is rate limited. */
  retryAfter?: number;
}
