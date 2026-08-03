/**
 * Difficulty-weighted board progress. PROJECT-SPEC.md §7.1.
 *
 * Runs on the client, not the server: the client already holds every task from
 * `GET /api/state`, so a completion, a deletion, or a difficulty change
 * recomputes locally with no round trip. That is what makes the optimistic
 * update instant.
 *
 * Each task contributes weight equal to its difficulty, and a task whose
 * difficulty was never set contributes the midpoint 3. The midpoint is the
 * whole design: on a board where nobody set a difficulty, every task weighs
 * the same, the weights cancel, and the result is exactly the plain
 * completed-over-total ratio — no branch, no special case for the common board.
 */

import { DEFAULT_DIFFICULTY, type Task } from './types';

export interface BoardProgress {
  /** Completed weight over total weight, as a whole-number percentage. */
  percent: number;
  /** Plain task counts, for the "7 of 12" line beside the bar. */
  done: number;
  total: number;
}

/** The weight a task contributes. Unset difficulty is the midpoint. */
export function taskWeight(task: Pick<Task, 'difficulty'>): number {
  return task.difficulty ?? DEFAULT_DIFFICULTY;
}

export function boardProgress(tasks: Task[]): BoardProgress {
  let totalWeight = 0;
  let doneWeight = 0;
  let done = 0;

  for (const task of tasks) {
    const weight = taskWeight(task);
    totalWeight += weight;
    if (task.completedAt !== null) {
      doneWeight += weight;
      done += 1;
    }
  }

  // An empty board reads 0%, never 100% — the division is guarded rather than
  // left to produce NaN, and the bar renders empty.
  const percent = totalWeight === 0 ? 0 : Math.round((doneWeight / totalWeight) * 100);

  return { percent, done, total: tasks.length };
}
