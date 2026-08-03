/**
 * Date and duration formatting for chips, Up Next, and the composer.
 *
 * Everything here is local-time and pure: `now` is always injected so the same
 * inputs give the same string in a test as they do at 11:59 PM. The wire format
 * is `YYYY-MM-DD` plus optional `HH:MM` (§6.4), and a date with no time means
 * "sometime that day" — the same convention `shared/upnext.ts` encodes by
 * sorting untimed tasks at 23:59.
 *
 * The month and weekday names are spelled out here rather than delegated to
 * `Intl`, because the app's own strings ("Today", "Overdue by 2 days") are
 * English regardless, and a half-localized chip reads worse than an unlocalized
 * one.
 */

import type { Duration, Task } from '../../shared/types';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for a local-time moment. */
export function isoDate(at: number): string {
  const d = new Date(at);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Local midnight at the start of the day containing `at`. */
export function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight of a `YYYY-MM-DD` string. */
export function dateAtMidnight(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

/**
 * Whole days from today to `iso` — 0 today, 1 tomorrow, -1 yesterday.
 *
 * Computed from midnight to midnight rather than by dividing a raw difference,
 * so a DST boundary between the two dates cannot round the answer off by one.
 */
export function daysUntil(iso: string, now: number): number {
  return Math.round((dateAtMidnight(iso) - startOfDay(now)) / DAY_MS);
}

/** "3:00 PM" from `15:00`. */
export function formatTime(hhmm: string): string {
  const [hour, minute] = hhmm.split(':').map(Number);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/**
 * "Today", "Tomorrow", "Yesterday", a weekday inside the coming week, then
 * "Aug 12", and "Aug 12, 2027" once the year differs.
 */
export function formatDate(iso: string, now: number): string {
  const delta = daysUntil(iso, now);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta === -1) return 'Yesterday';

  const at = new Date(dateAtMidnight(iso));
  if (delta > 1 && delta < 7) return WEEKDAYS[at.getDay()];

  const stem = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === new Date(now).getFullYear() ? stem : `${stem}, ${at.getFullYear()}`;
}

/** The date, plus the time when there is one: "Tomorrow · 3:00 PM". */
export function formatDue(
  task: Pick<Task, 'dueDate' | 'dueTime'>,
  now: number,
): string | null {
  if (task.dueDate === null) return null;
  const date = formatDate(task.dueDate, now);
  return task.dueTime === null ? date : `${date} · ${formatTime(task.dueTime)}`;
}

/**
 * The moment a task is due — 23:59 local when it carries no time, matching
 * `shared/upnext.ts`. Null when it has no date at all.
 */
export function dueAt(task: Pick<Task, 'dueDate' | 'dueTime'>): number | null {
  if (task.dueDate === null) return null;
  const [year, month, day] = task.dueDate.split('-').map(Number);
  const [hour, minute] = task.dueTime ? task.dueTime.split(':').map(Number) : [23, 59];
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

export function isOverdue(task: Pick<Task, 'dueDate' | 'dueTime' | 'completedAt'>, now: number): boolean {
  if (task.completedAt !== null) return false;
  const at = dueAt(task);
  return at !== null && at < now;
}

/**
 * "Overdue by 3h" / "Overdue by 2 days". Null when the task is not overdue.
 *
 * Under a day the figure is hours, because "Overdue by 0 days" is worse than
 * useless; at or past a day it is days, because "Overdue by 53h" is arithmetic
 * the reader should not have to do.
 */
export function formatOverdue(
  task: Pick<Task, 'dueDate' | 'dueTime' | 'completedAt'>,
  now: number,
): string | null {
  const at = dueAt(task);
  if (at === null || task.completedAt !== null || at >= now) return null;

  const elapsed = now - at;
  if (elapsed < DAY_MS) {
    const hours = Math.max(1, Math.floor(elapsed / 3_600_000));
    return `Overdue by ${hours}h`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return `Overdue by ${days} ${days === 1 ? 'day' : 'days'}`;
}

const DURATION_LABELS: Record<Duration, string> = {
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  'half-day': 'Half day',
};

export function formatDuration(duration: Duration): string {
  return DURATION_LABELS[duration];
}
