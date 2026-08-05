/**
 * The month view. PROJECT-SPEC-V2.md §6.5; PROJECT-SPEC.md §8.3, §8.4.
 *
 * Six rows of seven day cells, each listing its day as one-line entries — the
 * start time, then the task name truncated to the cell — up to three, then a
 * `+N more` line. It is **read-and-navigate only** (§11): nothing here is
 * draggable, nothing accepts a drop, and clicking a day drops into the week
 * view at that day. A month cell has no time component, so a drop onto one
 * would need a second interaction to say *when*; that second interaction is the
 * click into the week, and it is the whole navigation model rather than a
 * missing feature.
 *
 * Everything the grid *decides* — which 42 days, which entries, in what order,
 * which are the adjacent month's — is `shared/planner.ts`. This file draws.
 *
 * The other context's blocks appear as unlabelled `--surface-2` bars carrying
 * no name, and they are counted in the `+N more` line like any other entry: a
 * day that looks half empty because the ghosts were dropped from the count is a
 * day someone will double-book.
 */

import { isSameDay, type MonthDay, type MonthEntry } from '../../../shared/planner';
import type { Context, Task } from '../../../shared/types';
import { formatCompactTime } from '../../lib/dates';
import { useMonth, useStore } from '../../lib/store';
import { EmptyLine } from '../ui/Section';
import { Skeleton } from '../ui/Skeleton';
import { PlannerError } from './PlannerError';

/** Entries a cell shows before the overflow line takes over (§6.5). */
const MAX_ENTRIES = 3;

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

export interface MonthGridProps {
  context: Context;
  /** Any moment in the month to draw. */
  month: number;
  now: number;
  /** Drops into the week view at that day (§6.5). */
  onOpenDay(day: number): void;
}

export function MonthGrid({ context, month, now, onOpenDay }: MonthGridProps) {
  const status = useStore((state) => state.status);

  if (status === 'loading') return <MonthSkeleton />;
  if (status === 'error') return <PlannerError subject="your month" />;

  return <Grid context={context} month={month} now={now} onOpenDay={onOpenDay} />;
}

function Grid({ context, month, now, onOpenDay }: MonthGridProps) {
  const days = useMonth(context, month);
  const tasks = useStore((state) => state.tasks);
  const empty = days.every((day) => day.entries.length === 0);

  return (
    <div className="mt-4">
      <div
        className="grid"
        style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}
        aria-hidden="true"
      >
        {WEEKDAYS_SHORT.map((label) => (
          <div
            key={label}
            className="truncate px-2 pb-2 text-center text-section text-text-secondary"
            style={{ textTransform: 'uppercase' }}
          >
            {label}
          </div>
        ))}
      </div>

      {/* The hairlines are the gaps: one background behind a one-pixel-gapped
          grid draws 42 cells' worth of rules without 42 elements' worth of
          borders meeting at doubled edges. */}
      <div
        className="grid overflow-hidden rounded-card"
        style={{
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gap: 'var(--hairline-width)',
          background: 'var(--hairline)',
          border: 'var(--hairline-width) solid var(--hairline)',
        }}
      >
        {days.map((day) => (
          <DayCell
            key={day.dayStart}
            day={day}
            tasks={tasks}
            now={now}
            onOpenDay={onOpenDay}
          />
        ))}
      </div>

      {empty && (
        <EmptyLine>
          Nothing scheduled in {MONTHS[new Date(month).getMonth()]}. Drop a task onto the week
          view to fill it.
        </EmptyLine>
      )}
    </div>
  );
}

function DayCell({
  day,
  tasks,
  now,
  onOpenDay,
}: {
  day: MonthDay;
  tasks: Record<string, Task>;
  now: number;
  onOpenDay(day: number): void;
}) {
  const date = new Date(day.dayStart);
  const today = isSameDay(day.dayStart, now);
  const shown = day.entries.slice(0, MAX_ENTRIES);
  const overflow = day.entries.length - shown.length;

  return (
    <button
      type="button"
      onClick={() => onOpenDay(day.dayStart)}
      aria-label={
        `${WEEKDAYS_FULL[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}` +
        `${today ? ', today' : ''}` +
        `${day.entries.length === 0 ? ', nothing scheduled' : ''}`
      }
      className="planner-month-cell hoverable relative flex flex-col items-stretch gap-1
                 bg-bg px-1 pb-1 pt-1 text-left"
      style={{
        // §6.5: today is an accent **outline**, never an accent fill. An outline
        // rather than a border so the cell's own geometry does not change and
        // the row cannot shift by a pixel under the pointer.
        outline: today ? '2px solid var(--accent)' : undefined,
        outlineOffset: '-2px',
        // The adjacent month is recessed rather than recoloured: opacity dims
        // the date, the names and the ghosts by the same amount in all eight
        // themes, where a hand-picked "faint" colour would only work in some.
        opacity: day.inMonth ? 1 : 0.4,
      }}
    >
      <span
        className={`px-1 text-meta ${today ? 'text-accent' : 'text-text-secondary'}`}
        style={{ fontWeight: today ? 700 : 500 }}
      >
        {date.getDate()}
      </span>

      <span className="flex min-h-0 flex-col gap-0.5">
        {shown.map((entry, index) => (
          <Entry
            key={entry.ghost ? `ghost:${entry.startMs}:${index}` : (entry.taskId as string)}
            entry={entry}
            task={entry.taskId === null ? undefined : tasks[entry.taskId]}
          />
        ))}

        {overflow > 0 && (
          <span className="px-1 text-meta text-text-secondary">+{overflow} more</span>
        )}
      </span>
    </button>
  );
}

/**
 * One line of a cell.
 *
 * A ghost is a bar and nothing else — no time, no name, no chip — because
 * `MonthEntry` never carried one. A completed entry is struck through, and it
 * stays in the list: completion does not clear the block (§3.1), and the hour
 * it occupied is still the record of the day.
 */
function Entry({ entry, task }: { entry: MonthEntry; task: Task | undefined }) {
  if (entry.ghost) {
    return (
      <span
        aria-hidden="true"
        className="block rounded-chip bg-surface-2"
        style={{ height: '0.6875rem' }}
      />
    );
  }

  if (entry.eventName) {
    return <span className="flex min-w-0 items-baseline gap-1 px-1 text-meta">
      <span className="shrink-0 text-text-tertiary">{formatCompactTime(entry.startMs)}</span>
      <span className="truncate text-text-secondary">{entry.eventName}</span>
    </span>;
  }

  if (task === undefined) return null;

  const done = task.completedAt !== null;

  return (
    <span className="flex min-w-0 items-baseline gap-1 px-1 text-meta">
      {/* Tabular figures come from the global rule in index.css (§8.3), so a
          column of 9a / 11:30a / 2p lines up on the colon. */}
      <span className="shrink-0 text-text-tertiary">{formatCompactTime(entry.startMs)}</span>
      <span
        className="min-w-0 flex-1 truncate"
        style={{
          color: done ? 'var(--text-tertiary)' : 'var(--text)',
          textDecoration: done ? 'line-through' : undefined,
        }}
      >
        {task.name}
      </span>
    </span>
  );
}

/** §8.4: the real geometry with skeleton lines in it, not a spinner in a box. */
function MonthSkeleton() {
  return (
    <div className="mt-4">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
        {WEEKDAYS_SHORT.map((label) => (
          <div
            key={label}
            className="truncate px-2 pb-2 text-center text-section text-text-secondary"
            style={{ textTransform: 'uppercase' }}
          >
            {label}
          </div>
        ))}
      </div>

      <div
        className="grid overflow-hidden rounded-card"
        style={{
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gap: 'var(--hairline-width)',
          background: 'var(--hairline)',
          border: 'var(--hairline-width) solid var(--hairline)',
        }}
      >
        {Array.from({ length: 42 }, (_, index) => (
          <div key={index} className="planner-month-cell flex flex-col gap-1 bg-bg p-1">
            <Skeleton width="1.25rem" height="0.75rem" />
            {index % 3 !== 1 && <Skeleton width="85%" height="0.6875rem" />}
            {index % 4 === 0 && <Skeleton width="60%" height="0.6875rem" />}
          </div>
        ))}
      </div>
    </div>
  );
}
