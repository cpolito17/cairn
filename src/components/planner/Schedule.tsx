/**
 * The schedule grid — the week view, and the day view, which is the same grid
 * with one column. PROJECT-SPEC-V2.md §6.3, §6.4, §6.8.
 *
 * One component for both, deliberately. §6.4 says the day view is "everything
 * else identical": scale, shading, now line, lane packing, ghosts. Two
 * components would be two of each of those, and the second copy is where the
 * half-hour hairline or the null-duration outline quietly goes missing at
 * 375px, which is the width nobody re-checks.
 *
 * What is drawn, from the back forward:
 *
 * 1. The column, at `--bg`.
 * 2. The working-hours band, at `--surface` (§6.8). The same elevation step the
 *    rest of the app uses for a raised surface, so it reads in all eight themes
 *    with no per-theme special case — and it re-shades the instant the setting
 *    changes, because it is drawn from the setting rather than from a snapshot.
 * 3. The hairlines: `--hairline` at the hour, a lighter one at the half hour,
 *    **nothing at 15 minutes**. Two background gradients on one overlay rather
 *    than 48 elements per column.
 * 4. The blocks, positioned and lane-packed by `shared/planner.ts`.
 * 5. The now line, on today's column only.
 *
 * The vertical axis is 24 hours at `--planner-hour` each and the grid scrolls
 * inside its own box rather than with the page: a 96rem-tall grid on the page
 * scroll would put the day headers off screen the moment you looked at the
 * afternoon.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import type { DayLayout } from '../../../shared/planner';
import { isSameDay } from '../../../shared/planner';
import type { Context, Settings, Task } from '../../../shared/types';
import { useNowMinute } from '../../lib/clock';
import { useSchedule, useStore } from '../../lib/store';
import { Button } from '../ui/Button';
import { ErrorLine, loadErrorMessage } from '../ui/Section';
import { Skeleton } from '../ui/Skeleton';
import { Block } from './Block';
import { hourPixels, HOURS_PER_DAY, minutesInto, offsetOf } from './scale';

/** The time axis gutter. Wide enough for "12:00 AM" at the meta size. */
const AXIS_WIDTH = '3.5rem';

/** Local midnights of the columns to draw, in order. */
export interface ScheduleProps {
  context: Context;
  days: number[];
  settings: Settings;
  onOpen(task: Task): void;
  /** The day pager, on narrow viewports. Sits above the columns. */
  pager?: ReactNode;
}

export function Schedule({ context, days, settings, onOpen, pager }: ScheduleProps) {
  const status = useStore((state) => state.status);

  if (status === 'loading') return <ScheduleSkeleton days={days.length} pager={pager} />;
  if (status === 'error') return <ScheduleError />;

  return <Grid context={context} days={days} settings={settings} onOpen={onOpen} pager={pager} />;
}

function Grid({ context, days, settings, onOpen, pager }: ScheduleProps) {
  const layouts = useSchedule(context, days[0], days.length);
  const tasks = useStore((state) => state.tasks);
  const now = useNowMinute();
  const scroller = useRef<HTMLDivElement>(null);

  /**
   * §6.3: on mount, scroll to the working-day start — not to midnight, which is
   * eight hours of empty grid above anything anyone scheduled.
   *
   * Mount only. Re-running it when the week changes would yank the view back to
   * 9:00 every time someone paged forward while reading an evening, and
   * re-running it when the working hours change would do the same while they
   * were being adjusted.
   */
  useEffect(() => {
    const box = scroller.current;
    if (box === null) return;
    // A little air above the line, so the first working hour does not sit
    // flush against the day headers.
    box.scrollTop = Math.max(0, (settings.workdayStartMinutes / 60) * hourPixels() - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-4">
      {pager}
      <div
        ref={scroller}
        className="planner-scroll relative overflow-y-auto overflow-x-hidden rounded-card
                   bg-bg"
        style={{
          border: 'var(--hairline-width) solid var(--hairline)',
          // Tall enough to read an afternoon, short enough to leave the
          // toolbar and the pager on screen. `dvh` because iOS Safari is the
          // primary mobile target and `vh` lies there.
          height: 'clamp(20rem, calc(100dvh - 17rem), 52rem)',
        }}
      >
        {/* The day headers scroll horizontally with nothing and vertically with
            nothing: they are the fixed reference the columns are read against. */}
        <div className="sticky top-0 z-20 flex bg-bg" style={{ boxShadow: '0 1px 0 var(--hairline)' }}>
          <div style={{ width: AXIS_WIDTH, flexShrink: 0 }} />
          {days.map((day) => (
            <DayHeader key={day} day={day} now={now} single={days.length === 1} />
          ))}
        </div>

        <div className="flex" style={{ height: offsetOf(HOURS_PER_DAY * 60) }}>
          <TimeAxis />
          {layouts.map((layout) => (
            <DayColumn
              key={layout.dayStart}
              layout={layout}
              tasks={tasks}
              settings={settings}
              now={now}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * §6.3: today's header is emphasised **by weight, not by colour** — colour is
 * the accent's job and the accent already owns the now line three pixels below.
 */
function DayHeader({ day, now, single }: { day: number; now: number; single: boolean }) {
  const date = new Date(day);
  const today = isSameDay(day, now);

  return (
    <div className="min-w-0 flex-1 px-1 py-2 text-center">
      <div
        className="truncate text-section text-text-secondary"
        style={{ textTransform: 'uppercase', fontWeight: today ? 700 : 600 }}
      >
        {/* One column has the room for the whole word; seven do not. */}
        {single ? WEEKDAYS_FULL[date.getDay()] : WEEKDAYS_SHORT[date.getDay()]}
      </div>
      {/* Weight is the *only* difference between today and any other day here.
          Recolouring the date as well would be the obvious second signal and
          the wrong one: it reads as a state the other six columns are missing
          rather than as emphasis, and the accent is spoken for by the now line
          a few pixels below. */}
      <div className="truncate text-row text-text" style={{ fontWeight: today ? 700 : 500 }}>
        {date.getDate()}
      </div>
    </div>
  );
}

/** The hour labels. Positioned at the line, nudged up so they sit on it. */
function TimeAxis() {
  return (
    <div className="relative" style={{ width: AXIS_WIDTH, flexShrink: 0 }}>
      {Array.from({ length: HOURS_PER_DAY }, (_, hour) => hour)
        // Midnight's label would sit half above the grid, and there is nothing
        // above the first line to mislabel.
        .filter((hour) => hour > 0)
        .map((hour) => (
          <span
            key={hour}
            className="absolute right-2 text-meta text-text-tertiary"
            style={{ top: offsetOf(hour * 60), transform: 'translateY(-50%)' }}
          >
            {hourLabel(hour)}
          </span>
        ))}
    </div>
  );
}

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

function DayColumn({
  layout,
  tasks,
  settings,
  now,
  onOpen,
}: {
  layout: DayLayout;
  tasks: Record<string, Task>;
  settings: Settings;
  now: number;
  onOpen(task: Task): void;
}) {
  const today = isSameDay(layout.dayStart, now);
  const nowMinutes = minutesInto(now, layout.dayStart);

  return (
    <div
      className="relative min-w-0 flex-1 bg-bg"
      style={{ borderLeft: 'var(--hairline-width) solid var(--hairline)' }}
    >
      {/* §6.8: the working day, at the app's raised-surface step. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 bg-surface"
        style={{
          top: offsetOf(settings.workdayStartMinutes),
          height: offsetOf(settings.workdayEndMinutes - settings.workdayStartMinutes),
        }}
      />

      {/* The hairlines, over the shading so the working band does not swallow
          them. Two gradients: the hour, then the lighter half hour. Nothing at
          15 minutes — §6.3 is explicit that the grid must not look like graph
          paper, and the 15-minute atom is a snapping rule, not a drawn line. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: [
            `repeating-linear-gradient(to bottom, var(--hairline) 0, var(--hairline) 1px,` +
              ` transparent 1px, transparent var(--planner-hour))`,
            `repeating-linear-gradient(to bottom, transparent 0,` +
              ` transparent calc(var(--planner-hour) / 2),` +
              ` color-mix(in srgb, var(--hairline) 45%, transparent) calc(var(--planner-hour) / 2),` +
              ` color-mix(in srgb, var(--hairline) 45%, transparent) calc(var(--planner-hour) / 2 + 1px),` +
              ` transparent calc(var(--planner-hour) / 2 + 1px), transparent var(--planner-hour))`,
          ].join(', '),
        }}
      />

      {layout.blocks.map((block) => (
        <Block
          key={block.ghost ? `ghost:${block.startMs}:${block.lane}` : (block.taskId as string)}
          block={block}
          dayStart={layout.dayStart}
          task={block.taskId === null ? undefined : tasks[block.taskId]}
          onOpen={onOpen}
        />
      ))}

      {today && <NowLine minutes={nowMinutes} />}
    </div>
  );
}

/**
 * §6.3: a 1px `--accent` rule across **today's column only**, with a dot at its
 * left edge. It is not interactive and it is not announced — the current time
 * is not news a screen reader needs read to it from a grid.
 */
function NowLine({ minutes }: { minutes: number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 z-10"
      style={{ top: offsetOf(minutes), height: '1px', background: 'var(--accent)' }}
    >
      <span
        className="absolute block rounded-pill"
        style={{
          left: 0,
          top: '50%',
          width: '6px',
          height: '6px',
          marginTop: '-3px',
          background: 'var(--accent)',
        }}
      />
    </div>
  );
}

/**
 * §8.4: skeletons match the real geometry. This one is the real grid frame —
 * headers, axis, columns, shading — with skeleton blocks where blocks land,
 * rather than a spinner in a box the size of a calendar.
 */
function ScheduleSkeleton({ days, pager }: { days: number; pager?: ReactNode }) {
  return (
    <div className="mt-4">
      {pager}
      <div
        className="overflow-hidden rounded-card bg-bg"
        style={{
          border: 'var(--hairline-width) solid var(--hairline)',
          height: 'clamp(20rem, calc(100dvh - 17rem), 52rem)',
        }}
      >
        <div className="flex" style={{ boxShadow: '0 1px 0 var(--hairline)' }}>
          <div style={{ width: AXIS_WIDTH, flexShrink: 0 }} />
          {Array.from({ length: days }, (_, index) => (
            <div key={index} className="flex flex-1 flex-col items-center gap-1 py-2">
              <Skeleton width="60%" height="0.75rem" />
              <Skeleton width="30%" height="1rem" />
            </div>
          ))}
        </div>

        <div className="flex" style={{ height: offsetOf(HOURS_PER_DAY * 60) }}>
          <div style={{ width: AXIS_WIDTH, flexShrink: 0 }} />
          {Array.from({ length: days }, (_, index) => (
            <div
              key={index}
              className="relative min-w-0 flex-1"
              style={{ borderLeft: 'var(--hairline-width) solid var(--hairline)' }}
            >
              <div
                className="absolute inset-x-0 bg-surface"
                style={{ top: offsetOf(540), height: offsetOf(480) }}
              />
              {[600, 780, 900].map((minutes, slot) =>
                (index + slot) % 3 === 0 ? null : (
                  <span
                    key={minutes}
                    className="absolute"
                    style={{ top: offsetOf(minutes), left: '2px', right: '2px' }}
                  >
                    <Skeleton height={offsetOf(60)} radius="var(--radius-chip)" />
                  </span>
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScheduleError() {
  const load = useStore((state) => state.load);
  const failure = useStore((state) => state.failure);

  return (
    <ErrorLine
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      }
    >
      {loadErrorMessage('your schedule', failure)}
    </ErrorLine>
  );
}
