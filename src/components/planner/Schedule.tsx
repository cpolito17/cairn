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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DayLayout, PlacedBlock } from '../../../shared/planner';
import { isSameDay } from '../../../shared/planner';
import { startOfLocalDay } from '../../../shared/schedule';
import type { Context, PlannerEvent, Settings, Task } from '../../../shared/types';
import { useNowMinute, useToday } from '../../lib/clock';
import { useSchedule, useStore } from '../../lib/store';
import { Button } from '../ui/Button';
import { ErrorLine, loadErrorMessage } from '../ui/Section';
import { Skeleton } from '../ui/Skeleton';
import { Block } from './Block';
import { EventBlock } from './EventBlock';
import { PreviewSlot, useGridRegistration, type GridRegistration } from './scheduling';
import { hourPixels, HOURS_PER_DAY, minutePixels, minutesInto, offsetOf } from './scale';

/** The time axis gutter. Wide enough for "12:00 AM" at the meta size. */
const AXIS_WIDTH = '3.5rem';

/** Local midnights of the columns to draw, in order. */
export interface ScheduleProps {
  context: Context;
  days: number[];
  settings: Settings;
  onOpen(task: Task): void;
  onOpenEvent(event: PlannerEvent): void;
  onCreateSlot?: ((startMs: number, durationMinutes: number) => void) | undefined;
  /**
   * The slot a just-finished drag-to-create handed off to the composer, or
   * null. The gesture's own box (`DayColumn`'s local `creating` state) only
   * lives for the drag itself; once the pointer is up, the composer is the
   * source of truth for whether a creation is in flight. Handing its value
   * back down here is what keeps the drawn box on the grid, in the
   * background, for as long as the New Task sheet is open, instead of it
   * vanishing the instant the drag ends.
   */
  creatingSlot?: { scheduledAt: number; durationMinutes: number } | null | undefined;
  /** The day pager, on narrow viewports. Sits above the columns. */
  pager?: ReactNode;
  /**
   * The slot the keyboard is currently proposing (§6.7), or null. Highlighted,
   * scrolled to, and — because it is keyboard-initiated — never animated.
   */
  placing?: PlacingSlot | null | undefined;
}

export interface PlacingSlot {
  taskId: string;
  /** Epoch ms of the proposed 15-minute start. */
  startMs: number;
  minutes: number;
  /**
   * `timeStamp` of the keystroke that opened placing mode.
   *
   * Load-bearing, and the reason is one React event ordering: the row's handler
   * runs at the React root, which is *inside* `window`, so the same keydown goes
   * on bubbling and reaches the window listener that this very state update just
   * installed. Without a mark to compare against, one press of Enter both opens
   * placing mode and commits it, and the task lands wherever the mode happened
   * to start.
   */
  since: number;
}

export function Schedule({
  context,
  days,
  settings,
  onOpen,
  onOpenEvent,
  onCreateSlot,
  creatingSlot,
  pager,
  placing,
}: ScheduleProps) {
  const status = useStore((state) => state.status);

  if (status === 'loading') return <ScheduleSkeleton days={days.length} pager={pager} />;
  if (status === 'error') return <ScheduleError />;

  return (
    <Grid
      context={context}
      days={days}
      settings={settings}
      onOpen={onOpen}
      onOpenEvent={onOpenEvent}
      onCreateSlot={onCreateSlot}
      creatingSlot={creatingSlot}
      pager={pager}
      placing={placing}
    />
  );
}

function Grid({
  context,
  days,
  settings,
  onOpen,
  onOpenEvent,
  onCreateSlot,
  creatingSlot,
  pager,
  placing,
}: ScheduleProps) {
  const layouts = useSchedule(context, days[0], days.length);
  const tasks = useStore((state) => state.tasks);
  const events = useStore((state) => state.events);
  const today = useToday();
  /**
   * The gesture needs three things about the grid and reads them itself: the
   * box that scrolls, the row whose top edge is minute zero, and which days
   * the columns are. Held in state rather than in a ref so that registering
   * happens once both elements exist, and again if the week changes.
   */
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const registration = useMemo<GridRegistration | null>(
    () => (content && box ? { scroller: box, content, days } : null),
    [content, box, days],
  );
  useGridRegistration(registration);

  /**
   * §6.3: on mount, scroll to the working-day start — not to midnight, which is
   * eight hours of empty grid above anything anyone scheduled.
   *
   * Mount only. Re-running it when the week changes would yank the view back to
   * 9:00 every time someone paged forward while reading an evening, and
   * re-running it when the working hours change would do the same while they
   * were being adjusted.
   */
  const scrolled = useRef(false);
  useEffect(() => {
    if (box === null || scrolled.current) return;
    scrolled.current = true;
    // A little air above the line, so the first working hour does not sit
    // flush against the day headers.
    box.scrollTop = Math.max(0, (settings.workdayStartMinutes / 60) * hourPixels() - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box]);

  /**
   * §6.7's keyboard placement, scrolled into view. Instantly — the slot is
   * moving because an arrow key said so, and §8.5 gives keyboard-initiated
   * actions no animation, ever. That includes the scroll that follows one.
   */
  useEffect(() => {
    if (box === null || !placing) return;
    const ppm = minutePixels();
    const top = ((placing.startMs - startOfLocalDay(placing.startMs)) / 60_000) * ppm;
    const bottom = top + placing.minutes * ppm;
    const header = box.querySelector<HTMLElement>('[data-day-header]');
    const headerHeight = header ? header.getBoundingClientRect().height : 0;
    const visibleTop = box.scrollTop + headerHeight;
    const visibleBottom = box.scrollTop + box.clientHeight;
    if (top < visibleTop) box.scrollTop = Math.max(0, top - headerHeight - 8);
    else if (bottom > visibleBottom) box.scrollTop = bottom - box.clientHeight + 8;
  }, [box, placing]);

  return (
    <div className="mt-4 min-h-0 flex-1">
      {pager}
      <div
        ref={setBox}
        className="planner-scroll relative overflow-y-auto overflow-x-hidden rounded-card
                   bg-bg"
        style={{
          border: 'var(--hairline-width) solid var(--hairline)',
          // Tall enough to read an afternoon, short enough to leave the
          // toolbar and the pager on screen. `dvh` because iOS Safari is the
          // primary mobile target and `vh` lies there.
          height: days.length === 1 ? 'clamp(20rem, calc(100dvh - 17rem), 52rem)' : '100%',
        }}
      >
        {/* The day headers scroll horizontally with nothing and vertically with
            nothing: they are the fixed reference the columns are read against. */}
        <div
          data-day-header=""
          className="sticky top-0 z-20 flex bg-bg"
          style={{ boxShadow: '0 1px 0 var(--hairline)' }}
        >
          <div style={{ width: AXIS_WIDTH, flexShrink: 0 }} />
          {days.map((day) => (
            <DayHeader key={day} day={day} now={today} single={days.length === 1} />
          ))}
        </div>

        {/* `relative`, because the previewed slot is positioned against this
            row: minute zero is its top edge, which is the one reference both
            the columns and the gesture already agree on. */}
        <div className="relative flex" ref={setContent} style={{ height: offsetOf(HOURS_PER_DAY * 60) }}>
          <TimeAxis />
          {layouts.map((layout) => (
            <DayColumn
              key={layout.dayStart}
              layout={layout}
              tasks={tasks}
              events={events}
              settings={settings}
              today={isSameDay(layout.dayStart, today)}
              onOpen={onOpen}
              onOpenEvent={onOpenEvent}
              onCreateSlot={onCreateSlot}
              creatingSlot={
                creatingSlot && isSameDay(creatingSlot.scheduledAt, layout.dayStart) ? creatingSlot : null
              }
              placing={placing && isSameDay(placing.startMs, layout.dayStart) ? placing : null}
            />
          ))}
          <PreviewSlot />
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

/**
 * Minutes of empty column below each block *in its own lane*, keyed by the
 * block's position in the layout. The resize handle reaches into that gap, so
 * it has to know how much of one there is: a block with another directly under
 * it gives up nothing, and takes its whole target out of its own height.
 */
function gapsBelow(blocks: PlacedBlock[]): number[] {
  return blocks.map((block) => {
    const end = block.startMs + block.minutes * 60_000;
    let next = Infinity;
    for (const other of blocks) {
      if (other === block || other.lane !== block.lane) continue;
      if (other.startMs >= end && other.startMs < next) next = other.startMs;
    }
    const dayEnd = layoutDayEnd(block.startMs);
    return (Math.min(next, dayEnd) - end) / 60_000;
  });
}

/** Local midnight after the day containing `at`, without a Date round trip. */
function layoutDayEnd(at: number): number {
  const date = new Date(at);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function DayColumn({
  layout,
  tasks,
  events,
  settings,
  today,
  onOpen,
  onOpenEvent,
  onCreateSlot,
  creatingSlot,
  placing,
}: {
  layout: DayLayout;
  tasks: Record<string, Task>;
  events: Record<string, PlannerEvent>;
  settings: Settings;
  today: boolean;
  onOpen(task: Task): void;
  onOpenEvent(event: PlannerEvent): void;
  onCreateSlot?: ((startMs: number, durationMinutes: number) => void) | undefined;
  creatingSlot: { scheduledAt: number; durationMinutes: number } | null;
  placing: PlacingSlot | null;
}) {
  const gaps = gapsBelow(layout.blocks);
  // One measurement per column render, handed down: every block would otherwise
  // read the root font size for itself.
  const ppm = minutePixels();

  const draft = useRef<{ pointerId: number; y: number; anchor: number; active: boolean } | null>(null);
  const [creating, setCreating] = useState<{ start: number; minutes: number } | null>(null);

  function createDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!onCreateSlot || e.button !== 0 || (e.target as HTMLElement).closest('[data-block-id], [data-event-block], .planner-resize')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minute = Math.max(0, Math.min(1425, Math.floor(((e.clientY - rect.top) / ppm) / 15) * 15));
    draft.current = { pointerId: e.pointerId, y: e.clientY, anchor: minute, active: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function createMove(e: React.PointerEvent<HTMLDivElement>) {
    const value = draft.current;
    if (!value || value.pointerId !== e.pointerId) return;
    if (!value.active && Math.abs(e.clientY - value.y) < 5) return;
    value.active = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const minute = Math.max(0, Math.min(1440, Math.round(((e.clientY - rect.top) / ppm) / 15) * 15));
    const start = Math.min(value.anchor, minute);
    setCreating({ start, minutes: Math.max(15, Math.abs(minute - value.anchor)) });
  }
  function createUp(e: React.PointerEvent<HTMLDivElement>) {
    const value = draft.current;
    if (!value || value.pointerId !== e.pointerId) return;
    draft.current = null;
    if (value.active && creating) onCreateSlot?.(layout.dayStart + creating.start * 60_000, creating.minutes);
    setCreating(null);
  }

  // The box drawn under the pointer while dragging, or — once the pointer is
  // up and the composer has taken `creatingSlot` from the drop — the same box
  // recomputed from that handoff so it keeps sitting on the grid, in the
  // background, for as long as the New Task sheet is open (rather than the
  // drag's own state, which is cleared the moment the pointer lifts).
  const box =
    creating ??
    (creatingSlot
      ? { start: minutesInto(creatingSlot.scheduledAt, layout.dayStart), minutes: creatingSlot.durationMinutes }
      : null);

  return (
    <div
      data-day-column=""
      data-day-start={layout.dayStart}
      onPointerDown={createDown}
      onPointerMove={createMove}
      onPointerUp={createUp}
      onPointerCancel={createUp}
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

      {layout.blocks.map((block, index) => (
        block.eventId && events[block.eventId] ? <EventBlock
          key={`event:${block.eventId}:${block.startMs}`}
          block={block} dayStart={layout.dayStart} event={events[block.eventId]} onOpen={onOpenEvent}
        /> : <Block
          key={block.ghost ? `ghost:${block.startMs}:${block.lane}` : (block.taskId as string)}
          block={block}
          dayStart={layout.dayStart}
          task={block.taskId === null ? undefined : tasks[block.taskId]}
          gapBelow={gaps[index]}
          pixelsPerMinute={ppm}
          onOpen={onOpen}
        />
      ))}

      {box && <div className="pointer-events-none absolute z-10 overflow-hidden rounded-chip bg-accent-tint px-2 text-left text-row text-text"
        style={{ top: offsetOf(box.start), height: offsetOf(box.minutes), left: 2, right: 2, border: '2px solid var(--accent)' }}>
        <span style={{ lineHeight: box.minutes <= 15 ? offsetOf(15) : undefined }}>New Task</span>
      </div>}

      {placing && <PlacingHighlight placing={placing} dayStart={layout.dayStart} />}

      {today && <NowLine dayStart={layout.dayStart} />}
    </div>
  );
}

/**
 * The slot the keyboard is proposing (§6.7). A solid accent outline over an
 * accent tint — the same language the previewed drop slot speaks, at full
 * strength, because this one is not a guess about where a finger is going.
 *
 * It animates nothing. Not a transition, not a spring, not an entrance: §8.5
 * gives keyboard-initiated actions no animation, and a highlight that eased
 * between slots as the arrows moved it would be exactly that.
 */
function PlacingHighlight({ placing, dayStart }: { placing: PlacingSlot; dayStart: number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 rounded-chip"
      style={{
        top: offsetOf(minutesInto(placing.startMs, dayStart)),
        height: offsetOf(placing.minutes),
        left: '2px',
        right: '2px',
        background: 'var(--accent-tint)',
        border: '2px solid var(--accent)',
      }}
    />
  );
}

/**
 * §6.3: a 1px `--accent` rule across **today's column only**, with a dot at its
 * left edge. It is not interactive and it is not announced — the current time
 * is not news a screen reader needs read to it from a grid.
 */
function NowLine({ dayStart }: { dayStart: number }) {
  // This is the only minute subscription in the schedule. Its state update
  // re-renders one 1px rule, not the grid and every block behind it.
  const now = useNowMinute();
  const minutes = minutesInto(now, dayStart);
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
