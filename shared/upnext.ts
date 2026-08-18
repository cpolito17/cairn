/**
 * Up Next selection and ranking. PROJECT-SPEC-V2.md §8, which replaces §6.7 and
 * §7.2 of PROJECT-SPEC.md.
 *
 * Still per-context, still excluding completed, hand-blocked, and
 * dependency-gated tasks. The five-entry cap is now the *default* rather than
 * the rule — the reader can grow the strip to three rows of five — but the
 * ranking below is what fills them, in exactly the same order it always did.
 * What changed in V2 is that a
 * schedule exists, so "what now?" has a second source of truth — and two
 * competing answers on one screen is worse than either alone. The resolution is
 * three tiers, in order, with a task appearing in the first one it qualifies
 * for and never twice:
 *
 *   1. **Overdue**, most overdue first. It outranks everything, including a
 *      block that starts in an hour.
 *   2. **Scheduled inside today's local day**, by start time ascending — so a
 *      block whose start has passed sorts ahead of one still to come. A task
 *      qualifies here with or without a due date.
 *   3. **Everything else with a due date**, by *effective* due moment: the due
 *      moment minus 24 hours when the task is priority-flagged.
 *
 * That 24-hour bonus is how "priority tasks near their due date rank highest"
 * becomes a sort rather than a vibe. A flagged task jumps ahead of anything due
 * within a day of it and has no effect at all on something due next month, and
 * it has no cliff — which a "promote if due within N days" rule would have.
 *
 * Unlike v1, the ranking *does* consult `now`: it is what separates the past
 * from today from later. It is injected rather than read from the clock so
 * callers and tests see the same answer for the same inputs.
 */

import { isGated, lookupOf } from './dependencies';
import { endOfLocalDay, startOfLocalDay } from './schedule';
import { DEFAULT_DIFFICULTY, type Board, type Context, type Task } from './types';

/** Entries in one row of the strip. §8. */
export const UP_NEXT_LIMIT = 5;

/**
 * How many rows the strip may be grown to.
 *
 * The cap is one row — the five §8 always specified — and the reader may add up
 * to two more. Three is not an arbitrary ceiling: the surface sits above the
 * boards and its whole job is to be readable without scrolling past it, and a
 * fourth row of five pushes the board list off a phone screen entirely. Beyond
 * that the honest answer is a board, not a longer strip.
 */
export const UP_NEXT_MAX_ROWS = 3;

/** How far a priority flag pulls a task forward in tier 3. */
export const PRIORITY_BONUS_MS = 24 * 60 * 60 * 1000;

/**
 * The epoch-ms moment a task is due, in the viewer's local time.
 *
 * A task with a date but no time is due "sometime that day" (§6.4), so it
 * sorts at the end of that day — 23:59 local. That is what puts a 3:00 PM
 * meeting ahead of an untimed task on the same date while still keeping the
 * untimed one ahead of everything on the next.
 */
export function dueMoment(task: Pick<Task, 'dueDate' | 'dueTime'>): number {
  const [year, month, day] = (task.dueDate as string).split('-').map(Number);
  const [hour, minute] = task.dueTime ? task.dueTime.split(':').map(Number) : [23, 59];
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

/**
 * The moment tier 3 sorts by: the due moment, pulled 24 hours earlier for a
 * priority-flagged task.
 *
 * It is a sort key and nothing else. It never decides which tier a task lands
 * in — a flagged task due this evening is not overdue, and shifting its key
 * must not make it look overdue.
 */
export function effectiveDueMoment(task: Pick<Task, 'dueDate' | 'dueTime' | 'priority'>): number {
  return dueMoment(task) - (task.priority ? PRIORITY_BONUS_MS : 0);
}

/** 1 overdue, 2 scheduled today, 3 dated. Anything else does not qualify. */
type Tier = 1 | 2 | 3;

interface Entry {
  task: Task;
  tier: Tier;
  /** The moment this entry's own tier ranks it by. Ascending in all three. */
  rank: number;
}

function tierOf(task: Task, now: number): Tier | null {
  if (task.dueDate !== null && dueMoment(task) < now) return 1;
  if (
    task.scheduledAt !== null &&
    task.scheduledAt >= startOfLocalDay(now) &&
    task.scheduledAt < endOfLocalDay(now)
  ) {
    return 2;
  }
  return task.dueDate !== null ? 3 : null;
}

function rankWithin(tier: Tier, task: Task): number {
  if (tier === 1) return dueMoment(task);
  if (tier === 2) return task.scheduledAt as number;
  return effectiveDueMoment(task);
}

/**
 * Up to five tasks from the non-archived boards of `context`, most urgent
 * first, by the three tiers above.
 *
 * Ties inside a tier break toward the higher difficulty (an unset difficulty
 * weighs the midpoint 3, as it does for progress), then toward the lower id.
 * That last rule is not decoration: it makes the order a total one, so the
 * strip cannot reshuffle between two renders of the same data. Priority is
 * deliberately *not* a tie-break any more — it is the 24-hour bonus in tier 3,
 * and having it in both places would count it twice.
 */
export function upNext(
  boards: Board[],
  tasks: Task[],
  context: Context,
  now: number,
  limit: number = UP_NEXT_LIMIT,
): Task[] {
  const entries: Entry[] = [];
  for (const task of answerable(boards, tasks, context)) {
    const tier = tierOf(task, now);
    if (tier === null) continue;
    entries.push({ task, tier, rank: rankWithin(tier, task) });
  }

  // Sorting the entries, not the caller's array: that one is state, and
  // Array#sort is in place.
  entries.sort(compare);
  return entries.slice(0, limit).map((entry) => entry.task);
}

/**
 * The tasks the strip is allowed to consider at all: incomplete, un-blocked,
 * un-gated, and on a live board of this context.
 *
 * A task waiting on an incomplete prerequisite is excluded for the same reason
 * a hand-blocked one is: Up Next answers "what now?", and neither can be done
 * now. It leaves the strip the moment its prerequisite is completed.
 *
 * Shared with `overdueTasks` on purpose. The audit exists to clear things out
 * of this strip, so it has to be looking at the same population — an audit that
 * offered to triage a task Up Next was never going to show is an audit that
 * wastes the one interaction it gets each day.
 */
function answerable(boards: Board[], tasks: Task[], context: Context): Task[] {
  const eligibleBoards = new Set(
    boards.filter((b) => b.context === context && b.archivedAt === null).map((b) => b.id),
  );
  const lookup = lookupOf(tasks);

  return tasks.filter(
    (task) =>
      task.completedAt === null &&
      !task.blocked &&
      eligibleBoards.has(task.boardId) &&
      isGated(task, lookup) === false,
  );
}

/**
 * Every task the strip would rank in tier 1 — overdue, and still answerable —
 * most overdue first.
 *
 * This is the Overdue Audit's list. It is deliberately *not* "everything with a
 * date in the past": a task already marked blocked, or gated behind a
 * prerequisite, is one whose overdue-ness has already been accounted for, and
 * re-offering it every morning is the same clog the audit exists to clear.
 * Triaging a task is therefore also how it leaves this list.
 *
 * Uncapped, unlike `upNext`. The strip has a length because it is a glance;
 * the audit has to show all of it, because a partial list would leave the
 * reader believing they had finished.
 */
export function overdueTasks(
  boards: Board[],
  tasks: Task[],
  context: Context,
  now: number,
): Task[] {
  const entries: Entry[] = answerable(boards, tasks, context)
    .filter((task) => task.dueDate !== null && dueMoment(task) < now)
    .map((task) => ({ task, tier: 1, rank: dueMoment(task) }));

  entries.sort(compare);
  return entries.map((entry) => entry.task);
}

function compare(a: Entry, b: Entry): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.rank !== b.rank) return a.rank - b.rank;

  const byDifficulty =
    (b.task.difficulty ?? DEFAULT_DIFFICULTY) - (a.task.difficulty ?? DEFAULT_DIFFICULTY);
  if (byDifficulty !== 0) return byDifficulty;

  return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
}

/**
 * True when an entry is present because of its block rather than its due date.
 *
 * The card leads with the scheduled time behind a clock glyph when it is, and
 * with the due date behind a calendar glyph when it is not (§8) — an entry that
 * has both shows the one its tier is about.
 */
export function isScheduledEntry(task: Task, now: number): boolean {
  return tierOf(task, now) === 2;
}
