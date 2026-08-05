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

/**
 * The duration chips the composer offers, in minutes: 15m · 30m · 1h · 2h · 4h.
 *
 * A *preset* list, not the set of legal values. A grid resize produces any
 * multiple of 15 in `[MIN_DURATION_MINUTES, MAX_DURATION_MINUTES]`, and the
 * composer shows those as "Custom" (V2 §9).
 */
export const DURATION_PRESETS = [15, 30, 60, 120, 240] as const;

/** The grid every schedule time and duration lands on, in minutes. */
export const SCHEDULE_STEP_MINUTES = 15;

/** Shortest committed duration. */
export const MIN_DURATION_MINUTES = 15;

/** Longest committed duration — twelve hours. */
export const MAX_DURATION_MINUTES = 720;

/**
 * The length a scheduled task with no committed duration occupies, in minutes.
 *
 * Dropping onto the grid does not invent a duration (V2 §3.1); the block simply
 * renders at this length with a dotted outline until a resize commits one. Both
 * the midnight-crossing rule and the lane packing measure such a block with
 * this, so "how long is it" has one answer.
 */
export const DEFAULT_BLOCK_MINUTES = 30;

/** True for a value that may be stored as a task's `durationMinutes`. */
export function isValidDurationMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_DURATION_MINUTES &&
    value <= MAX_DURATION_MINUTES &&
    value % SCHEDULE_STEP_MINUTES === 0
  );
}

/** 1..5, or null when the user has not set one. Unset is weighted as 3. */
export type Difficulty = 1 | 2 | 3 | 4 | 5;

/** The difficulty an unset task is weighted at. */
export const DEFAULT_DIFFICULTY: Difficulty = 3;

export function isDifficulty(value: unknown): value is Difficulty {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/** Optional per-board progress accent. Null follows the active theme accent. */
export const BOARD_ACCENTS = [
  'coral',
  'amber',
  'lime',
  'emerald',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'violet',
  'rose',
] as const;

export type BoardAccent = (typeof BOARD_ACCENTS)[number];

export function isBoardAccent(value: unknown): value is BoardAccent {
  return BOARD_ACCENTS.includes(value as BoardAccent);
}

export interface Board {
  id: string;
  context: Context;
  name: string;
  description: string | null;
  /** Progress-bar and board-dot accent. Null follows the active theme. */
  accent: BoardAccent | null;
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
  /**
   * The estimate, in minutes: a multiple of 15 in [15, 720], or null when the
   * user has not committed a length.
   */
  durationMinutes: number | null;
  /**
   * Epoch ms of the local wall-clock start of this task's block, or null while
   * unscheduled. Always snapped to the 15-minute grid. A task has at most one
   * block (V2 §2); work needing two sittings is two tasks.
   */
  scheduledAt: number | null;
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

/**
 * User settings. V2 §3.2.
 *
 * Stored server-side as one JSON document under `key = 'settings'` rather than
 * a column per value: five values read and written as a unit by one user, and
 * every future planner preference would otherwise be a migration. The theme is
 * deliberately *not* here — it has to apply before first paint, which rules out
 * a fetch, so it stays in localStorage (V2 §2).
 */
export interface Settings {
  /** Minutes from local midnight. Default 540 (9:00 AM). */
  workdayStartMinutes: number;
  /** Minutes from local midnight. Default 1020 (5:00 PM). Must exceed start. */
  workdayEndMinutes: number;
  plannerView: PlannerView;
  plannerGroupByBoard: boolean;
  plannerSort: PlannerSort;
}

export type PlannerView = 'week' | 'month' | 'year';

export const PLANNER_VIEWS: readonly PlannerView[] = ['week', 'month', 'year'] as const;

export type PlannerSort = 'priority' | 'difficulty' | 'dueDate' | 'duration';

export const PLANNER_SORTS: readonly PlannerSort[] = [
  'priority',
  'difficulty',
  'dueDate',
  'duration',
] as const;

/** The whole world, as returned by the bootstrap read. */
export interface AppState {
  boards: Board[];
  tasks: Task[];
  settings: Settings;
}

/** The only error shape the API emits. */
export interface ApiError {
  error: string;
  /** Seconds to wait before retrying, when the response is rate limited. */
  retryAfter?: number;
}
