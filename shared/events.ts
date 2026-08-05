import { startOfLocalDay } from './schedule';
import type { PlannerEvent } from './types';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface EventOccurrence {
  event: PlannerEvent;
  startMs: number;
}

export function localDateKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localDateMs(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).getTime();
}

/** Occurrences on the requested local days, including fortnightly/monthly-week series. */
export function eventOccurrences(
  events: readonly PlannerEvent[],
  days: readonly number[],
): EventOccurrence[] {
  const result: EventOccurrence[] = [];
  for (const rawDay of days) {
    const day = startOfLocalDay(rawDay);
    const weekday = new Date(day).getDay();
    for (const event of events) {
      const anchor = startOfLocalDay(localDateMs(event.startsOn));
      if (day < anchor || !event.weekdays.includes(weekday)) continue;
      const weeks = Math.floor((day - anchor) / WEEK_MS);
      if (weeks % event.frequencyWeeks !== 0) continue;
      result.push({ event, startMs: day + event.startMinutes * 60_000 });
    }
  }
  return result.sort((a, b) => a.startMs - b.startMs || a.event.id.localeCompare(b.event.id));
}
