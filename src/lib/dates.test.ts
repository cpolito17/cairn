import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  formatCompactTime,
  dueAt,
  formatDate,
  formatDue,
  formatDuration,
  formatOverdue,
  formatTime,
  isOverdue,
  isoDate,
} from './dates';

/** A fixed local moment: 2026-08-03, 09:00. */
const NOW = new Date(2026, 7, 3, 9, 0, 0, 0).getTime();

describe('isoDate', () => {
  it('formats a local moment, not a UTC one', () => {
    // 11 PM local on the 3rd is the 4th in UTC for a westward offset; the wire
    // format is local, so this must still read as the 3rd.
    expect(isoDate(new Date(2026, 7, 3, 23, 0).getTime())).toBe('2026-08-03');
  });
});

describe('daysUntil', () => {
  it('counts whole days from today', () => {
    expect(daysUntil('2026-08-03', NOW)).toBe(0);
    expect(daysUntil('2026-08-04', NOW)).toBe(1);
    expect(daysUntil('2026-08-02', NOW)).toBe(-1);
    expect(daysUntil('2026-08-10', NOW)).toBe(7);
  });

  it('is unaffected by the time of day', () => {
    const lateAtNight = new Date(2026, 7, 3, 23, 59).getTime();
    expect(daysUntil('2026-08-04', lateAtNight)).toBe(1);
  });
});

describe('formatDate', () => {
  it('names the near days', () => {
    expect(formatDate('2026-08-03', NOW)).toBe('Today');
    expect(formatDate('2026-08-04', NOW)).toBe('Tomorrow');
    expect(formatDate('2026-08-02', NOW)).toBe('Yesterday');
  });

  it('uses the weekday inside the coming week', () => {
    // 2026-08-06 is a Thursday.
    expect(formatDate('2026-08-06', NOW)).toBe('Thu');
  });

  it('falls back to a date, and adds the year once it differs', () => {
    expect(formatDate('2026-09-12', NOW)).toBe('Sep 12');
    expect(formatDate('2027-01-05', NOW)).toBe('Jan 5, 2027');
  });
});

describe('formatTime', () => {
  it('is 12-hour with a meridiem', () => {
    expect(formatTime('15:00')).toBe('3:00 PM');
    expect(formatTime('09:05')).toBe('9:05 AM');
    expect(formatTime('00:30')).toBe('12:30 AM');
    expect(formatTime('12:00')).toBe('12:00 PM');
  });
});

describe('formatDue', () => {
  it('is the date alone when there is no time', () => {
    expect(formatDue({ dueDate: '2026-08-04', dueTime: null }, NOW)).toBe('Tomorrow');
  });

  it('pairs the date with the time when there is one', () => {
    expect(formatDue({ dueDate: '2026-08-04', dueTime: '15:00' }, NOW)).toBe('Tomorrow · 3:00 PM');
  });

  it('is null with no date', () => {
    expect(formatDue({ dueDate: null, dueTime: null }, NOW)).toBeNull();
  });
});

describe('dueAt', () => {
  it('puts an untimed task at the end of its day, matching Up Next', () => {
    expect(dueAt({ dueDate: '2026-08-03', dueTime: null })).toBe(
      new Date(2026, 7, 3, 23, 59).getTime(),
    );
  });
});

describe('isOverdue / formatOverdue', () => {
  const overdueTask = { dueDate: '2026-08-01', dueTime: '10:00', completedAt: null };

  it('is overdue once the moment has passed', () => {
    expect(isOverdue(overdueTask, NOW)).toBe(true);
    // 47 hours elapsed. Whole days only — "1 day", never a rounded-up "2 days".
    expect(formatOverdue(overdueTask, NOW)).toBe('Overdue by 1 day');
    expect(formatOverdue({ ...overdueTask, dueDate: '2026-07-31' }, NOW)).toBe(
      'Overdue by 2 days',
    );
  });

  it('reads in hours under a day', () => {
    const task = { dueDate: '2026-08-03', dueTime: '06:00', completedAt: null };
    expect(formatOverdue(task, NOW)).toBe('Overdue by 3h');
  });

  it('never reports a completed task as overdue', () => {
    expect(isOverdue({ ...overdueTask, completedAt: NOW }, NOW)).toBe(false);
    expect(formatOverdue({ ...overdueTask, completedAt: NOW }, NOW)).toBeNull();
  });

  it('an untimed task is not overdue until its day is out', () => {
    const today = { dueDate: '2026-08-03', dueTime: null, completedAt: null };
    expect(isOverdue(today, NOW)).toBe(false);
  });
});

describe('formatDuration', () => {
  it('spells out the half day and leaves the rest compact', () => {
    expect(formatDuration(15)).toBe('15m');
    expect(formatDuration(240)).toBe('4h');
    expect(formatDuration(105)).toBe('1h 45m');
    expect(formatDuration(720)).toBe('12h');
  });
});

describe('formatCompactTime', () => {
  const at = (hour: number, minute = 0) =>
    new Date(2026, 7, 3, hour, minute, 0, 0).getTime();

  it('drops everything a month cell has no room for', () => {
    expect(formatCompactTime(at(9))).toBe('9a');
    expect(formatCompactTime(at(9, 30))).toBe('9:30a');
    expect(formatCompactTime(at(14))).toBe('2p');
    expect(formatCompactTime(at(14, 15))).toBe('2:15p');
  });

  it('reads noon and midnight as twelve, not as zero', () => {
    expect(formatCompactTime(at(12))).toBe('12p');
    expect(formatCompactTime(at(0, 30))).toBe('12:30a');
  });
});
