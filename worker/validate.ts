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

import { isContext, isDifficulty, isDuration } from '../shared/types';
import type { Context, Difficulty, Duration } from '../shared/types';

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

export function nullableDifficulty(value: unknown): Difficulty | null {
  if (value === null) return null;
  if (!isDifficulty(value)) throw new BadRequest('difficulty must be an integer 1-5 or null');
  return value;
}

export function nullableDuration(value: unknown): Duration | null {
  if (value === null) return null;
  if (!isDuration(value)) {
    throw new BadRequest("duration must be one of '15m','30m','1h','2h','4h','half-day' or null");
  }
  return value;
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
