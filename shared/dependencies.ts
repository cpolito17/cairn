/**
 * Task dependencies — the rules, in one place.
 *
 * A task may wait on one other task on the same board. While that prerequisite
 * is incomplete the dependent is *gated*: it reads as unavailable and it cannot
 * be completed. Completing the prerequisite releases everything waiting on it,
 * with no second write — the gate is derived, never stored, so there is no
 * denormalized flag to fall out of step with the thing it describes.
 *
 * The client and the Worker share this file so they cannot disagree about what
 * a legal link is: the composer offers exactly the options `canDependOn` allows,
 * and the Worker re-checks with the same function on untrusted input.
 */

import type { Task } from './types';

/** Any lookup of tasks by id — the store's record, or a Map from a query. */
export interface TaskLookup {
  get(id: string): Task | undefined;
}

/** A plain id-keyed record, as the client store holds tasks. */
export function lookupOf(tasks: Record<string, Task> | Task[]): TaskLookup {
  const byId = Array.isArray(tasks)
    ? new Map(tasks.map((task) => [task.id, task]))
    : new Map(Object.entries(tasks));
  return { get: (id) => byId.get(id) };
}

/**
 * The incomplete task `task` is waiting on, or null when it is free to be
 * worked on.
 *
 * Null in three cases that are worth naming: no dependency at all; a
 * prerequisite that has been completed; and a prerequisite that no longer
 * exists. The last is not an error — deleting a prerequisite releases its
 * dependents (the column is ON DELETE SET NULL) and a row that has not been
 * refetched yet must not stay stuck on a task that is gone.
 */
export function blockedBy(task: Task, tasks: TaskLookup): Task | null {
  if (task.dependsOn === null) return null;
  const prerequisite = tasks.get(task.dependsOn);
  if (!prerequisite || prerequisite.completedAt !== null) return null;
  return prerequisite;
}

/** Whether the task is waiting on something and so cannot be completed yet. */
export function isGated(task: Task, tasks: TaskLookup): boolean {
  return blockedBy(task, tasks) !== null;
}

/**
 * Whether `candidate` may become `task`'s prerequisite.
 *
 * Three refusals, and the third is the one with teeth. A task cannot wait on
 * itself; it cannot wait on a task from another board, because a dependency
 * whose prerequisite is not in the same list is a gate the user cannot see; and
 * it cannot wait on anything that already waits on it, directly or through a
 * chain, because a cycle is a set of tasks none of which can ever be completed.
 *
 * The walk is bounded by the chain it follows and guards against a cycle that
 * is already in the data, so bad state makes this return false rather than
 * hang.
 */
export function canDependOn(task: Task, candidate: Task, tasks: TaskLookup): boolean {
  if (candidate.id === task.id) return false;
  if (candidate.boardId !== task.boardId) return false;

  const seen = new Set<string>([candidate.id]);
  let current: Task | undefined = candidate;
  while (current?.dependsOn) {
    if (current.dependsOn === task.id) return false;
    if (seen.has(current.dependsOn)) return false;
    seen.add(current.dependsOn);
    current = tasks.get(current.dependsOn);
  }
  return true;
}

/**
 * Every task that could legally become `task`'s prerequisite, in the order the
 * caller supplied.
 *
 * Completed tasks are included on purpose: depending on something already done
 * is legal and simply gates nothing, and excluding them would make the option
 * list change under the user the moment they finished something.
 */
export function dependencyOptions(task: Task, candidates: Task[], tasks: TaskLookup): Task[] {
  return candidates.filter((candidate) => canDependOn(task, candidate, tasks));
}
