/**
 * Settings: the defaults, and the lenient read of a stored document.
 *
 * Settings are the one value in the app that is *parsed* rather than typed by
 * its column — everything else is a row the database shaped (V2 §3.2). That
 * makes a stored document the one place a corrupt value can enter the app
 * without going through the boundary validation that keeps everything else
 * honest, so it gets read defensively: a document that is not an object, or a
 * field that is not what it claims, falls back to the default rather than
 * failing the load. Losing a preference is an inconvenience; a settings row
 * that cannot be parsed taking the whole app down with it is not.
 *
 * The fallback is per field on purpose. A document written by an older version
 * is simply missing whatever was added since, and rejecting it wholesale would
 * throw away working hours the user did set to punish them for a field they
 * never saw.
 *
 * The strict direction — validating a `PUT /api/settings` body, where a bad
 * value is a 400 and not something to quietly repair — lives in
 * `worker/validate.ts`.
 */

import {
  PLANNER_SORTS,
  PLANNER_VIEWS,
  isReminderLead,
  isTimeZone,
  type PlannerSort,
  type PlannerView,
  type Settings,
} from './types';

/** The key the document is stored under in the `settings` table. */
export const SETTINGS_KEY = 'settings';

/** Minutes in a day. A workday bound is a minute offset from local midnight. */
export const MINUTES_PER_DAY = 1440;

/**
 * The defaults, in one place. Referenced by the Worker when no row exists, by
 * the client before its first load, and by the fallbacks below.
 */
export const DEFAULT_SETTINGS: Settings = {
  workdayStartMinutes: 540, // 9:00 AM
  workdayEndMinutes: 1020, // 5:00 PM
  plannerView: 'week',
  plannerGroupByBoard: false,
  plannerSort: 'dueDate',

  // Notifications are off until asked for, because turning them on is a
  // permission prompt and a subscription, not a preference.
  notificationsEnabled: false,
  // UTC rather than a guess at where the owner lives: a wrong-looking zone in
  // the picker is a thing you notice and fix, and a plausible-looking wrong one
  // is a thing you do not. The sheet offers the device's own zone in one tap.
  timeZone: 'UTC',
  weekdayStartMinutes: 480, // 8:00 AM, Mon–Fri
  weekendStartMinutes: 600, // 10:00 AM, Sat–Sun
  dueReminderLeadMinutes: 5,
};

/** A minute offset inside a day: an integer in [0, 1440]. */
export function isDayMinute(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MINUTES_PER_DAY
  );
}

/**
 * A minute offset that names a *moment in* a day: an integer in [0, 1439].
 *
 * Distinct from `isDayMinute`, which accepts 1440 because a workday *end* of
 * midnight is a real answer. A start-of-day notification time at 1440 is not:
 * the clock never reads 24:00, so the digest would simply never fire, silently.
 */
export function isMomentInDay(value: unknown): value is number {
  return isDayMinute(value) && value < MINUTES_PER_DAY;
}

export function isPlannerView(value: unknown): value is PlannerView {
  return typeof value === 'string' && (PLANNER_VIEWS as readonly string[]).includes(value);
}

export function isPlannerSort(value: unknown): value is PlannerSort {
  return typeof value === 'string' && (PLANNER_SORTS as readonly string[]).includes(value);
}

/**
 * A stored JSON string as `Settings`. Never throws.
 *
 * `null` — no row at all — is not an error either: it is a database that has
 * never had settings written to it, which is every database until the first
 * write, and it means the defaults.
 */
export function parseStoredSettings(stored: string | null): Settings {
  if (stored === null) return DEFAULT_SETTINGS;
  try {
    return coerceSettings(JSON.parse(stored));
  } catch {
    // Not JSON at all. The defaults are the honest answer, and the alternative
    // is a load that fails for a reason the user cannot see or fix.
    return DEFAULT_SETTINGS;
  }
}

/** Any value as `Settings`, field by field, defaulting whatever does not fit. */
export function coerceSettings(value: unknown): Settings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_SETTINGS;
  }
  const raw = value as Record<string, unknown>;

  const start = isDayMinute(raw.workdayStartMinutes)
    ? raw.workdayStartMinutes
    : DEFAULT_SETTINGS.workdayStartMinutes;
  const end = isDayMinute(raw.workdayEndMinutes)
    ? raw.workdayEndMinutes
    : DEFAULT_SETTINGS.workdayEndMinutes;

  // The two bounds are one fact, so they fall back together: a stored start of
  // 6:00 PM next to a defaulted end of 5:00 PM would be a workday that ends
  // before it begins, which is exactly what the write path refuses.
  const workday =
    end > start
      ? { workdayStartMinutes: start, workdayEndMinutes: end }
      : {
          workdayStartMinutes: DEFAULT_SETTINGS.workdayStartMinutes,
          workdayEndMinutes: DEFAULT_SETTINGS.workdayEndMinutes,
        };

  return {
    ...workday,
    plannerView: isPlannerView(raw.plannerView) ? raw.plannerView : DEFAULT_SETTINGS.plannerView,
    plannerGroupByBoard:
      typeof raw.plannerGroupByBoard === 'boolean'
        ? raw.plannerGroupByBoard
        : DEFAULT_SETTINGS.plannerGroupByBoard,
    plannerSort: isPlannerSort(raw.plannerSort) ? raw.plannerSort : DEFAULT_SETTINGS.plannerSort,

    // Notifications default *closed* on anything unreadable. Every other field
    // here falls back to something the user will notice and correct; a
    // notification field that fell back to "on" would send a push at an hour
    // nobody chose, which is the one failure mode this feature must not have.
    notificationsEnabled:
      typeof raw.notificationsEnabled === 'boolean' ? raw.notificationsEnabled : false,
    timeZone: isTimeZone(raw.timeZone) ? raw.timeZone : DEFAULT_SETTINGS.timeZone,
    weekdayStartMinutes: isMomentInDay(raw.weekdayStartMinutes)
      ? raw.weekdayStartMinutes
      : DEFAULT_SETTINGS.weekdayStartMinutes,
    weekendStartMinutes: isMomentInDay(raw.weekendStartMinutes)
      ? raw.weekendStartMinutes
      : DEFAULT_SETTINGS.weekendStartMinutes,
    dueReminderLeadMinutes: isReminderLead(raw.dueReminderLeadMinutes)
      ? raw.dueReminderLeadMinutes
      : DEFAULT_SETTINGS.dueReminderLeadMinutes,
  };
}
