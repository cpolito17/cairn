import { describe, expect, it } from 'vitest';
import { eventOccurrences } from './events';
import { startOfLocalDay } from './schedule';
import type { PlannerEvent } from './types';

function at(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day).getTime();
}

const event: PlannerEvent = {
  id: 'lunch', context: 'personal', name: 'Lunch', weekdays: [1, 3], frequencyWeeks: 1,
  startsOn: '2026-08-03', startMinutes: 12 * 60, durationMinutes: 60, createdAt: 1, updatedAt: 1,
};

describe('eventOccurrences', () => {
  it('emits only selected weekdays at the local wall-clock time', () => {
    const days = Array.from({ length: 7 }, (_, index) => at(2026, 8, 2 + index));
    const found = eventOccurrences([event], days);
    expect(found.map((item) => new Date(item.startMs).getDay())).toEqual([1, 3]);
    expect(found.every((item) => item.startMs - startOfLocalDay(item.startMs) === 12 * 60 * 60_000)).toBe(true);
  });

  it('honors the recurrence anchor and interval', () => {
    const fortnightly = { ...event, weekdays: [1], frequencyWeeks: 2 as const };
    const days = [at(2026, 8, 3), at(2026, 8, 10), at(2026, 8, 17)];
    expect(eventOccurrences([fortnightly], days).map((item) => new Date(item.startMs).getDate())).toEqual([3, 17]);
  });

  it('does not emit before startsOn', () => {
    expect(eventOccurrences([event], [at(2026, 7, 27)])).toEqual([]);
  });
});
