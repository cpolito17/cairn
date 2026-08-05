/**
 * The year view — a workload heat map. PROJECT-SPEC-V2.md §6.6; PROJECT-SPEC.md
 * §8.3, §8.4.
 *
 * 53 columns of 7 day-squares, ending with the week the anchor is in, weekday
 * rows labelled sparsely and month labels along the top. A square's intensity
 * is that day's total scheduled minutes bucketed against the length of the
 * configured working day (§3.2) — the arithmetic is `heatBucket` in
 * `shared/planner.ts`, tested there rather than written into a cell here, so
 * "exactly a quarter of a workday" has one answer and it has a test.
 *
 * Two asymmetries are deliberate and are §6.6's, not accidents to tidy:
 *
 * - **Both contexts fill the square.** A full day is a full day regardless of
 *   which half of a life filled it, and a heat map that hid the other context
 *   would say a day was free on the evening it was not.
 * - **Only the current context is named.** The tooltip lists this context's
 *   tasks; the other context contributes heat and stays anonymous, exactly as
 *   its ghosts do on the week grid.
 *
 * Read-and-navigate only (§11): nothing is draggable, nothing takes a drop, and
 * clicking a day opens the week view there.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DAYS_PER_WEEK,
  addDays,
  heatBucket,
  isSameDay,
  workdayMinutes,
  yearGridWeeks,
  type HeatDay,
} from '../../../shared/planner';
import { localDayKey } from '../../../shared/schedule';
import { eventOccurrences } from '../../../shared/events';
import type { Context, Settings } from '../../../shared/types';
import { formatDuration } from '../../lib/dates';
import { useHeat, useStore } from '../../lib/store';
import { PlannerError } from './PlannerError';

/**
 * The five fills of §6.6. `--surface-2` for a day with nothing, then the accent
 * at a quarter, a half and three quarters of its strength, then the accent
 * itself.
 *
 * Mixed **towards `--surface-2`** rather than laid over the page at 25% alpha:
 * the empty square is `--surface-2`, so mixing from it makes one continuous
 * ramp that starts where "nothing" ends. Alpha over `--bg` would put the first
 * two steps on the wrong side of the empty square in the light themes, where
 * `--surface-2` is darker than the page rather than lighter.
 */
const HEAT_FILLS = [
  'var(--surface-2)',
  'color-mix(in srgb, var(--accent) 25%, var(--surface-2))',
  'color-mix(in srgb, var(--accent) 50%, var(--surface-2))',
  'color-mix(in srgb, var(--accent) 75%, var(--surface-2))',
  'var(--accent)',
] as const;

/** The square, and the pitch from one column to the next. In rem, per §8.3. */
const SQUARE = '0.8125rem';
const GAP = '0.1875rem';
/** Room for the weekday labels down the left edge. */
const LABEL_WIDTH = '2rem';

/** The grid box's own padding, which the sticky label column has to cover. */
const BOX_PADDING = '0.75rem';

const WEEKDAYS_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
/** §6.6: labelled sparsely — every other row, so the labels never collide. */
const ROW_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

const MONTHS_SHORT = [
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

export interface YearHeatmapProps {
  context: Context;
  /** Any moment in the week the grid ends at. */
  anchor: number;
  settings: Settings;
  now: number;
  /** Drops into the week view at that day (§6.6). */
  onOpenDay(day: number): void;
}

export function YearHeatmap(props: YearHeatmapProps) {
  const status = useStore((state) => state.status);

  if (status === 'loading') return <HeatmapSkeleton />;
  if (status === 'error') return <PlannerError subject="your year" />;

  return <Heatmap {...props} />;
}

/** What the tooltip is pinned to: a day, and the square it belongs to. */
interface Hovered {
  day: number;
  square: HTMLElement;
}

function Heatmap({ context, anchor, settings, now, onOpenDay }: YearHeatmapProps) {
  const taskHeat = useHeat(context);
  const weeks = yearGridWeeks(anchor);
  const allEvents = useStore((state) => state.events);
  const heat = useMemo(() => {
    const result: Record<string, HeatDay> = Object.fromEntries(
      Object.entries(taskHeat).map(([key, value]) => [key, { ...value, events: [...(value.events ?? [])] }]),
    );
    const days = weeks.flatMap((week) => Array.from({ length: DAYS_PER_WEEK }, (_, row) => addDays(week, row)));
    for (const occurrence of eventOccurrences(Object.values(allEvents), days)) {
      const key = localDayKey(occurrence.startMs);
      const entry = result[key] ?? { minutes: 0, own: [], events: [] };
      entry.minutes += occurrence.event.durationMinutes;
      if (occurrence.event.context === context) {
        (entry.events ??= []).push({ id: occurrence.event.id, name: occurrence.event.name, startMs: occurrence.startMs });
      }
      result[key] = entry;
    }
    return result;
  }, [taskHeat, weeks, allEvents, context]);
  const workday = workdayMinutes(settings);
  const fine = useFinePointer();

  const [hovered, setHovered] = useState<Hovered | null>(null);
  /**
   * The square a touch has already opened the tooltip on.
   *
   * On a touch device a press *is* a click, so the two things a square does —
   * say what is on that day, and go there — would otherwise be the same
   * gesture and only the second would ever be seen. The first tap shows the
   * tooltip, a second tap on the same square navigates. On a fine pointer none
   * of this applies: hover says it, and the click goes.
   */
  const armed = useRef<number | null>(null);

  const scroller = useRef<HTMLDivElement | null>(null);

  /**
   * §6.6: the grid ends at the current week, so a narrow viewport opens at the
   * right-hand edge rather than a year ago. `scrollLeft` beyond the maximum is
   * clamped by the browser, which is exactly the behaviour wanted here.
   */
  useEffect(() => {
    const box = scroller.current;
    if (box === null) return;
    box.scrollLeft = box.scrollWidth;
    setHovered(null);
    armed.current = null;
  }, [anchor]);

  const empty = weeks.every((week) =>
    Array.from({ length: DAYS_PER_WEEK }, (_, row) => heat[localDayKey(addDays(week, row))]).every(
      (day) => day === undefined || day.minutes === 0,
    ),
  );

  function open(day: number) {
    // The tooltip belongs to the grid that is leaving, and a tooltip that
    // outlives its own view is the kind of thing that reappears over the week.
    setHovered(null);
    onOpenDay(day);
  }

  return (
    <div className="mt-4">
      <div
        ref={scroller}
        // The grid scrolls inside its own box; the page never scrolls
        // sideways with it (§6.6). `overscroll-behavior-x` keeps a flick at the
        // end of the year from turning into a browser back-swipe on iOS.
        className="planner-year-scroll overflow-x-auto rounded-card bg-bg p-3"
        style={{ border: 'var(--hairline-width) solid var(--hairline)' }}
        onScroll={() => setHovered(null)}
      >
        <div className="relative" style={{ width: 'max-content' }}>
          <MonthLabels weeks={weeks} />

          <div className="flex">
            {/* Sticky, so the row labels stay readable at 375px where the grid
                opens scrolled to the far right and they would otherwise be a
                year behind the squares they name. */}
            <div
              className="sticky z-10 flex flex-col justify-between bg-bg"
              style={{
                // The column reaches back over the box's padding, so a square
                // scrolled under it cannot show through the gutter beside it.
                // `left` is negative for the same reason: sticky pins to the
                // scrollport's *padding* edge, which is 12px inside the card.
                left: `calc(${BOX_PADDING} * -1)`,
                width: `calc(${LABEL_WIDTH} + ${BOX_PADDING})`,
                marginLeft: `calc(${BOX_PADDING} * -1)`,
                paddingLeft: BOX_PADDING,
                gap: GAP,
                flexShrink: 0,
              }}
              aria-hidden="true"
            >
              {ROW_LABELS.map((label, row) => (
                <span
                  key={row}
                  className="flex items-center text-meta text-text-tertiary"
                  style={{ height: SQUARE, lineHeight: 1 }}
                >
                  {label}
                </span>
              ))}
            </div>

            <div className="flex" style={{ gap: GAP }}>
              {weeks.map((week) => (
                <div key={week} className="flex flex-col" style={{ gap: GAP }}>
                  {Array.from({ length: DAYS_PER_WEEK }, (_, row) => {
                    const day = addDays(week, row);
                    const entry = heat[localDayKey(day)];
                    return (
                      <Square
                        key={day}
                        day={day}
                        entry={entry}
                        workday={workday}
                        today={isSameDay(day, now)}
                        onShow={(square) => setHovered({ day, square })}
                        onHide={() => setHovered(null)}
                        onActivate={(square) => {
                          if (fine || armed.current === day) {
                            open(day);
                            return;
                          }
                          armed.current = day;
                          setHovered({ day, square });
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        {empty ? (
          <p className="text-body text-text-secondary">
            Nothing scheduled in the last year. Blocks on the week grid fill these squares.
          </p>
        ) : (
          <p className="text-meta text-text-tertiary">
            Shaded against your working day, {formatDuration(workday)} long.
          </p>
        )}
        <Legend />
      </div>

      {hovered && <Tooltip hovered={hovered} heat={heat} now={now} />}
    </div>
  );
}

/**
 * One day. A button, because it navigates — and nothing else: no drag handlers,
 * no drop target, no pointer capture (§11).
 *
 * The label carries what the fill only implies. A screen reader gets the date
 * and the total from here, which is the same pair the tooltip shows, so the
 * hover affordance is never the only way to read the grid.
 */
function Square({
  day,
  entry,
  workday,
  today,
  onShow,
  onHide,
  onActivate,
}: {
  day: number;
  entry: HeatDay | undefined;
  workday: number;
  today: boolean;
  onShow(square: HTMLElement): void;
  onHide(): void;
  onActivate(square: HTMLElement): void;
}) {
  const minutes = entry?.minutes ?? 0;
  const bucket = heatBucket(minutes, workday);
  const date = new Date(day);

  return (
    <button
      type="button"
      data-heat-day={day}
      data-heat-bucket={bucket}
      aria-label={
        `${WEEKDAYS_FULL[date.getDay()]}, ${MONTHS_SHORT[date.getMonth()]} ${date.getDate()}` +
        `${date.getFullYear() === new Date().getFullYear() ? '' : `, ${date.getFullYear()}`}: ` +
        `${minutes === 0 ? 'nothing scheduled' : `${formatDuration(minutes)} scheduled`}`
      }
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') onShow(event.currentTarget);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') onHide();
      }}
      onFocus={(event) => onShow(event.currentTarget)}
      onBlur={onHide}
      onClick={(event) => onActivate(event.currentTarget)}
      className="planner-heat-square block"
      style={{
        width: SQUARE,
        height: SQUARE,
        borderRadius: '2px',
        background: HEAT_FILLS[bucket],
        // Today is marked the way today is marked everywhere in the Planner:
        // an accent outline, never a fill it could be mistaken for heat.
        outline: today ? '1px solid var(--accent)' : undefined,
        outlineOffset: '1px',
      }}
    />
  );
}

/**
 * The date, the total, and this context's tasks by name (§6.6).
 *
 * Positioned `fixed` from the square's own box rather than absolutely inside
 * the scroller: the scroller clips on both axes the moment it scrolls on one,
 * so an absolutely-positioned tooltip would be cut off at the top row — which
 * is where a whole month of squares lives.
 */
function Tooltip({
  hovered,
  heat,
  now,
}: {
  hovered: Hovered;
  heat: Record<string, HeatDay>;
  now: number;
}) {
  const tip = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const entry = heat[localDayKey(hovered.day)];
  const minutes = entry?.minutes ?? 0;
  const own = entry?.own ?? [];
  const events = entry?.events ?? [];
  const date = new Date(hovered.day);

  /**
   * Measured after layout, before paint: the tooltip has to be clamped by its
   * own width, and its own width depends on the names in it. One synchronous
   * pass, so nothing is ever seen hanging off the edge of the viewport.
   */
  useLayoutEffect(() => {
    const element = tip.current;
    if (element === null) return;
    const square = hovered.square.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const margin = 8;

    const centre = square.left + square.width / 2;
    const left = Math.min(
      Math.max(centre, margin + width / 2),
      window.innerWidth - margin - width / 2,
    );
    // Above the square, unless that would take it off the top of the grid. The
    // grid is only seven squares tall and sits directly under the period nav,
    // so "is there room in the viewport" is the wrong question — there usually
    // is, and the tooltip lands on the controls. Measured against the grid's own
    // box, the top rows flip below and the toolbar stays readable at every
    // width.
    const box = hovered.square.closest('.planner-year-scroll')?.getBoundingClientRect();
    const below = square.top - height - margin < (box ? box.top : margin);
    const top = below ? square.bottom + margin : square.top - margin;
    setBox({ left, top, below });
  }, [hovered]);

  return (
    <div
      ref={tip}
      role="tooltip"
      className="pointer-events-none fixed z-30 rounded-control bg-surface px-3 py-2 shadow-md"
      style={{
        left: box?.left ?? -9999,
        top: box?.top ?? -9999,
        transform: `translate(-50%, ${box?.below ? '0' : '-100%'})`,
        border: 'var(--hairline-width) solid var(--hairline)',
        maxWidth: 'min(16rem, calc(100vw - 1rem))',
        // Nothing is drawn until it has been measured, rather than drawn at the
        // wrong place and corrected a frame later.
        opacity: box === null ? 0 : 1,
      }}
    >
      <p className="text-meta text-text-secondary">
        {WEEKDAYS_FULL[date.getDay()].slice(0, 3)}, {MONTHS_SHORT[date.getMonth()]}{' '}
        {date.getDate()}
        {date.getFullYear() === new Date(now).getFullYear() ? '' : `, ${date.getFullYear()}`}
      </p>
      <p className="text-row text-text" style={{ fontWeight: 600 }}>
        {minutes === 0 ? 'Nothing scheduled' : `${formatDuration(minutes)} scheduled`}
      </p>

      {(own.length > 0 || events.length > 0) && (
        <ul className="mt-1">
          {own.map((task) => (
            <li key={task.id} className="truncate text-meta text-text-secondary">
              {task.name}
            </li>
          ))}
          {events.map((event) => (
            <li key={`event:${event.id}`} className="truncate text-meta text-text-secondary">
              {event.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The month names along the top, at the column each month opens in. */
function MonthLabels({ weeks }: { weeks: number[] }) {
  return (
    <div className="flex" aria-hidden="true">
      {/* Sticky with the label column below it, or a month name would slide
          under the weekday labels at a narrow width. */}
      <div
        className="sticky z-10 bg-bg"
        style={{
          left: `calc(${BOX_PADDING} * -1)`,
          width: `calc(${LABEL_WIDTH} + ${BOX_PADDING})`,
          marginLeft: `calc(${BOX_PADDING} * -1)`,
          flexShrink: 0,
        }}
      />
      <div className="flex" style={{ gap: GAP }}>
        {weeks.map((week, index) => {
          const month = new Date(week).getMonth();
          const previous = index === 0 ? null : new Date(weeks[index - 1]).getMonth();
          // The first column is skipped even when it opens a month: its label
          // would sit under the weekday column and be half a month early
          // anyway, since the window starts mid-month.
          const opens = previous !== null && month !== previous;
          return (
            <span
              key={week}
              className="text-meta text-text-tertiary"
              style={{
                width: SQUARE,
                height: '1rem',
                lineHeight: '1rem',
                flexShrink: 0,
                // The label overflows its own column rather than widening it:
                // the columns are the grid's pitch and nothing may change it.
                overflow: 'visible',
                whiteSpace: 'nowrap',
              }}
            >
              {opens ? MONTHS_SHORT[month] : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Less → More, so the five buckets are readable without hovering all of them. */
function Legend() {
  return (
    <span className="flex shrink-0 items-center gap-1 text-meta text-text-tertiary">
      Less
      {HEAT_FILLS.map((fill, bucket) => (
        <span
          key={bucket}
          aria-hidden="true"
          className="block"
          style={{ width: SQUARE, height: SQUARE, borderRadius: '2px', background: fill }}
        />
      ))}
      More
    </span>
  );
}

/**
 * True on a device that can really hover. §8.5 gates every hover affordance,
 * and this one decides an interaction rather than a colour: on touch the first
 * tap opens the tooltip instead of navigating.
 */
function useFinePointer(): boolean {
  const [fine, setFine] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    const listener = (event: MediaQueryListEvent) => setFine(event.matches);
    query.addEventListener('change', listener);
    setFine(query.matches);
    return () => query.removeEventListener('change', listener);
  }, []);

  return fine;
}

/** §8.4: the grid's real geometry, shimmering, rather than a spinner. */
function HeatmapSkeleton() {
  return (
    <div className="mt-4">
      <div
        className="planner-year-scroll overflow-x-auto rounded-card bg-bg p-3"
        style={{ border: 'var(--hairline-width) solid var(--hairline)' }}
      >
        <div className="relative" style={{ width: 'max-content' }}>
          <div className="flex">
            <div style={{ width: LABEL_WIDTH, flexShrink: 0 }} />
            <div className="flex" style={{ gap: GAP }}>
              {Array.from({ length: 53 }, (_, week) => (
                <div key={week} className="flex flex-col" style={{ gap: GAP }}>
                  {Array.from({ length: DAYS_PER_WEEK }, (_, row) => (
                    <span
                      key={row}
                      className="block bg-surface-2"
                      style={{ width: SQUARE, height: SQUARE, borderRadius: '2px' }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <span className="cairn-shimmer" />
        </div>
      </div>
    </div>
  );
}
