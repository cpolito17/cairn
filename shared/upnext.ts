/**
 * Up Next selection and ranking. PROJECT-SPEC.md §6.7 and §7.2.
 *
 * Ranks by urgency, not importance — importance is what the boards are for.
 * Like `shared/progress.ts` this runs on the client over the snapshot from
 * `GET /api/state`, which is what makes an Up Next spanning every board free.
 *
 * `now` is injected rather than read from the clock so callers and tests see
 * the same answer for the same inputs.
 */

import { isGated, lookupOf } from './dependencies';
import { DEFAULT_DIFFICULTY, type Board, type Context, type Task } from './types';

/** Most entries the strip shows. §6.7. */
export const UP_NEXT_LIMIT = 5;

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
 * Up to five incomplete, non-blocked, dated tasks from the non-archived boards
 * of `context`, most urgent first.
 *
 * Overdue tasks outrank everything and appear most-overdue first; the rest
 * follow by due moment ascending. Those are one comparison, not two: sorting
 * every candidate by due moment ascending already puts the moments behind
 * `now` at the front, oldest first, whatever `now` is. So `now` is taken —
 * the contract is fixed and the caller needs it anyway to render "Overdue by
 * 2 days" — but the ranking does not consult it, which is also why no clock
 * read can leak in here.
 *
 * Ties break toward priority, then toward the higher difficulty (an unset
 * difficulty weighs the midpoint 3, as it does for progress), then toward the
 * lower id. That last rule is not decoration: it makes the order a total one,
 * so the strip cannot reshuffle between two renders of the same data.
 */
export function upNext(boards: Board[], tasks: Task[], context: Context, _now: number): Task[] {
  const eligibleBoards = new Set(
    boards.filter((b) => b.context === context && b.archivedAt === null).map((b) => b.id),
  );

  // A task waiting on an incomplete prerequisite is excluded for the same
  // reason a hand-blocked one is: Up Next answers "what now?", and neither can
  // be done now. It leaves the strip the moment its prerequisite is completed.
  const lookup = lookupOf(tasks);

  const candidates = tasks.filter(
    (t) =>
      t.completedAt === null &&
      !t.blocked &&
      !isGated(t, lookup) &&
      t.dueDate !== null &&
      eligibleBoards.has(t.boardId),
  );

  // Sorting a copy: the caller's array is state, and Array#sort is in place.
  const ranked = [...candidates].sort(compare);
  return ranked.slice(0, UP_NEXT_LIMIT);
}

function compare(a: Task, b: Task): number {
  const byMoment = dueMoment(a) - dueMoment(b);
  if (byMoment !== 0) return byMoment;

  if (a.priority !== b.priority) return a.priority ? -1 : 1;

  const byDifficulty = (b.difficulty ?? DEFAULT_DIFFICULTY) - (a.difficulty ?? DEFAULT_DIFFICULTY);
  if (byDifficulty !== 0) return byDifficulty;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
