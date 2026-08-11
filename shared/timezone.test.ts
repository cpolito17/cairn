import { describe, expect, it } from 'vitest';
import {
  daysBetweenKeys,
  dueAtInZone,
  formatDayMinute,
  formatWireTime,
  isWeekday,
  startOfZonedDay,
  zonedDayKey,
  zonedMinutes,
  zonedParts,
  zonedTimeToEpoch,
} from './timezone';

const DETROIT = 'America/Detroit';

describe('zonedParts', () => {
  it('reads a UTC instant as the local clock in a western zone', () => {
    // 2026-08-11T02:30Z is still the 10th, 10:30 PM, in Detroit (UTC-4).
    const parts = zonedParts(Date.UTC(2026, 7, 11, 2, 30), DETROIT);
    expect(parts).toMatchObject({ year: 2026, month: 8, day: 10, hour: 22, minute: 30 });
    expect(parts.weekday).toBe(1); // Monday
  });

  it('reads midnight as hour 0, not hour 24', () => {
    // The h23 hour cycle prints "24" for midnight on some ICU builds, which
    // would land a 12:05 AM reading on the previous day.
    expect(zonedParts(Date.UTC(2026, 7, 11, 4, 5), DETROIT)).toMatchObject({
      day: 11,
      hour: 0,
      minute: 5,
    });
  });

  it('tracks a daylight-saving transition', () => {
    // US DST ends 2026-11-01. 05:30Z is 1:30 AM EDT; 06:30Z is 1:30 AM EST.
    expect(zonedParts(Date.UTC(2026, 10, 1, 5, 30), DETROIT).hour).toBe(1);
    expect(zonedParts(Date.UTC(2026, 10, 1, 6, 30), DETROIT).hour).toBe(1);
    expect(zonedParts(Date.UTC(2026, 10, 1, 7, 30), DETROIT).hour).toBe(2);
  });
});

describe('zonedDayKey and zonedMinutes', () => {
  it('names the local day, not the UTC one', () => {
    expect(zonedDayKey(Date.UTC(2026, 7, 11, 2, 30), DETROIT)).toBe('2026-08-10');
    expect(zonedDayKey(Date.UTC(2026, 7, 11, 2, 30), 'UTC')).toBe('2026-08-11');
  });

  it('counts minutes from local midnight', () => {
    expect(zonedMinutes(Date.UTC(2026, 7, 11, 12, 0), DETROIT)).toBe(8 * 60);
    expect(zonedMinutes(Date.UTC(2026, 7, 11, 4, 0), DETROIT)).toBe(0);
  });
});

describe('isWeekday', () => {
  it('is true Monday through Friday in the named zone', () => {
    // Saturday 2026-08-15 at 03:00Z is still Friday evening in Detroit.
    expect(isWeekday(Date.UTC(2026, 7, 15, 3, 0), DETROIT)).toBe(true);
    expect(isWeekday(Date.UTC(2026, 7, 15, 3, 0), 'UTC')).toBe(false);
    expect(isWeekday(Date.UTC(2026, 7, 16, 16, 0), DETROIT)).toBe(false); // Sunday
  });
});

describe('zonedTimeToEpoch', () => {
  it('inverts zonedParts', () => {
    for (const at of [
      Date.UTC(2026, 0, 15, 9, 0),
      Date.UTC(2026, 6, 4, 23, 45),
      Date.UTC(2026, 10, 1, 6, 30),
      Date.UTC(2026, 2, 8, 8, 15),
    ]) {
      const p = zonedParts(at, DETROIT);
      const round = zonedTimeToEpoch(DETROIT, p.year, p.month, p.day, p.hour, p.minute);
      // Seconds are dropped by construction; the minute must survive.
      expect(zonedParts(round, DETROIT)).toMatchObject({
        year: p.year,
        month: p.month,
        day: p.day,
        hour: p.hour,
        minute: p.minute,
      });
    }
  });

  it('places 8:00 AM Detroit at the right UTC instant on both sides of DST', () => {
    // July: EDT, UTC-4. December: EST, UTC-5. (`Date.UTC` months are 0-based;
    // this module's are not, which is why both forms appear on each line.)
    expect(zonedTimeToEpoch(DETROIT, 2026, 7, 11, 8, 0)).toBe(Date.UTC(2026, 6, 11, 12, 0));
    expect(zonedTimeToEpoch(DETROIT, 2026, 12, 11, 8, 0)).toBe(Date.UTC(2026, 11, 11, 13, 0));
  });

  it('resolves the hour that spring-forward skips without throwing', () => {
    // 2026-03-08 02:30 does not exist in Detroit. The convention is to land
    // just past the gap rather than to fail — a reminder at a time that does
    // not exist should still fire, once.
    const at = zonedTimeToEpoch(DETROIT, 2026, 3, 8, 2, 30);
    expect(Number.isFinite(at)).toBe(true);
    expect(zonedParts(at, DETROIT).hour).toBe(3);
  });
});

describe('dueAtInZone', () => {
  it('treats a date with no time as the end of that day', () => {
    expect(dueAtInZone('2026-08-11', null, DETROIT)).toBe(
      zonedTimeToEpoch(DETROIT, 2026, 8, 11, 23, 59),
    );
  });

  it('places a timed due moment at that wall-clock time', () => {
    expect(dueAtInZone('2026-08-11', '13:30', DETROIT)).toBe(Date.UTC(2026, 7, 11, 17, 30));
  });
});

describe('startOfZonedDay', () => {
  it('is local midnight, not UTC midnight', () => {
    const at = Date.UTC(2026, 7, 11, 18, 0);
    expect(startOfZonedDay(at, DETROIT)).toBe(Date.UTC(2026, 7, 11, 4, 0));
    expect(zonedMinutes(startOfZonedDay(at, DETROIT), DETROIT)).toBe(0);
  });
});

describe('formatting', () => {
  it('renders minute offsets as a 12-hour clock', () => {
    expect(formatDayMinute(0)).toBe('12:00 AM');
    expect(formatDayMinute(480)).toBe('8:00 AM');
    expect(formatDayMinute(750)).toBe('12:30 PM');
    expect(formatDayMinute(1385)).toBe('11:05 PM');
  });

  it('renders wire times the same way', () => {
    expect(formatWireTime('13:30')).toBe('1:30 PM');
    expect(formatWireTime('00:15')).toBe('12:15 AM');
  });
});

describe('daysBetweenKeys', () => {
  it('counts calendar days, unaffected by DST', () => {
    expect(daysBetweenKeys('2026-08-10', '2026-08-11')).toBe(1);
    expect(daysBetweenKeys('2026-08-11', '2026-08-10')).toBe(-1);
    expect(daysBetweenKeys('2026-10-25', '2026-11-05')).toBe(11);
    expect(daysBetweenKeys('2026-08-11', '2026-08-11')).toBe(0);
  });
});
