/**
 * The board editor. PROJECT-SPEC.md §9.6, §6.3.
 *
 * One compact surface for three jobs — create, rename, edit description —
 * because they are the same two fields and splitting them into separate dialogs
 * would mean a user who opened "rename" and then wanted to fix the description
 * has to cancel and start again.
 *
 * `focusField` is what the overflow menu's two entries actually differ by: both
 * open this, one with the caret in the name and one in the description.
 */

import { useEffect, useRef, useState } from 'react';
import { addBoard } from '../lib/actions';
import { updateBoardSpec, useStore } from '../lib/store';
import type { Board, Context } from '../../shared/types';
import { Button } from './ui/Button';
import { Dialog, DialogHeader } from './ui/Dialog';
import { Input, Textarea } from './ui/Input';

export interface BoardEditorProps {
  open: boolean;
  onClose(): void;
  /** Absent for create mode. */
  board?: Board;
  /** Create mode only: where the new board goes. */
  context: Context;
  focusField?: 'name' | 'description';
}

export function BoardEditor({
  open,
  onClose,
  board,
  context,
  focusField = 'name',
}: BoardEditorProps) {
  const [name, setName] = useState(board?.name ?? '');
  const [description, setDescription] = useState(board?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed on open: the dialog stays mounted between openings, so without this
  // a cancelled rename would still be sitting in the field next time.
  useEffect(() => {
    if (!open) return;
    setName(board?.name ?? '');
    setDescription(board?.description ?? '');
    setError(null);
    const target = focusField === 'description' ? descriptionRef.current : nameRef.current;
    // After the overlay's own focus call, which runs on the same tick.
    const handle = window.setTimeout(() => target?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [open, board, focusField]);

  function save() {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('A board needs a name.');
      nameRef.current?.focus();
      return;
    }

    const trimmedDescription = description.trim();
    if (board) {
      void useStore.getState().mutate(
        updateBoardSpec(board, {
          name: trimmed,
          description: trimmedDescription === '' ? null : trimmedDescription,
        }),
      );
    } else {
      addBoard(context, trimmed, trimmedDescription === '' ? null : trimmedDescription);
    }
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title={board ? 'Edit board' : 'New board'}>
      <DialogHeader title={board ? 'Edit board' : 'New board'} />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Input
          ref={nameRef}
          label="Name"
          value={name}
          maxLength={120}
          error={error}
          onChange={(event) => {
            setName(event.target.value);
            if (error) setError(null);
          }}
          onBlur={() => setError(name.trim() === '' ? 'A board needs a name.' : null)}
        />

        <div className="mt-4">
          <Textarea
            ref={descriptionRef}
            label="Description"
            rows={2}
            value={description}
            maxLength={200}
            placeholder="Optional"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            variant="tertiary"
            onClick={onClose}
            style={{ color: 'var(--text-secondary)' }}
          >
            Cancel
          </Button>
          <Button type="submit">{board ? 'Save' : 'Create board'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
