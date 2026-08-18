/**
 * The task and board actions the screens share, written once.
 *
 * Completion happens from two places — a task row on a board and an Up Next
 * entry (§6.7) — and both have to produce exactly the same result: the same
 * mutation spec, the same end-of-list position on un-completion (§7.3), and the
 * same brief undo affordance (§6.5). Two call sites that each assemble that
 * themselves is how they drift.
 *
 * Everything here goes through `mutate()`. Nothing calls `fetch`, and nothing
 * writes entity state directly.
 */

import {
  completeTaskSpec,
  createTaskSpec,
  endOfBoard,
  endOfContext,
  positionBetween,
  reorderBoardSpec,
  reorderTaskSpec,
  updateTaskSpec,
  useStore,
  type NewTask,
} from './store';
import { toast } from './toasts';
import {
  blockedBy,
  lookupOf,
  planLink,
  planRetarget,
  planSplice,
  planUnlink,
  type DependencyEdit,
} from '../../shared/dependencies';
import type { Board, BoardAccent, Context, Task } from '../../shared/types';
import { createBoardSpec } from './store';

/**
 * Complete or un-complete a task.
 *
 * The row's travel into the Completed group is a consequence of this, not a
 * step in it: the state change moves the row between two lists, and
 * `lib/flip.ts` turns that layout change into one continuous movement (§8.5).
 */
export function toggleComplete(task: Task): void {
  const store = useStore.getState();
  const completing = task.completedAt === null;

  // The dependency gate. Every completion path routes through here, so this is
  // the one place it has to hold — and the Worker refuses the same write with a
  // 409, so a stale client cannot get around it either.
  if (completing) {
    const waiting = blockedBy(task, lookupOf(store.tasks));
    if (waiting.length > 0) {
      // One name plus a count, rather than a list: a toast with four task names
      // in it is a toast nobody reads, and the composer is where the whole set
      // is visible anyway.
      const others = waiting.length - 1;
      const rest = others === 0 ? '' : ` and ${others} other task${others === 1 ? '' : 's'}`;
      toast.info(`"${task.name}" is waiting on "${waiting[0].name}"${rest}.`);
      return;
    }
  }

  // An un-completed task goes to the *end* of the active list, deliberately —
  // restoring its old position reshuffles the list under the user's hands
  // (§6.5). The position is computed before the mutation applies.
  const position = completing ? undefined : endOfBoard(store, task.boardId);

  void store.mutate(completeTaskSpec(task, completing, position)).then((committed) => {
    if (!committed || !completing) return;
    // §6.5: an undo affordance appears briefly. It undoes through the same
    // path, so the restored task lands at the end of the active list too.
    toast.info(`Completed "${task.name}"`, {
      label: 'Undo',
      run: () => {
        const current = useStore.getState();
        const live = current.tasks[task.id];
        if (!live || live.completedAt === null) return;
        void current.mutate(
          completeTaskSpec(live, false, endOfBoard(current, live.boardId)),
        );
      },
    });
  });
}

/** Create a task at the end of a board's active list (§7.3). */
export function addTask(draft: Omit<NewTask, 'position'>): void {
  const store = useStore.getState();
  void store.mutate(
    createTaskSpec({ ...draft, position: endOfBoard(store, draft.boardId) }),
  );
}

/** Create a board at the end of a context's list (§6.3). */
export function addBoard(
  context: Context,
  name: string,
  description: string | null,
  accent: BoardAccent | null,
): void {
  const store = useStore.getState();
  void store.mutate(
    createBoardSpec({
      context,
      name,
      description,
      accent,
      position: endOfContext(store, context),
    }),
  );
}

/**
 * The position for a row dropped between two neighbours (§7.3).
 *
 * `midpoint` refuses neighbours that are out of order, which two devices can
 * produce: the read order breaks ties on `id`, so a list can legitimately hold
 * two rows with the same position string, and asking for a value strictly
 * between them is unanswerable. Falling back to one open side keeps the drop
 * where the user aimed it rather than dropping the gesture on the floor.
 */
function positionFor(before: Task | Board | null, after: Task | Board | null): string {
  try {
    return positionBetween(before?.position ?? null, after?.position ?? null);
  } catch {
    return before ? positionBetween(before.position, null) : positionBetween(null, null);
  }
}

/**
 * Persist a drag within a board's active list. Optimistic, on release, and
 * rolled back visibly by `mutate()` if the write fails (§7.3) — the rollback is
 * another commit, so the row *animates* home rather than snapping.
 */
export function reorderTask(task: Task, before: Task | null, after: Task | null): void {
  void useStore.getState().mutate(reorderTaskSpec(task, positionFor(before, after)));
}

/** The same, for a board card on the context home (§6.6). */
export function reorderBoard(board: Board, before: Board | null, after: Board | null): void {
  void useStore.getState().mutate(reorderBoardSpec(board, positionFor(before, after)));
}

/**
 * The dependency edits the Blockers page makes by drag.
 *
 * Each one plans against the live store with the shared rules, refuses in a
 * toast when the plan comes back null, and writes through `mutate()` like every
 * other change. Nothing here re-implements a rule: `shared/dependencies.ts`
 * decides what is legal, the Worker re-checks it, and this is the wiring
 * between the gesture and the write.
 */
function applyEdits(edits: DependencyEdit[]): void {
  const store = useStore.getState();
  for (const edit of edits) {
    const task = store.tasks[edit.taskId];
    if (task) void store.mutate(updateTaskSpec(task, { dependsOn: edit.dependsOn }));
  }
}

/** `task` waits on `prerequisiteId`. */
export function linkDependency(task: Task, prerequisiteId: string): void {
  const store = useStore.getState();
  const prerequisite = store.tasks[prerequisiteId];
  if (!prerequisite) return;

  const edit = planLink(task, prerequisite, lookupOf(store.tasks));
  if (!edit) {
    toast.info(refusal(task, prerequisite));
    return;
  }
  applyEdits([edit]);
}

/** `task` stops waiting on `prerequisiteId`. Silent when there was no link. */
export function unlinkDependency(task: Task, prerequisiteId: string): void {
  const edit = planUnlink(task, prerequisiteId);
  if (edit) applyEdits([edit]);
}

/** An existing edge moved onto a different prerequisite. */
export function retargetDependency(task: Task, fromId: string, toPrerequisiteId: string): void {
  const store = useStore.getState();
  const toPrerequisite = store.tasks[toPrerequisiteId];
  if (!toPrerequisite) return;

  const edit = planRetarget(task, fromId, toPrerequisite, lookupOf(store.tasks));
  if (!edit) {
    toast.info(refusal(task, toPrerequisite));
    return;
  }
  applyEdits([edit]);
}

/**
 * `task` spliced into the edge `fromId → toId`, becoming `from → task → to`.
 *
 * Two writes, because it is two tasks that change. They go through `mutate()`
 * separately and so can in principle fail separately — the honest cost of a
 * store whose unit of work is one task. A half-applied splice leaves the task
 * waiting on `from` with `to` unchanged, which is a legal graph and a visible
 * one, rather than anything corrupt.
 */
export function spliceIntoEdge(task: Task, fromId: string, toId: string): void {
  const store = useStore.getState();
  const to = store.tasks[toId];
  if (!to) return;

  const edits = planSplice(task, fromId, to, lookupOf(store.tasks));
  if (!edits) {
    toast.info(`"${task.name}" cannot go here — it would create a loop.`);
    return;
  }
  applyEdits(edits);
}

/**
 * Why a link was refused, in the terms the user was working in.
 *
 * `canDependOn`'s four refusals collapse to two the user can act on: the same
 * board rule, and everything else that would make a loop. A duplicate link and
 * a self-link are both already impossible to express by drag, so neither gets a
 * sentence it would never show.
 */
function refusal(task: Task, prerequisite: Task): string {
  return prerequisite.boardId !== task.boardId
    ? 'Tasks can only wait on tasks from the same board.'
    : `"${task.name}" cannot wait on "${prerequisite.name}" — it would create a loop.`;
}

/** Mark a task blocked, or release it. The Overdue Audit's middle action. */
export function setBlocked(task: Task, blocked: boolean): void {
  const store = useStore.getState();
  void store.mutate(updateTaskSpec(task, { blocked }));
}

/** Move a task's due date. The Overdue Audit's first action. */
export function setDueDate(task: Task, dueDate: string | null): void {
  const store = useStore.getState();
  // Clearing the date clears the time with it: a time without a date is not a
  // moment, and §6.4 only offers one once the other is set.
  void store.mutate(
    updateTaskSpec(task, dueDate === null ? { dueDate: null, dueTime: null } : { dueDate }),
  );
}

/** Every task of a board, active and completed — what a delete destroys. */
export function tasksOfBoard(boardId: string): Task[] {
  return Object.values(useStore.getState().tasks).filter((task) => task.boardId === boardId);
}
