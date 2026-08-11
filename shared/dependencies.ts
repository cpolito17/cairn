/**
 * Task dependencies — the rules, in one place.
 *
 * A task may wait on any number of other tasks on the same board. While *any*
 * of those prerequisites is incomplete the dependent is *gated*: it reads as
 * unavailable and it cannot be completed. Completing a prerequisite releases
 * everything that was waiting only on it, with no second write — the gate is
 * derived, never stored, so there is no denormalized flag to fall out of step
 * with the thing it describes.
 *
 * The client and the Worker share this file so they cannot disagree about what
 * a legal link is: the composer offers exactly the options `canDependOn` allows,
 * and the Worker re-checks with the same function on untrusted input.
 *
 * **All-of, not any-of.** A task with three prerequisites waits for all three.
 * There is no "any one of these releases it" — that would be a second kind of
 * edge, and a graph whose edges mean two different things is one nobody can
 * read at a glance.
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
 * The incomplete tasks `task` is waiting on, in its own link order. Empty when
 * it is free to be worked on.
 *
 * Two kinds of link are skipped, and both are ordinary rather than errors: a
 * prerequisite that has been completed, and one that no longer exists.
 * Deleting a prerequisite releases its dependents (the join table cascades) and
 * a client that has not refetched yet must not stay stuck on a task that is
 * gone.
 */
export function blockedBy(task: Task, tasks: TaskLookup): Task[] {
  const waiting: Task[] = [];
  for (const id of task.dependsOn) {
    const prerequisite = tasks.get(id);
    if (prerequisite && prerequisite.completedAt === null) waiting.push(prerequisite);
  }
  return waiting;
}

/**
 * The one prerequisite worth naming in a sentence, or null.
 *
 * A refusal has to say *something* specific — "Waiting on Lock the doors" — and
 * a message that listed four task names would not fit the surfaces that show
 * it. The first outstanding prerequisite is the honest choice: it is the one
 * that has been waiting longest, and `blockedByCount` is there for callers that
 * want to say how many others there are.
 */
export function firstBlocker(task: Task, tasks: TaskLookup): Task | null {
  return blockedBy(task, tasks)[0] ?? null;
}

/** How many incomplete prerequisites stand in this task's way. */
export function blockedByCount(task: Task, tasks: TaskLookup): number {
  return blockedBy(task, tasks).length;
}

/** Whether the task is waiting on something and so cannot be completed yet. */
export function isGated(task: Task, tasks: TaskLookup): boolean {
  return blockedBy(task, tasks).length > 0;
}

/**
 * Whether `candidate` may become one of `task`'s prerequisites.
 *
 * Four refusals, and the last is the one with teeth:
 *
 *   1. a task cannot wait on itself;
 *   2. it cannot wait on a task from another board, because a gate whose cause
 *      is not in the same list is one the user cannot see;
 *   3. it cannot wait on the same task twice — already a link, not a new one;
 *   4. it cannot wait on anything that already waits on it, directly or through
 *      any chain, because a cycle is a set of tasks none of which can ever be
 *      completed.
 *
 * The cycle check is the part that changed when a task gained more than one
 * prerequisite. Following a single link was a walk up a chain; following a set
 * is a search of a graph, because the candidate may reach `task` through any of
 * several paths and a walk that followed only the first would miss the one that
 * closes the loop.
 *
 * It is a depth-first walk of everything `candidate` transitively waits on, and
 * the three-state colouring is what makes it both correct and linear:
 *
 *   * reaching `task` means the new edge would close a loop — refuse;
 *   * reaching a node **still on the stack** means the data already contains a
 *     cycle upstream of the candidate. Joining a chain that loops would gate
 *     the new task forever, so that is refused too — the same answer the old
 *     chain walk gave, for the same reason;
 *   * reaching a node already **finished** is a diamond, not a cycle: two paths
 *     arriving at one shared ancestor is the ordinary shape of the feature, and
 *     skipping it is also what keeps a wide graph from being walked once per
 *     path.
 *
 * A plain visited-set cannot tell the second case from the third, which is why
 * there are three states here and not two.
 */
export function canDependOn(task: Task, candidate: Task, tasks: TaskLookup): boolean {
  if (candidate.id === task.id) return false;
  if (candidate.boardId !== task.boardId) return false;
  if (task.dependsOn.includes(candidate.id)) return false;

  const ON_STACK = 1;
  const FINISHED = 2;
  const state = new Map<string, number>([[candidate.id, ON_STACK]]);
  // An explicit stack rather than recursion: depth is the length of a
  // dependency chain, which nothing in the app bounds.
  const frames: { deps: readonly string[]; next: number; id: string }[] = [
    { id: candidate.id, deps: candidate.dependsOn, next: 0 },
  ];

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];

    if (frame.next >= frame.deps.length) {
      state.set(frame.id, FINISHED);
      frames.pop();
      continue;
    }

    const id = frame.deps[frame.next];
    frame.next += 1;

    if (id === task.id) return false;

    const colour = state.get(id);
    if (colour === ON_STACK) return false;
    if (colour === FINISHED) continue;

    const next = tasks.get(id);
    if (!next) {
      // A link to a task that is gone gates nothing and leads nowhere.
      state.set(id, FINISHED);
      continue;
    }
    state.set(id, ON_STACK);
    frames.push({ id, deps: next.dependsOn, next: 0 });
  }

  return true;
}

/**
 * Every task that could legally become one of `task`'s prerequisites, in the
 * order the caller supplied.
 *
 * Completed tasks are included on purpose: depending on something already done
 * is legal and simply gates nothing, and excluding them would make the option
 * list change under the user the moment they finished something.
 */
export function dependencyOptions(task: Task, candidates: Task[], tasks: TaskLookup): Task[] {
  return candidates.filter((candidate) => canDependOn(task, candidate, tasks));
}

/**
 * The compact "waiting on" label for a chip or a checkbox refusal.
 *
 * One name, plus a count of the rest — `Lock the doors +2`. The chip that
 * carries this sits in a row of other chips and next to a task name that may
 * already be 120 characters, so it has room for one name and no more. The full
 * list is `waitingList`, for the surfaces that have the space.
 */
export function waitingSummary(waiting: readonly Task[]): string | null {
  if (waiting.length === 0) return null;
  const rest = waiting.length - 1;
  return rest === 0 ? waiting[0].name : `${waiting[0].name} +${rest}`;
}

/**
 * Every name, written out: `A`, `A and B`, `A, B and C`.
 *
 * For the hover detail card, which is the one place that has room to say all of
 * it and the one place a user goes specifically to ask "so what *is* this
 * waiting on".
 */
export function waitingList(waiting: readonly Task[]): string | null {
  const names = waiting.map((task) => task.name);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * `dependsOn` cleaned up: de-duplicated, self-links dropped, order preserved.
 *
 * Used at both boundaries — the composer before it sends, and the Worker before
 * it stores — so neither has to think about a list that arrived with the same
 * id twice.
 */
export function normalizeDependsOn(taskId: string, dependsOn: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of dependsOn) {
    if (id === taskId || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
