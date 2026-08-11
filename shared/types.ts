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
   * The tasks this one is waiting on. Empty when nothing gates it.
   *
   * Every entry is another task on the *same board*, never itself, and never a
   * link that would close a cycle — the Worker enforces all three. Order is
   * oldest link first and is stable, so a node's incoming edges do not
   * reshuffle between two renders of the same data.
   *
   * A task with *any* incomplete prerequisite cannot be completed; see
   * `shared/dependencies.ts`, which is the only place that rule is written.
   *
   * This was a single nullable id until the §14 addendum. One prerequisite made
   * each board a forest, which is what the original Blockers layout was built
   * on; a set makes it a directed acyclic graph.
   */
  dependsOn: string[];
  /** Fractional index within its board's active list. */
  position: string;
  createdAt: number;
  /** Epoch ms when completed, or null while active. */
  completedAt: number | null;
  updatedAt: number;
}

/** A recurring calendar-only block. Events never belong to boards. */
export interface PlannerEvent {
  id: string;
  context: Context;
  name: string;
  /** Sunday = 0 through Saturday = 6. */
  weekdays: number[];
  /** Repeat every N weeks, anchored by `startsOn`. */
  frequencyWeeks: 1 | 2 | 4;
  /** Local calendar date, YYYY-MM-DD. */
  startsOn: string;
  /** Minutes from local midnight, snapped to the Planner grid. */
  startMinutes: number;
  durationMinutes: number;
  createdAt: number;
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

  /**
   * The master switch for push notifications. False disables every kind of
   * notification at the source — the scheduled job reads this before it reads
   * anything else — so turning it off does not depend on the browser also
   * having dropped its subscription.
   *
   * Notification settings are deliberately *not* per-context: one phone, one
   * set of alerts, and a digest that stopped at the context boundary would be
   * two notifications every morning saying half a thing each.
   */
  notificationsEnabled: boolean;
  /**
   * The IANA zone the scheduled job reads local wall-clock time in, e.g.
   * `America/Detroit`.
   *
   * This is the one place a timezone exists in the app, and it exists for
   * exactly one reason: cron fires in UTC, so "8:00 AM" is not a computable
   * instant without it. It is picked by hand rather than detected, so a
   * digest's hour never moves because a laptop was opened in another airport.
   * Nothing else reads it — the Planner is still local wall-clock (V2 §2).
   */
  timeZone: string;
  /** Minutes from local midnight for the Mon–Fri digest. Default 480 (8:00 AM). */
  weekdayStartMinutes: number;
  /** Minutes from local midnight for the Sat–Sun digest. Default 600 (10:00 AM). */
  weekendStartMinutes: number;
  /**
   * How many minutes *before* a task's due time its own reminder fires, or null
   * for no per-task reminders at all. A 1:30 PM task at a lead of 5 notifies at
   * 1:25 PM. Only tasks with both a due date and a due time can qualify: a task
   * due "sometime Tuesday" has no moment to count backwards from, and belongs to
   * the morning digest instead.
   */
  dueReminderLeadMinutes: number | null;
}

/** The lead times the settings sheet offers. Null is "no per-task reminders". */
export const REMINDER_LEADS: readonly (number | null)[] = [null, 0, 5, 10, 15, 30, 60] as const;

/** True for a lead the settings sheet can round-trip. */
export function isReminderLead(value: unknown): value is number | null {
  return value === null || (REMINDER_LEADS as readonly unknown[]).includes(value);
}

/**
 * True for a string `Intl` will accept as a time zone.
 *
 * Asking `Intl` rather than checking against a bundled list: the list of zones
 * changes with the platform's tzdata, and a hard-coded copy would start
 * refusing zones the runtime is perfectly happy with.
 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
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
  events: PlannerEvent[];
  settings: Settings;
}

/** The only error shape the API emits. */
export interface ApiError {
  error: string;
  /** Seconds to wait before retrying, when the response is rate limited. */
  retryAfter?: number;
}
