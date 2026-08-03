/**
 * The delete confirmation. PROJECT-SPEC.md §9.7, §8.4, §6.3.
 *
 * The only destructive action in the app, so it is the one surface that gets a
 * modal in the user's way. It names the thing explicitly and, for a board,
 * states how many tasks go with it — "Delete board?" without that number is a
 * question the user cannot actually answer.
 *
 * The primary carries the specific verb and is destructive-styled; "Cancel"
 * always sits beside it, de-emphasized. Never "OK".
 */

import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

export interface DeleteConfirmProps {
  open: boolean;
  onClose(): void;
  onConfirm(): void;
  /** "board" or "task" — drives both the verb and the copy. */
  kind: 'board' | 'task';
  name: string;
  /** Boards only: how many tasks the delete destroys. */
  taskCount?: number;
}

export function DeleteConfirm({
  open,
  onClose,
  onConfirm,
  kind,
  name,
  taskCount = 0,
}: DeleteConfirmProps) {
  const verb = kind === 'board' ? 'Delete board' : 'Delete task';

  return (
    <Modal open={open} onClose={onClose} title={verb} showTitle={false}>
      <h2 className="text-board-title text-text">{verb}?</h2>
      <p className="mt-3 text-body text-text-secondary">
        {kind === 'board' ? (
          <>
            &ldquo;{name}&rdquo; and its {taskCount} {taskCount === 1 ? 'task' : 'tasks'} will
            be deleted permanently.
          </>
        ) : (
          <>&ldquo;{name}&rdquo; will be deleted permanently.</>
        )}
      </p>

      <div className="mt-6 flex items-center justify-end gap-2">
        <Button
          variant="tertiary"
          onClick={onClose}
          style={{ color: 'var(--text-secondary)' }}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            onConfirm();
            onClose();
          }}
          style={{ backgroundColor: 'color-mix(in srgb, var(--negative) 14%, transparent)' }}
        >
          {verb}
        </Button>
      </div>
    </Modal>
  );
}
