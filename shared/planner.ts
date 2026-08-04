/**
 * The Planner's pure logic: which week you are looking at, what order the
 * unscheduled list is in, and which blocks share a column on a given day.
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
 * PROJECT-SPEC-V2.md §6.2, §6.3, §6.4.
 */

import { blockOf, endOfLocalDay, packLanes, startOfLocalDay } from './schedule';
import type { PlannerSort, Task } from './types';
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

  const blocks = packLanes([...ownBlocks, ...ghostBlocks]).map(({ block, lane, lanes }) => {
    const ghost = block.id.startsWith(GHOST_PREFIX);
    return {
      taskId: ghost ? null : block.id,
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
): DayLayout[] {
  return days.map((dayStart) => layoutDay(dayStart, own, other));
}
