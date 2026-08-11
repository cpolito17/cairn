/**
 * Boundary validation.
 *
 * The only place untrusted input is checked. Everything past it is trusted:
 * rows the database produced, positions `shared/order.ts` generated, ids this
 * code minted. Re-checking those would be theatre.
 *
 * Each helper either returns a well-typed value or throws `BadRequest`, which
 * the route module turns into a `400 {"error":"..."}`. Throwing rather than
 * threading a result type keeps the parsers readable and — more to the point —
 * makes it impossible to validate a field and then forget to check the answer.
 */

import { crossesMidnight, effectiveMinutes, isSnapped } from '../shared/schedule';
import { isDayMinute, isMomentInDay, isPlannerSort, isPlannerView } from '../shared/settings';
import {
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  SCHEDULE_STEP_MINUTES,
  isBoardAccent,
  isContext,
  isDifficulty,
  isReminderLead,
  isTimeZone,
  isValidDurationMinutes,
} from '../shared/types';
import type { Context, Difficulty, Settings, Task } from '../shared/types';
import type { BoardAccent } from '../shared/types';

/** Longest a task name may be (§6.4: "up to ~120 characters"). */
export const MAX_TASK_NAME = 120;
/** Longest a board name may be. */
export const MAX_BOARD_NAME = 80;

export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest';
  }
}

/** Parse a JSON object body. A non-object or malformed body is a 400. */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new BadRequest('body must be JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequest('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** True when the key is absent or explicitly `undefined` — i.e. not being set. */
export function absent(body: Record<string, unknown>, key: string): boolean {
  return body[key] === undefined;
}

export function requiredName(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new BadRequest(`${label} is required`);
  const name = value.trim();
  if (name.length === 0) throw new BadRequest(`${label} is required`);
  if (name.length > max) throw new BadRequest(`${label} must be ${max} characters or fewer`);
  return name;
}

export function requiredContext(value: unknown): Context {
  if (!isContext(value)) throw new BadRequest("context must be 'personal' or 'work'");
  return value;
}

/** A client-generated position. The server stores it; it does not judge it. */
export function requiredPosition(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest('position must be a non-empty string');
  }
  return value;
}

export function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`${label} is required`);
  }
  return value;
}

/** An optional reference to another row: a non-empty id, or null to clear it. */
export function nullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`${label} must be an id or null`);
  }
  return value;
}

export function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequest(`${label} must be a string or null`);
  return value;
}

export function nullableBoardAccent(value: unknown): BoardAccent | null {
  if (value === null) return null;
  if (!isBoardAccent(value)) throw new BadRequest('accent must be a supported board accent or null');
  return value;
}

export function nullableDifficulty(value: unknown): Difficulty | null {
  if (value === null) return null;
  if (!isDifficulty(value)) throw new BadRequest('difficulty must be an integer 1-5 or null');
  return value;
}

/**
 * A duration in minutes: null, or an integer multiple of 15 in [15, 720].
 *
 * The grid is the reason for the multiple. A duration off the grid cannot be
 * drawn on the Planner without either lying about it or re-snapping it, and a
 * server that re-snaps silently is one the client's optimistic state disagrees
 * with — so it is refused here instead.
 */
export function nullableDurationMinutes(value: unknown): number | null {
  if (value === null) return null;
  if (!isValidDurationMinutes(value)) {
    throw new BadRequest(
      `durationMinutes must be a multiple of ${SCHEDULE_STEP_MINUTES} between ` +
        `${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}, or null`,
    );
  }
  return value;
}

/**
 * A block start: null, or epoch ms already snapped to the 15-minute grid.
 *
 * **Never rounded here.** The client snaps before it sends, and it draws the
 * block where it snapped it; a server that quietly moved the value would leave
 * the optimistic state and the stored row describing two different Tuesdays,
 * and nothing would ever surface the difference. An unsnapped value is a client
 * bug, and a 400 is how it gets found.
 */
export function nullableScheduledAt(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new BadRequest('scheduledAt must be an epoch-millisecond integer or null');
  }
  if (!isSnapped(value)) {
    throw new BadRequest(
      `scheduledAt must be snapped to the ${SCHEDULE_STEP_MINUTES}-minute grid`,
    );
  }
  return value;
}

/**
 * A block may not cross local midnight (§3.1).
 *
 * Checked against the task's *resulting* state rather than the patch alone: a
 * request that only lengthens the duration of an already-late block crosses
 * midnight just as surely as one that moves it there, and the patch on its own
 * cannot see that.
 */
export function assertBlockWithinDay(
  resulting: Pick<Task, 'durationMinutes' | 'scheduledAt'>,
): void {
  if (resulting.scheduledAt === null) return;
  if (crossesMidnight(resulting.scheduledAt, effectiveMinutes(resulting))) {
    throw new BadRequest('a block may not cross midnight');
  }
}

/**
 * A whole settings document. `PUT /api/settings` takes all of it, so every
 * field is required and a missing one is a 400 rather than a silent default —
 * the lenient direction is for documents already in the database
 * (`shared/settings.ts`), not for what a client is asking to store.
 */
export function requiredSettings(value: unknown): Settings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequest('settings must be a JSON object');
  }
  const raw = value as Record<string, unknown>;

  if (!isDayMinute(raw.workdayStartMinutes)) {
    throw new BadRequest('workdayStartMinutes must be an integer between 0 and 1440');
  }
  if (!isDayMinute(raw.workdayEndMinutes)) {
    throw new BadRequest('workdayEndMinutes must be an integer between 0 and 1440');
  }
  // A workday that ends before it starts describes no hours at all, and every
  // surface that reads these two would have to invent a rule for it.
  if (raw.workdayEndMinutes <= raw.workdayStartMinutes) {
    throw new BadRequest('workdayEndMinutes must be greater than workdayStartMinutes');
  }
  if (!isPlannerView(raw.plannerView)) {
    throw new BadRequest("plannerView must be 'week', 'month', or 'year'");
  }
  if (typeof raw.plannerGroupByBoard !== 'boolean') {
    throw new BadRequest('plannerGroupByBoard must be true or false');
  }
  if (!isPlannerSort(raw.plannerSort)) {
    throw new BadRequest("plannerSort must be 'priority', 'difficulty', 'dueDate', or 'duration'");
  }

  if (typeof raw.notificationsEnabled !== 'boolean') {
    throw new BadRequest('notificationsEnabled must be true or false');
  }
  // The zone is what turns "8:00 AM" into an instant the cron can compare
  // against. A zone the runtime does not know would leave the scheduled job
  // throwing once a minute, forever, with nothing on screen to say why.
  if (!isTimeZone(raw.timeZone)) {
    throw new BadRequest('timeZone must be an IANA time zone name');
  }
  if (!isMomentInDay(raw.weekdayStartMinutes)) {
    throw new BadRequest('weekdayStartMinutes must be an integer between 0 and 1439');
  }
  if (!isMomentInDay(raw.weekendStartMinutes)) {
    throw new BadRequest('weekendStartMinutes must be an integer between 0 and 1439');
  }
  if (!isReminderLead(raw.dueReminderLeadMinutes)) {
    throw new BadRequest('dueReminderLeadMinutes must be a supported lead time, or null');
  }

  return {
    workdayStartMinutes: raw.workdayStartMinutes,
    workdayEndMinutes: raw.workdayEndMinutes,
    plannerView: raw.plannerView,
    plannerGroupByBoard: raw.plannerGroupByBoard,
    plannerSort: raw.plannerSort,
    notificationsEnabled: raw.notificationsEnabled,
    timeZone: raw.timeZone,
    weekdayStartMinutes: raw.weekdayStartMinutes,
    weekendStartMinutes: raw.weekendStartMinutes,
    dueReminderLeadMinutes: raw.dueReminderLeadMinutes,
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function nullableDueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isRealDate(value)) {
    throw new BadRequest('dueDate must be a calendar date formatted YYYY-MM-DD, or null');
  }
  return value;
}

export function nullableDueTime(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw new BadRequest('dueTime must be a 24-hour time formatted HH:MM, or null');
  }
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequest(`${label} must be true or false`);
  return value;
}

/**
 * A time without a date has nothing to be a time *of* (§6.4: due time is only
 * offerable once a date is set). Checked against the task's resulting state,
 * not the patch alone, so clearing a date while leaving a time behind is
 * caught too.
 */
export function assertTimeHasDate(dueDate: string | null, dueTime: string | null): void {
  if (dueTime !== null && dueDate === null) {
    throw new BadRequest('dueTime requires a dueDate');
  }
}

/** `2026-02-30` matches the pattern and is still not a day. */
function isRealDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
