/**
 * The Closed log: every completed task in a context, as a table reads it.
 *
 * The Board screen already shows a board's Completed group, but only that
 * board's, and only in the order it finished. The Closed view asks a different
 * question — "what have I finished lately, across everything?" — so it flattens
 * every board in the context into one row per completed task, carries the board
 * along for the column that names it, and measures how long each one took.
 *
 * Pure, and injected with what it needs: no clock is read here, because nothing
 * in a closed row depends on now. A task's elapsed time is `createdAt` to
 * `completedAt`, and whether it landed before its due moment is a comparison of
 * two past instants. Only the *filter* takes a `since`, and the caller supplies
 * it.
 */

import type { Board, Context, Task } from './types';
import { dueMoment } from './upnext';

const DAY_MS = 86_400_000;

/** One row of the Closed table. */
export interface ClosedRow {
  task: Task;
  board: Board;
  /** `task.completedAt`, non-null by construction. */
  closedAt: number;
  /**
   * Days from creation to completion, fractional. Never negative: a clock skew
   * or an imported task that claims to have finished before it existed is
   * clamped to zero rather than rendered as "-3 days".
   */
  elapsedDays: number;
  /**
   * True when it was completed at or before its due moment, false when after,
   * and null when it never carried a due date — three distinct answers, because
   * "no deadline" is not "on time".
   */
  onTime: boolean | null;
}

/** The columns the table can sort by. */
export type ClosedSort = 'closed' | 'elapsed' | 'board' | 'name';

export type SortDirection = 'asc' | 'desc';

/**
 * Every completed task in a context, most recently closed first.
 *
 * Tasks on **archived** boards are included. Archiving puts a board away; it
 * does not un-finish the work, and a log that quietly drops history the moment
 * a board is filed is a log you cannot trust. The row carries the board, so the
 * screen can mark those rows rather than hide them.
 */
export function closedRows(boards: Board[], tasks: Task[], context: Context): ClosedRow[] {
  const inContext = new Map(
    boards.filter((board) => board.context === context).map((board) => [board.id, board]),
  );

  const rows: ClosedRow[] = [];
  for (const task of tasks) {
    if (task.completedAt === null) continue;
    const board = inContext.get(task.boardId);
    if (!board) continue;
    rows.push({
      task,
      board,
      closedAt: task.completedAt,
      elapsedDays: Math.max(0, (task.completedAt - task.createdAt) / DAY_MS),
      onTime: task.dueDate === null ? null : task.completedAt <= dueMoment(task),
    });
  }

  return sortClosed(rows, 'closed', 'desc');
}

/**
 * Sort a set of rows by one column.
 *
 * Every comparison falls back to the close time, then to the id: two tasks
 * finished in the same minute on the same board must not swap places between
 * two renders of identical data.
 */
export function sortClosed(
  rows: ClosedRow[],
  sort: ClosedSort,
  direction: SortDirection,
): ClosedRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = compare(a, b, sort);
    if (primary !== 0) return primary * sign;
    // The tiebreak is not flipped by `direction`: it is there to make the order
    // total, not to be a second sort the user asked for.
    if (a.closedAt !== b.closedAt) return b.closedAt - a.closedAt;
    return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
  });
}

function compare(a: ClosedRow, b: ClosedRow, sort: ClosedSort): number {
  switch (sort) {
    case 'closed':
      return a.closedAt - b.closedAt;
    case 'elapsed':
      return a.elapsedDays - b.elapsedDays;
    case 'board':
      return collate(a.board.name, b.board.name);
    case 'name':
      return collate(a.task.name, b.task.name);
  }
}

/** Case-insensitive name order, so "apple" does not sort after "Zebra". */
function collate(a: string, b: string): number {
  const left = a.toLocaleLowerCase();
  const right = b.toLocaleLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The rows matching a free-text query and, optionally, closed at or after
 * `since`.
 *
 * The query matches the task name **and** the board name: typing a board's name
 * into the one search box on the screen and getting nothing back is the kind of
 * dead end that makes a filter feel broken.
 */
export function filterClosed(
  rows: ClosedRow[],
  query: string,
  since: number | null,
): ClosedRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (since !== null && row.closedAt < since) return false;
    if (needle === '') return true;
    return (
      row.task.name.toLocaleLowerCase().includes(needle) ||
      row.board.name.toLocaleLowerCase().includes(needle)
    );
  });
}

/** The figures above the table: how many, how fast, how punctual. */
export interface ClosedSummary {
  count: number;
  /**
   * The **median** elapsed time in days, not the mean — one task that sat open
   * for a year would otherwise report a typical week as a typical month. Null
   * when there are no rows.
   */
  medianDays: number | null;
  /** Rows closed at or after `since`, for the "this week" figure. */
  recent: number;
  /** Of the rows that carried a due date, how many landed on time. */
  onTime: number;
  dated: number;
}

export function closedSummary(rows: ClosedRow[], since: number): ClosedSummary {
  const elapsed = rows.map((row) => row.elapsedDays).sort((a, b) => a - b);
  const dated = rows.filter((row) => row.onTime !== null);

  return {
    count: rows.length,
    medianDays: elapsed.length === 0 ? null : median(elapsed),
    recent: rows.filter((row) => row.closedAt >= since).length,
    onTime: dated.filter((row) => row.onTime === true).length,
    dated: dated.length,
  };
}

/** The middle of an already-ascending list; the mean of the middle two when even. */
function median(ascending: number[]): number {
  const middle = Math.floor(ascending.length / 2);
  return ascending.length % 2 === 1
    ? ascending[middle]
    : (ascending[middle - 1] + ascending[middle]) / 2;
}
