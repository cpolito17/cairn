/**
 * The schedule's vertical scale, in one place. PROJECT-SPEC-V2.md §6.3.
 *
 * One hour is 64px and the 15-minute atom is 16px — but the number that ships
 * is `4rem`, not `64px`. §6.3 and §8.3 both ask for sizes in rem so a user who
 * has set a larger text size gets a grid whose rows fit the text in them; a
 * pixel grid would keep the hour at 64px and let 20px type overflow it.
 *
 * Every vertical position is a `calc()` on that one variable rather than a
 * number this module multiplies out, so nothing here has to know what a rem is
 * worth. The single exception is the mount scroll, which sets `scrollTop` and
 * therefore needs a real pixel — it measures the root font size instead of
 * assuming 16.
 */

import { useEffect, useState } from 'react';

/** The token every offset below is expressed against; declared in tokens.css. */
export const HOUR_VAR = 'var(--planner-hour)';

/** One hour, in rem. Kept in step with `--planner-hour`. */
export const HOUR_REM = 4;

export const HOURS_PER_DAY = 24;

export const MINUTES_PER_HOUR = 60;

/**
 * The Planner's own wide breakpoint, above the app's 768px one.
 *
 * §6.1 puts the task list beside the schedule "on wide viewports" and §6.4
 * turns the week into a day below "the wide breakpoint". Seven columns and a
 * 300px list do not both fit at 768: the columns come out around 55px, which is
 * narrower than the time label beside them and not a week view anyone can read.
 * 1024 is where the seven columns clear ~90px each, which is where the grid
 * starts being worth its own name.
 */
export const PLANNER_WIDE_QUERY = '(min-width: 1024px)';

/** A vertical offset for `minutes` past midnight, as a CSS length. */
export function offsetOf(minutes: number): string {
  return `calc(${HOUR_VAR} * ${minutes / MINUTES_PER_HOUR})`;
}

/** Minutes past local midnight for a moment, given that day's midnight. */
export function minutesInto(at: number, dayStart: number): number {
  return (at - dayStart) / 60_000;
}

/** True at the Planner's wide breakpoint: two panes and seven columns. */
export function usePlannerWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(PLANNER_WIDE_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(PLANNER_WIDE_QUERY);
    const listener = (event: MediaQueryListEvent) => setWide(event.matches);
    query.addEventListener('change', listener);
    setWide(query.matches);
    return () => query.removeEventListener('change', listener);
  }, []);

  return wide;
}

/** `--planner-hour` in real pixels, for the one place that needs a number. */
export function hourPixels(): number {
  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return (Number.isFinite(root) ? root : 16) * HOUR_REM;
}

/**
 * Pixels per minute — the scale a pointer gesture works in.
 *
 * The drag and the resize are the two places the grid has to be answered in
 * real numbers rather than in `calc()`: a finger moves in pixels, and the
 * minutes it has crossed is a division. Everything that can stay a `calc()`
 * still does, so a larger text size still enlarges the grid.
 */
export function minutePixels(): number {
  return hourPixels() / MINUTES_PER_HOUR;
}
