/**
 * The minute clock the now line runs on. PROJECT-SPEC-V2.md §6.3.
 *
 * "It updates on the minute, not on a rapid timer" is a requirement about
 * *when*, not merely how often: a one-second interval would re-render the whole
 * grid sixty times for each of the fifty-nine ticks that move nothing, and a
 * 60,000ms interval started at :30 would keep the line half a minute behind the
 * clock for as long as the tab is open. So this schedules a single timeout to
 * the next wall-clock minute boundary and re-arms from there — the value
 * changes exactly when the displayed minute does.
 *
 * A timeout also survives what an interval does not. Timers do not fire while a
 * tab is backgrounded or a laptop is asleep; on wake, an interval resumes on
 * its old, now-wrong phase, while this one lands, sees the real time, and
 * re-arms onto the correct boundary.
 */

import { useEffect, useState } from 'react';
import { startOfLocalDay } from '../../shared/schedule';

const MINUTE_MS = 60_000;

/** Epoch ms, re-read once per wall-clock minute. */
export function useNowMinute(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer = 0;

    const tick = () => {
      const at = Date.now();
      setNow(at);
      // Never zero: at exactly :00.000 the remainder is a full minute, not
      // nothing, and a 0ms timeout here would spin.
      timer = window.setTimeout(tick, MINUTE_MS - (at % MINUTE_MS) || MINUTE_MS);
    };

    timer = window.setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS) || MINUTE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return now;
}

/**
 * Local midnight, updated once when the calendar day changes. Day labels and
 * "today" markers need this cadence; subscribing the whole Planner to the
 * minute clock just to learn the date makes every block and lane re-render 1440
 * times a day while only the now line has actually moved.
 */
export function useToday(): number {
  const [today, setToday] = useState(() => startOfLocalDay(Date.now()));

  useEffect(() => {
    let timer = 0;

    const tick = () => {
      const at = Date.now();
      setToday(startOfLocalDay(at));
      timer = window.setTimeout(tick, nextMidnightDelay(at));
    };

    timer = window.setTimeout(tick, nextMidnightDelay(Date.now()));
    return () => window.clearTimeout(timer);
  }, []);

  return today;
}

function nextMidnightDelay(at: number): number {
  const next = new Date(at);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, next.getTime() - at);
}
