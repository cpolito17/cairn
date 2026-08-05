/**
 * The Planner. PROJECT-SPEC-V2.md §6.1–§6.6, §6.8.
 *
 * Two panes on a wide viewport — the unscheduled list at a fixed 300px, the
 * schedule taking the rest — and one pane below the Planner's wide breakpoint,
 * where the list moves into a bottom sheet opened from the toolbar and the
 * seven columns become one with a day pager (§6.4). A seven-column grid at
 * 375px is not a smaller week view; it is an unusable one.
 *
 * The toolbar carries the Week · Month · Year selector, **Today**,
 * previous/next for the current period, and the period label between them. The
 * period is whatever the view is showing: a week, a month, or the trailing year
 * the heat map draws, so the same two carets mean "the thing on screen, one
 * step" in all three.
 *
 * **Nothing here computes anything.** The visible days come from
 * `shared/planner.ts`, the blocks and their lanes come from the store's
 * schedule selector, and the list's order comes from the unscheduled selector.
 * This file owns which period is on screen and nothing else.
 *
 * The month grid and the year heat map are **read-and-navigate only** (§11).
 * Neither takes a drop and neither offers placing mode, which is why `onPlace`
 * reaches the list only while the week is on screen: an Enter that opened a
 * placing slot onto a grid nobody can see is a keyboard path into a view that
 * does not schedule. Clicking a day in either one anchors the week view there
 * and switches to it, and that click is the disambiguating step a drop onto a
 * month cell would have needed anyway.
 *
 * Blocks and rows open the composer, drag onto the grid, and resize there — the
 * gesture itself is `components/planner/scheduling.tsx`. What this file owns of
 * it is the two things only the screen can know: which period is on screen, and
 * the keyboard's placing mode, which moves by day and therefore has to be able
 * to page the week under itself.
 */

import { CaretLeft, CaretRight, ListBullets, Plus } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import {
  addDays,
  addMonths,
  DAYS_PER_WEEK,
  isSameDay,
  startOfMonth,
  weekDays,
  yearGridWeeks,
} from '../../shared/planner';
import { effectiveMinutes, startOfLocalDay } from '../../shared/schedule';
import { SCHEDULE_STEP_MINUTES, type PlannerEvent, type PlannerView, type Task } from '../../shared/types';
import { DayPager } from '../components/planner/DayPager';
import { MonthGrid } from '../components/planner/MonthGrid';
import { YearHeatmap } from '../components/planner/YearHeatmap';
import { Schedule, type PlacingSlot } from '../components/planner/Schedule';
import { usePlannerWide } from '../components/planner/scale';
import { SchedulingProvider } from '../components/planner/scheduling';
import { UnscheduledList } from '../components/planner/UnscheduledList';
import { EventEditor } from '../components/planner/EventEditor';
import { TaskComposer } from '../components/TaskComposer';
import { Segmented } from '../components/ui/Segmented';
import { Sheet } from '../components/ui/Sheet';
import { useToday } from '../lib/clock';
import { formatSlot } from '../lib/dates';
import {
  scheduleTaskSpec,
  updateSettingsSpec,
  useSettings,
  useStore,
  useUnscheduled,
} from '../lib/store';

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;

const VIEW_OPTIONS: { value: PlannerView; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Planner() {
  const context = useStore((state) => state.context);
  const mutate = useStore((state) => state.mutate);
  const settings = useSettings();
  const wide = usePlannerWide();
  // Day-level UI changes at midnight. The minute clock lives inside NowLine so
  // its tick cannot re-render the Planner, its grid, or its blocks.
  const now = useToday();

  /**
   * The day the view is anchored to. One piece of state for both widths: the
   * week view draws the week containing it, the day view draws it. Paging in
   * one therefore lands somewhere sensible in the other, and rotating a phone
   * does not throw away where you were.
   */
  const [anchor, setAnchor] = useState(() => startOfLocalDay(Date.now()));
  const [listOpen, setListOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [creating, setCreating] = useState<{ scheduledAt: number; durationMinutes: number } | null>(null);
  const [eventEditor, setEventEditor] = useState<PlannerEvent | 'new' | null>(null);
  /** §6.7's keyboard placement: the proposed slot, or null when not placing. */
  const [placing, setPlacing] = useState<PlacingSlot | null>(null);

  const days = weekDays(anchor);
  const view = settings.plannerView;
  const showsSchedule = view === 'week';
  const placingTask = useStore((state) => (placing ? state.tasks[placing.taskId] : undefined));

  function setView(next: PlannerView) {
    void mutate(updateSettingsSpec(settings, { plannerView: next }));
  }

  /**
   * Enter on a focused row opens placing mode at the working day's start on the
   * day the view is already showing — the slot someone would have dragged to
   * without thinking, so the first arrow key is an adjustment rather than a
   * journey.
   */
  function startPlacing(task: Task, since: number) {
    // The row keeps focus while placing, so its Enter handler fires again on
    // the keystroke meant to commit. Re-opening the mode there would reset the
    // slot to its default and swallow the placement — the mode is already on,
    // and the window handler below is what owns Enter from here.
    if (placing !== null) return;
    const minutes = effectiveMinutes(task);
    const start = Math.min(settings.workdayStartMinutes, MINUTES_PER_DAY - minutes);
    setListOpen(false);
    setPlacing({
      taskId: task.id,
      startMs: startOfLocalDay(anchor) + start * MINUTE_MS,
      minutes,
      since,
    });
  }

  /**
   * The placing keys, per §6.7: ←/→ a day, ↑/↓ 15 minutes, Shift+↑/↓ an hour,
   * Enter places, Escape cancels. On `window` rather than on the row, because
   * the row is what still holds focus and the arrows have to reach past it —
   * and because Escape has to work wherever focus ended up.
   *
   * Nothing here animates. The slot is re-rendered where the arrows put it, the
   * grid scrolls to it instantly, and on Enter the block simply appears (§8.5).
   */
  useEffect(() => {
    if (placing === null) return;

    function move(days: number, minutes: number) {
      setPlacing((was) => {
        if (was === null) return was;
        const day = addDays(was.startMs, days);
        const into = (was.startMs - startOfLocalDay(was.startMs)) / MINUTE_MS + minutes;
        const bounded = Math.min(Math.max(0, into), MINUTES_PER_DAY - was.minutes);
        return { ...was, startMs: day + bounded * MINUTE_MS };
      });
    }

    function onKeyDown(event: KeyboardEvent) {
      // The keystroke that opened placing mode is still bubbling toward this
      // listener. It is not a command to this mode; it is what created it.
      if (event.timeStamp <= placing!.since) return;

      switch (event.key) {
        case 'Escape':
          setPlacing(null);
          break;
        case 'ArrowLeft':
          move(-1, 0);
          break;
        case 'ArrowRight':
          move(1, 0);
          break;
        case 'ArrowUp':
          move(0, event.shiftKey ? -60 : -SCHEDULE_STEP_MINUTES);
          break;
        case 'ArrowDown':
          move(0, event.shiftKey ? 60 : SCHEDULE_STEP_MINUTES);
          break;
        case 'Enter': {
          const task = useStore.getState().tasks[placing!.taskId];
          if (task) void mutate(scheduleTaskSpec(task, placing!.startMs));
          setPlacing(null);
          // The block is the thing that now exists, so focus follows it there.
          const id = placing!.taskId;
          requestAnimationFrame(() => {
            document.querySelector<HTMLElement>(`[data-block-id="${id}"]`)?.focus();
          });
          break;
        }
        default:
          return;
      }
      event.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [placing, mutate]);

  // A day the arrows walked off the visible week pages the week under them,
  // rather than moving a slot nobody can see.
  useEffect(() => {
    if (placing === null) return;
    if (!isSameWeek(placing.startMs, anchor)) setAnchor(startOfLocalDay(placing.startMs));
  }, [placing, anchor]);

  // §6.4: the day view pages by day and the strip follows it into the next
  // week; the week view pages by week. In both cases the button moves what is
  // actually on screen, which is the only reading of "previous/next for the
  // current period" that does not surprise someone at 375px. Month pages by a
  // month, and the year's trailing window by a year.
  function page(direction: number) {
    if (view === 'week') setAnchor(addDays(anchor, direction * (wide ? DAYS_PER_WEEK : 1)));
    else setAnchor(addMonths(anchor, direction * (view === 'month' ? 1 : 12)));
  }

  const label =
    view === 'month'
      ? monthLabel(anchor)
      : view === 'year'
        ? yearLabel(anchor)
        : wide
          ? weekLabel(days, now)
          : dayLabel(anchor, now);

  /**
   * §6.5, §6.6: a day clicked in either overview opens the week view at that
   * day. Both halves matter — the anchor moves *and* the view changes — and
   * they are one action rather than two, so the week never appears on the week
   * someone was already looking at rather than the day they just clicked.
   */
  function openDay(day: number) {
    setAnchor(startOfLocalDay(day));
    if (view !== 'week') setView('week');
  }

  return (
    <SchedulingProvider onDragOut={() => setListOpen(false)}>
      <h1 className="sr-only">Planner</h1>

      {/* The placing slot, spoken. A keyboard user has no proxy under a finger
          to read, so the slot has to say itself as it moves. */}
      <p aria-live="polite" className="sr-only">
        {placing && placingTask
          ? `Placing ${placingTask.name} at ${formatSlot(placing.startMs, now)}. ` +
            'Arrow keys to move, Enter to place, Escape to cancel.'
          : ''}
      </p>

      <div className="planner-layout">
        {wide && (
          <aside className="planner-pane">
            <UnscheduledList
              context={context}
              settings={settings}
              onOpen={setEditing}
              onPlace={showsSchedule ? startPlacing : undefined}
            />
          </aside>
        )}

        <section className="flex min-h-0 min-w-0 flex-col">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              id="planner-view"
              label="Planner view"
              options={VIEW_OPTIONS}
              value={view}
              onChange={setView}
              // Full width on its own line at phone widths, where sharing a row
              // with the period nav would compress both; sized to its labels
              // once there is room beside it.
              className="w-full sm:w-auto sm:min-w-[15rem]"
            />

            <button
              type="button"
              onClick={() => setEventEditor('new')}
              className="pressable flex items-center gap-2 rounded-chip bg-surface-2 px-3 text-meta text-text-secondary"
              style={{ minHeight: 'var(--tap-target)', fontWeight: 600 }}
            >
              <Plus size={16} />
              New Event
            </button>

            <div className="flex flex-1 items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => setAnchor(startOfLocalDay(Date.now()))}
                className="pressable rounded-chip px-3 text-meta text-accent"
                style={{ minHeight: 'var(--tap-target)', fontWeight: 600 }}
              >
                Today
              </button>

              <PeriodButton label="Previous" onClick={() => page(-1)}>
                <CaretLeft size={20} />
              </PeriodButton>

              {/* Tabular figures come from the global rule in index.css, so a
                  date that changes width does not shuffle the carets. */}
              <span
                aria-live="polite"
                className="min-w-0 truncate px-1 text-row text-text"
                style={{ fontWeight: 600 }}
              >
                {label}
              </span>

              <PeriodButton label="Next" onClick={() => page(1)}>
                <CaretRight size={20} />
              </PeriodButton>
            </div>

            {!wide && (
              <button
                type="button"
                onClick={() => setListOpen(true)}
                aria-haspopup="dialog"
                aria-expanded={listOpen}
                className="pressable flex items-center gap-2 rounded-chip bg-surface-2 px-3
                           text-meta text-text-secondary"
                style={{ minHeight: 'var(--tap-target)', fontWeight: 600 }}
              >
                <ListBullets size={16} />
                Unscheduled
                <UnscheduledCount />
              </button>
            )}
          </div>

          {view === 'week' && (
            <Schedule
              context={context}
              // The one place the two widths differ at all: seven columns or
              // one. Everything below this — scale, shading, now line, packing,
              // ghosts — is the same code either way (§6.4).
              days={wide ? days : [startOfLocalDay(anchor)]}
              settings={settings}
              onOpen={setEditing}
              onOpenEvent={setEventEditor}
              onCreateSlot={(scheduledAt, durationMinutes) => setCreating({ scheduledAt, durationMinutes })}
              placing={placing}
              pager={
                wide ? undefined : (
                  <DayPager days={days} selected={anchor} now={now} onSelect={setAnchor} />
                )
              }
            />
          )}

          {view === 'month' && (
            <MonthGrid context={context} month={anchor} now={now} onOpenDay={openDay} />
          )}

          {view === 'year' && (
            <YearHeatmap
              context={context}
              anchor={anchor}
              settings={settings}
              now={now}
              onOpenDay={openDay}
            />
          )}
        </section>
      </div>

      {!wide && (
        <Sheet open={listOpen} onClose={() => setListOpen(false)} title="Unscheduled">
          <div className="px-gutter pb-6">
            <UnscheduledList
              context={context}
              settings={settings}
              onOpen={(task) => {
                setListOpen(false);
                setEditing(task);
              }}
              onPlace={showsSchedule ? startPlacing : undefined}
            />
          </div>
        </Sheet>
      )}

      <TaskComposer
        open={editing !== null || creating !== null}
        onClose={() => { setEditing(null); setCreating(null); }}
        task={editing ?? undefined}
        boardId={editing?.boardId ?? ''}
        context={context}
        prefillName={creating ? 'New Task' : ''}
        chooseBoard={creating !== null}
        initialScheduledAt={creating?.scheduledAt ?? null}
        initialDurationMinutes={creating?.durationMinutes ?? null}
      />
      <EventEditor
        open={eventEditor !== null}
        onClose={() => setEventEditor(null)}
        context={context}
        event={eventEditor === 'new' || eventEditor === null ? undefined : eventEditor}
      />
    </SchedulingProvider>
  );
}

/** True when two moments fall in the same Sunday-first week. */
function isSameWeek(at: number, other: number): boolean {
  const days = weekDays(other);
  return at >= days[0] && at < addDays(days[days.length - 1], 1);
}

function PeriodButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="pressable flex items-center justify-center rounded-chip text-text-secondary"
      style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
    >
      {children}
    </button>
  );
}

/** The count on the narrow-viewport button, so the sheet is not a mystery box. */
function UnscheduledCount() {
  const context = useStore((state) => state.context);
  const settings = useSettings();
  const ready = useStore((state) => state.status === 'ready');
  const tasks = useUnscheduled(context, settings.plannerSort);
  if (!ready || tasks.length === 0) return null;
  return <span className="text-text-tertiary">· {tasks.length}</span>;
}

/** "March 3 – 9", "Feb 26 – Mar 4", and the year once it is not this one. */
function weekLabel(days: number[], now: number): string {
  const first = new Date(days[0]);
  const last = new Date(days[days.length - 1]);
  const sameMonth = first.getMonth() === last.getMonth();
  const thisYear = first.getFullYear() === new Date(now).getFullYear();

  const head = `${MONTHS[first.getMonth()]} ${first.getDate()}`;
  const tail = sameMonth
    ? `${last.getDate()}`
    : `${MONTHS[last.getMonth()]} ${last.getDate()}`;
  return `${head} – ${tail}${thisYear ? '' : `, ${first.getFullYear()}`}`;
}

/** "August 2026" — the month the grid is drawing. */
function monthLabel(anchor: number): string {
  const first = new Date(startOfMonth(anchor));
  return `${MONTHS[first.getMonth()]} ${first.getFullYear()}`;
}

/**
 * "Sep 2025 – Aug 2026" — the trailing year the heat map covers, named at both
 * ends. The grid ends at a week rather than at a December, so a single year
 * number would be wrong for eleven twelfths of it.
 */
function yearLabel(anchor: number): string {
  const weeks = yearGridWeeks(anchor);
  const first = new Date(weeks[0]);
  const last = new Date(weeks[weeks.length - 1]);
  const short = (date: Date) => `${MONTHS[date.getMonth()].slice(0, 3)} ${date.getFullYear()}`;
  return `${short(first)} – ${short(last)}`;
}

/** "Today" reads better than the date for the day you are on. */
function dayLabel(day: number, now: number): string {
  const date = new Date(day);
  if (isSameDay(day, now)) return 'Today';
  const stem = `${WEEKDAYS[date.getDay()].slice(0, 3)}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? stem
    : `${stem}, ${date.getFullYear()}`;
}
