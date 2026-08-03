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
  useStore,
  type NewTask,
} from './store';
import { toast } from './toasts';
import type { Context, Task } from '../../shared/types';
import { createBoardSpec } from './store';

/**
 * Complete or un-complete a task.
 *
 * The animated travel into the Completed group is issue 6; what happens here is
 * the state change, and the row re-renders in its new group.
 */
export function toggleComplete(task: Task): void {
  const store = useStore.getState();
  const completing = task.completedAt === null;

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
export function addBoard(context: Context, name: string, description: string | null): void {
  const store = useStore.getState();
  void store.mutate(
    createBoardSpec({
      context,
      name,
      description,
      position: endOfContext(store, context),
    }),
  );
}

/** Every task of a board, active and completed — what a delete destroys. */
export function tasksOfBoard(boardId: string): Task[] {
  return Object.values(useStore.getState().tasks).filter((task) => task.boardId === boardId);
}
