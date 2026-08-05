/**
 * The Planner's pure logic: which week, month or year you are looking at, what
 * order the unscheduled list is in, and which blocks share a column on a given
 * day.
 *
 * Everything the Planner *decides* lives here; the components only draw. That
 * split is load-bearing rather than tidy — a sort written inside a list is a
 * sort with no test, and a lane assignment written inside a column is one that
 * silently differs between the week grid and the day pager, which are the same
 * schedule at two widths.
 *
 * Geometry proper — snapping, effective duration, lane packing itself — belongs
 * to `shared/schedule.ts` and is called from here rather than re-derived.
 *
 * PROJECT-SPEC-V2.md §6.2, §6.3, §6.4, §6.5, §6.6.
 */

import {
  blockOf,
  endOfLocalDay,
  localDayKey,
  packLanes,
  scheduledMinutesByDay,
  startOfLocalDay,
} from './schedule';
import type { PlannerSort, Settings, Task } from './types';
import type { PlannerEvent } from './types';
import { eventOccurrences } from './events';
import { dueMoment } from './upnext';

/* --- the calendar ---------------------------------------------------------- */

/** Days in a week column set. Sunday through Saturday (§6.3). */
export const DAYS_PER_WEEK = 7;

/**
 * Local midnight of the Sunday starting the week containing `at`.
 *
 * Built from `Date`'s local accessors rather than by subtracting milliseconds:
 * a week that spans a DST transition is 167 or 169 hours long, and arithmetic
 * on epoch milliseconds puts its Sunday an hour into Saturday.
 */
export function startOfWeek(at: number): number {
  const day = new Date(startOfLocalDay(at));
  day.setDate(day.getDate() - day.getDay());
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Local midnight `count` days from the day containing `at`. May be negative. */
export function addDays(at: number, count: number): number {
  const day = new Date(startOfLocalDay(at));
  day.setDate(day.getDate() + count);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The seven local midnights of the week containing `at`, Sunday first. */
export function weekDays(at: number): number[] {
  const start = startOfWeek(at);
  return Array.from({ length: DAYS_PER_WEEK }, (_, index) => addDays(start, index));
}

/** True when `at` falls on the same local day as `other`. */
export function isSameDay(at: number, other: number): boolean {
  return startOfLocalDay(at) === startOfLocalDay(other);
}

/** Local midnight on the first of the month containing `at`. */
export function startOfMonth(at: number): number {
  const day = new Date(at);
  day.setDate(1);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * The first of the month `count` months from the one containing `at`.
 *
 * The day is set to the 1st *before* the month is moved, deliberately: `Date`
 * clamps by overflowing, so stepping forward from the 31st of a 31-day month
 * lands in the month after the one asked for. Every caller here wants the
 * month, so the day-of-month never gets the chance to speak.
 */
export function addMonths(at: number, count: number): number {
  const day = new Date(startOfMonth(at));
  day.setMonth(day.getMonth() + count);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** True when two moments fall in the same month of the same year. */
export function isSameMonth(at: number, other: number): boolean {
  return startOfMonth(at) === startOfMonth(other);
}

/** Rows in the month grid (§6.5). Always six — see `monthGridDays`. */
export const WEEKS_PER_MONTH_GRID = 6;

/**
 * The 42 local midnights the month grid draws: the Sunday on or before the 1st,
 * then six weeks.
 *
 * **Always six rows, never five.** §6.5 asks for a six-by-seven grid, and the
 * alternative — as many rows as the month needs — would change the grid's
 * height between February and March, so paging months would move the toolbar
 * and the cells under the pointer. The leftover days are adjacent-month days,
 * which the grid already knows how to recess.
 */
export function monthGridDays(at: number): number[] {
  const first = startOfMonth(at);
  const start = startOfWeek(first);
  return Array.from({ length: WEEKS_PER_MONTH_GRID * DAYS_PER_WEEK }, (_, index) =>
    addDays(start, index),
  );
}

/** Columns in the year heat map (§6.6). */
export const WEEKS_PER_YEAR_GRID = 53;

/**
 * The 53 week starts the heat map draws, oldest first, **ending with the week
 * containing `at`** — the trailing year, not January to December.
 *
 * §6.6 asks for a grid that ends at the current week, which is the same window
 * a contribution graph draws: the year up to now, so the right-hand edge is
 * today rather than a December that has not happened yet.
 */
export function yearGridWeeks(at: number): number[] {
  const last = startOfWeek(at);
  return Array.from({ length: WEEKS_PER_YEAR_GRID }, (_, index) =>
    addDays(last, (index - (WEEKS_PER_YEAR_GRID - 1)) * DAYS_PER_WEEK),
  );
}

/* --- the unscheduled list -------------------------------------------------- */

/**
 * Every sort in §6.2 ends the same way — due moment ascending with undated
 * last, then id — so the tail is written once. `Infinity` is how "undated
 * last" is expressed: it is a sort key, and a task with no date is later than
 * every task that has one.
 */
function dueKey(task: Task): number {
  return task.dueDate === null ? Infinity : dueMoment(task);
}

function byId(a: Task, b: Task): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byDueThenId(a: Task, b: Task): number {
  return dueKey(a) - dueKey(b) || byId(a, b);
}

/**
 * The four orders of §6.2, verbatim. Each is a **total** order — every chain
 * ends at the id, so no two tasks ever compare equal and re-sorting the same
 * list cannot reshuffle it.
 *
 * **Unset sorts last in every mode**, which is why the two nullable numeric
 * keys map to infinities rather than to zero: difficulty descends, so unset is
 * `-Infinity`; duration ascends, so unset is `+Infinity`. Reading a missing
 * value as 0 would put an unestimated task at the head of the duration sort,
 * which is the opposite of what "unset" means to someone planning a day.
 */
export const SORT_COMPARATORS: Record<PlannerSort, (a: Task, b: Task) => number> = {
  // Flagged first → due ascending (undated last) → id.
  priority: (a, b) => Number(b.priority) - Number(a.priority) || byDueThenId(a, b),

  // 5→1 with unset last → due ascending (undated last) → id.
  difficulty: (a, b) =>
    (b.difficulty ?? -Infinity) - (a.difficulty ?? -Infinity) || byDueThenId(a, b),

  // Due ascending (undated last) → flagged first → id.
  dueDate: (a, b) =>
    dueKey(a) - dueKey(b) || Number(b.priority) - Number(a.priority) || byId(a, b),

  // Minutes ascending with unset last → due ascending → id.
  duration: (a, b) =>
    (a.durationMinutes ?? Infinity) - (b.durationMinutes ?? Infinity) || byDueThenId(a, b),
};

/** The list in `sort` order. The input is not mutated. */
export function sortUnscheduled(tasks: readonly Task[], sort: PlannerSort): Task[] {
  return [...tasks].sort(SORT_COMPARATORS[sort]);
}

/** One board's slice of the list, when grouping is on (§6.2). */
export interface TaskGroup {
  boardId: string;
  boardName: string;
  tasks: Task[];
}

/**
 * Group the list under its boards, in **board order** — the order the caller
 * passes, which is the store's `position` order — with the active sort applied
 * within each group. Boards with nothing unscheduled are omitted rather than
 * rendered as an empty heading.
 */
export function groupByBoard(
  tasks: readonly Task[],
  boards: readonly { id: string; name: string }[],
  sort: PlannerSort,
): TaskGroup[] {
  const groups: TaskGroup[] = [];
  for (const board of boards) {
    const mine = tasks.filter((task) => task.boardId === board.id);
    if (mine.length === 0) continue;
    groups.push({ boardId: board.id, boardName: board.name, tasks: sortUnscheduled(mine, sort) });
  }
  return groups;
}

/* --- the schedule ---------------------------------------------------------- */

/**
 * A block as the grid draws it: where it starts, how long it runs, and which
 * slice of the column width it owns.
 *
 * A ghost is the *other* context's block (§6.3). It carries no name, no board
 * and no chip — not because the renderer declines to draw them but because
 * they are not in the value it is handed. The separation of the two contexts is
 * the reason they exist at all, so a ghost that could leak a name is a leak
 * waiting for a careless component.
 */
export interface PlacedBlock {
  /** The task's id for a real block; absent on a ghost. */
  taskId: string | null;
  /** A current-context calendar event; mutually exclusive with taskId. */
  eventId?: string;
  ghost: boolean;
  startMs: number;
  minutes: number;
  lane: number;
  lanes: number;
}

/** One day column: its local midnight and everything drawn in it. */
export interface DayLayout {
  dayStart: number;
  blocks: PlacedBlock[];
}

/** Ghost ids are namespaced so a ghost and a real block can never collide. */
const GHOST_PREFIX = 'ghost:';

function scheduledOn(dayStart: number, tasks: readonly Task[]): Task[] {
  const dayEnd = endOfLocalDay(dayStart);
  return tasks.filter(
    (task) =>
      task.scheduledAt !== null && task.scheduledAt >= dayStart && task.scheduledAt < dayEnd,
  );
}

/**
 * Lay out one day: the current context's blocks and the other context's ghosts,
 * packed **together**.
 *
 * Together is the whole point. Packing the two sets separately would give a
 * real block and a ghost the same lane at the same width, and the real one
 * would be drawn over the busy time it was supposed to be warning about.
 */
export function layoutDay(
  dayStart: number,
  own: readonly Task[],
  other: readonly Task[],
  ownEvents: readonly PlannerEvent[] = [],
  otherEvents: readonly PlannerEvent[] = [],
): DayLayout {
  // `scheduledOn` has already established that every one of these has a block,
  // so the nulls `blockOf` is typed to allow cannot occur here.
  const ownBlocks = scheduledOn(dayStart, own)
    .map(blockOf)
    .filter((block) => block !== null);
  const ghostBlocks = scheduledOn(dayStart, other)
    .map(blockOf)
    .filter((block) => block !== null)
    .map((block) => ({ ...block, id: `${GHOST_PREFIX}${block.id}` }));

  const eventBlocks = eventOccurrences(ownEvents, [dayStart]).map(({ event, startMs }) => ({
    id: `event:${event.id}`, startMs, minutes: event.durationMinutes,
  }));
  const ghostEventBlocks = eventOccurrences(otherEvents, [dayStart]).map(({ event, startMs }) => ({
    id: `${GHOST_PREFIX}event:${event.id}`, startMs, minutes: event.durationMinutes,
  }));

  const blocks = packLanes([...ownBlocks, ...ghostBlocks, ...eventBlocks, ...ghostEventBlocks]).map(({ block, lane, lanes }) => {
    const ghost = block.id.startsWith(GHOST_PREFIX);
    const rawId = ghost ? block.id.slice(GHOST_PREFIX.length) : block.id;
    const event = rawId.startsWith('event:');
    return {
      taskId: ghost || event ? null : block.id,
      ...(ghost || !event ? {} : { eventId: rawId.slice('event:'.length) }),
      ghost,
      startMs: block.startMs,
      minutes: block.minutes,
      lane,
      lanes,
    };
  });

  return { dayStart, blocks };
}

/** `layoutDay` across a set of days — the week grid and the day pager alike. */
export function layoutDays(
  days: readonly number[],
  own: readonly Task[],
  other: readonly Task[],
  ownEvents: readonly PlannerEvent[] = [],
  otherEvents: readonly PlannerEvent[] = [],
): DayLayout[] {
  return days.map((dayStart) => layoutDay(dayStart, own, other, ownEvents, otherEvents));
}

/* --- the month grid -------------------------------------------------------- */

/**
 * One line in a month cell (§6.5): a start time and a name, or — for the other
 * context — an unlabelled bar.
 *
 * Like `PlacedBlock`, a ghost carries no id and therefore no way back to a
 * name. The month cell is a denser surface than the week grid and the
 * temptation to "just show what it is" is correspondingly larger, so the value
 * simply does not contain it.
 */
export interface MonthEntry {
  /** The task's id for the current context's block; absent on a ghost. */
  taskId: string | null;
  eventName?: string;
  ghost: boolean;
  startMs: number;
}

/** One cell of the month grid. */
export interface MonthDay {
  dayStart: number;
  /** False for the adjacent-month days the six-row grid needs to fill (§6.5). */
  inMonth: boolean;
  /** Every entry of the day, in start order. The cell shows the first three. */
  entries: MonthEntry[];
}

/**
 * The month grid: 42 cells, each carrying its whole day in chronological order.
 *
 * Entries are **not** truncated here. The cell decides how many lines it has
 * room for and what the `+N more` line counts — and it has to count the ghosts
 * it did not name, which it can only do if it was handed them.
 */
export function layoutMonth(
  monthAnchor: number,
  own: readonly Task[],
  other: readonly Task[],
  ownEvents: readonly PlannerEvent[] = [],
  otherEvents: readonly PlannerEvent[] = [],
): MonthDay[] {
  const month = startOfMonth(monthAnchor);

  return monthGridDays(month).map((dayStart) => {
    // The id every entry sorts by, including the ghosts'. It is a sort key and
    // nothing else: it never reaches `MonthEntry`, so a ghost stays anonymous.
    const sorted = [
      ...scheduledOn(dayStart, own).map((task) => ({ id: task.id, taskId: task.id, startMs: task.scheduledAt as number, ghost: false })),
      ...scheduledOn(dayStart, other).map((task) => ({ id: task.id, taskId: null, startMs: task.scheduledAt as number, ghost: true })),
      ...eventOccurrences(ownEvents, [dayStart]).map(({ event, startMs }) => ({ id: `event:${event.id}`, taskId: null, eventName: event.name, startMs, ghost: false })),
      ...eventOccurrences(otherEvents, [dayStart]).map(({ event, startMs }) => ({ id: `event:${event.id}`, taskId: null, startMs, ghost: true })),
    ].sort((a, b) => a.startMs - b.startMs || Number(a.ghost) - Number(b.ghost) || a.id.localeCompare(b.id));

    return {
      dayStart,
      inMonth: startOfMonth(dayStart) === month,
      entries: sorted.map((item): MonthEntry => {
        const entry: MonthEntry = { taskId: item.taskId, ghost: item.ghost, startMs: item.startMs };
        if ('eventName' in item && typeof item.eventName === 'string') entry.eventName = item.eventName;
        return entry;
      }),
    };
  });
}

/* --- the year heat map ----------------------------------------------------- */

/** How much of a day is spoken for, and — for the tooltip — by what (§6.6). */
export interface HeatDay {
  /** Total scheduled minutes, **both contexts**. A full day is a full day. */
  minutes: number;
  /** The current context's tasks that day, in start order. Named in the tooltip. */
  own: Task[];
  /** Current-context recurring events on this day. */
  events?: { id: string; name: string; startMs: number }[];
}

/**
 * The heat map's data, keyed `YYYY-MM-DD`. Days with nothing are absent — the
 * caller is iterating a calendar, not this map.
 *
 * The asymmetry between the two fields is §6.6's, deliberately: both contexts'
 * blocks fill the square, and only the current context's are named under it.
 * Totalling one set and listing the other in the same pass is what keeps the
 * two from drifting apart in a component that forgot one of them.
 */
export function heatByDay(own: readonly Task[], other: readonly Task[]): Record<string, HeatDay> {
  const minutes = scheduledMinutesByDay([...own, ...other]);

  const heat: Record<string, HeatDay> = {};
  for (const [key, total] of Object.entries(minutes)) heat[key] = { minutes: total, own: [] };

  for (const task of own) {
    if (task.scheduledAt === null) continue;
    heat[localDayKey(task.scheduledAt)]?.own.push(task);
  }
  for (const day of Object.values(heat)) {
    day.own.sort((a, b) => (a.scheduledAt as number) - (b.scheduledAt as number) || byId(a, b));
  }
  return heat;
}

/** The length of the configured working day, in minutes (§3.2, §6.8). */
export function workdayMinutes(settings: Pick<Settings, 'workdayStartMinutes' | 'workdayEndMinutes'>): number {
  return settings.workdayEndMinutes - settings.workdayStartMinutes;
}

/**
 * The five fills of §6.6, as an index: 0 nothing, 1 up to a quarter of a
 * workday, 2 up to a half, 3 up to three quarters, 4 above that.
 */
export type HeatBucket = 0 | 1 | 2 | 3 | 4;

/**
 * Which bucket a day's scheduled minutes fall in, measured against the length
 * of the configured working day.
 *
 * The comparisons are cross-multiplied rather than written as `minutes /
 * workday <= 0.25`, so a day at *exactly* a quarter of the workday lands in the
 * bucket §6.6 names rather than one either side of it. Every quantity here is
 * an integer number of minutes; the ratio is not, and 0.25 is only exact for
 * the workday lengths that happen to divide by four.
 *
 * "Up to" is inclusive at every step and the top bucket is open: a day above a
 * full workday is as full as the grid can say, and there is no darker square
 * to promote it to.
 */
export function heatBucket(minutes: number, workday: number): HeatBucket {
  if (minutes <= 0) return 0;
  // A workday with no length is not a scale, and dividing by it would make
  // every scheduled day equally infinite. Anything scheduled is over it.
  if (workday <= 0) return 4;
  if (minutes * 4 <= workday) return 1;
  if (minutes * 2 <= workday) return 2;
  if (minutes * 4 <= workday * 3) return 3;
  return 4;
}
