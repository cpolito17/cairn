/**
 * Wall-clock time in a named IANA zone.
 *
 * This module exists for one reason and should be read as serving only it: the
 * Worker's scheduled job runs on a UTC cron, and "send the digest at 8:00 AM"
 * is not a computable instant without a zone. Everything else in Cairn is still
 * local wall-clock with no timezone stored (V2 §2) — the client's `Date` is the
 * user's clock, and that remains true. Nothing here is imported by the Planner.
 *
 * The whole implementation rests on `Intl.DateTimeFormat`, which carries the
 * platform's tzdata and therefore knows about DST transitions, the dates they
 * moved to, and zones that have changed their rules. Hand-rolled offset
 * arithmetic knows none of that and is wrong twice a year.
 *
 * Pure and injectable: every function takes the instant and the zone, so a test
 * asserts about 1:59 AM on the day the clocks go forward without waiting for
 * March.
 */

const MINUTE_MS = 60_000;

/** A wall-clock reading in some zone. `weekday` is 0 = Sunday. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday through 6 = Saturday, matching `Date.prototype.getDay`. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Formatters are cached because building one is the expensive part of this
 * module by an order of magnitude, and the scheduled job asks for the same one
 * or two zones on every tick for the life of the deployment.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

/** What a clock in `timeZone` reads at the instant `at`. */
export function zonedParts(at: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const read: Record<string, string> = {};
  for (const part of parts) read[part.type] = part.value;

  return {
    year: Number(read.year),
    month: Number(read.month),
    day: Number(read.day),
    // `hourCycle: 'h23'` still prints midnight as "24" on some ICU versions,
    // which would put a 12:10 AM reading on the wrong day if it were trusted.
    hour: Number(read.hour) % 24,
    minute: Number(read.minute),
    second: Number(read.second),
    weekday: WEEKDAY_INDEX[read.weekday] ?? 0,
  };
}

/** The calendar date in `timeZone` at the instant `at`, as `YYYY-MM-DD`. */
export function zonedDayKey(at: number, timeZone: string): string {
  const { year, month, day } = zonedParts(at, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Minutes since local midnight in `timeZone` at the instant `at`. 0–1439. */
export function zonedMinutes(at: number, timeZone: string): number {
  const { hour, minute } = zonedParts(at, timeZone);
  return hour * 60 + minute;
}

/** True for a Monday through Friday reading in `timeZone`. */
export function isWeekday(at: number, timeZone: string): boolean {
  const weekday = zonedParts(at, timeZone).weekday;
  return weekday >= 1 && weekday <= 5;
}

/** How far ahead of UTC `timeZone` is at the instant `at`, in milliseconds. */
function offsetMs(at: number, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  // The local reading, re-encoded as though it were UTC. The gap between that
  // and the real instant is the offset — including whatever DST was doing.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - at;
}

/**
 * The instant at which a clock in `timeZone` reads the given wall-clock time.
 *
 * The inverse of `zonedParts`, and the harder direction, because a wall-clock
 * time is not always one instant: the hour that DST skips forward over does not
 * exist, and the hour it falls back over happens twice. The two-pass refinement
 * is what handles the ordinary cases correctly — guess with the offset in force
 * *now*, then re-read the offset at the guessed instant and correct. On an
 * ambiguous repeated hour this settles on the first (pre-transition) instant,
 * which is the conventional answer.
 *
 * The skipped hour needs the explicit check below. Refinement there converges
 * on an instant whose clock reads an hour *before* what was asked for, so a
 * 2:30 AM reminder on the spring-forward Sunday would fire at 1:30. Detecting
 * that mismatch and keeping the first pass lands just past the gap instead — a
 * reminder for a time that never happened fires late rather than early, and
 * still fires exactly once.
 */
export function zonedTimeToEpoch(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstPass = wall - offsetMs(wall, timeZone);
  const refined = wall - offsetMs(firstPass, timeZone);

  const reading = zonedParts(refined, timeZone);
  const landed = reading.day === day && reading.hour === hour && reading.minute === minute;
  return landed ? refined : firstPass;
}

/**
 * The instant a `YYYY-MM-DD` date and `HH:MM` time name in `timeZone`.
 *
 * A null time means "sometime that day", which the app already sorts at the end
 * of the day (`shared/upnext.ts`), so it resolves to 23:59 for the same reason
 * and by the same convention.
 */
export function dueAtInZone(
  dueDate: string,
  dueTime: string | null,
  timeZone: string,
): number {
  const [year, month, day] = dueDate.split('-').map(Number);
  const [hour, minute] = dueTime === null ? [23, 59] : dueTime.split(':').map(Number);
  return zonedTimeToEpoch(timeZone, year, month, day, hour, minute);
}

/** Local midnight in `timeZone` at the start of the day containing `at`. */
export function startOfZonedDay(at: number, timeZone: string): number {
  const { year, month, day } = zonedParts(at, timeZone);
  return zonedTimeToEpoch(timeZone, year, month, day, 0, 0);
}

/** `2:05 PM` for a minute offset from local midnight. */
export function formatDayMinute(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minutes % 60).padStart(2, '0')} ${suffix}`;
}

/** `2:05 PM` for an `HH:MM` wire time. */
export function formatWireTime(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  return formatDayMinute(hour * 60 + minute);
}

/** Whole days between two `YYYY-MM-DD` keys, `later - earlier`. */
export function daysBetweenKeys(earlier: string, later: string): number {
  const parse = (key: string) => {
    const [year, month, day] = key.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((parse(later) - parse(earlier)) / (1440 * MINUTE_MS));
}
