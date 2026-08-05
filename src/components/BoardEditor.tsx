/**
 * The board editor. PROJECT-SPEC.md §9.6, §6.3.
 *
 * One compact surface for three jobs — create, rename, edit description —
 * because they are the same fields and splitting them into separate dialogs
 * would mean a user who opened "rename" and then wanted to fix the description
 * has to cancel and start again.
 *
 * `focusField` is what the overflow menu's two entries actually differ by: both
 * open this, one with the caret in the name and one in the description.
 */

import { useEffect, useRef, useState } from 'react';
import { addBoard } from '../lib/actions';
import { BOARD_ACCENT_CHOICES, boardAccentColor } from '../lib/boardAccent';
import { hasFinePointer } from '../lib/motion';
import { updateBoardSpec, useStore } from '../lib/store';
import type { Board, BoardAccent, Context } from '../../shared/types';
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
  const [accent, setAccent] = useState<BoardAccent | null>(board?.accent ?? null);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Re-seed on open: the dialog stays mounted between openings, so without this
  // a cancelled rename would still be sitting in the field next time.
  useEffect(() => {
    if (!open) return;
    setName(board?.name ?? '');
    setDescription(board?.description ?? '');
    setAccent(board?.accent ?? null);
    setError(null);
    // Touch is left alone — tap to edit, same as the task composer, and for
    // the same reason: focusing immediately here pops the keyboard before the
    // sheet has finished its enter transform, and that race is what dragged
    // the page's scroll off to the wrong place.
    if (!hasFinePointer()) return;
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
          accent,
        }),
      );
    } else {
      addBoard(context, trimmed, trimmedDescription === '' ? null : trimmedDescription, accent);
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

        <fieldset className="mt-5">
          <legend className="mb-2 text-section text-text-secondary">Accent</legend>
          <div className="grid grid-cols-6 gap-1 sm:grid-cols-11">
            {BOARD_ACCENT_CHOICES.map((choice) => {
              const selected = accent === choice.value;
              return (
                <button
                  key={choice.value ?? 'theme'}
                  type="button"
                  aria-label={choice.label}
                  aria-pressed={selected}
                  title={choice.label}
                  onClick={() => setAccent(choice.value)}
                  className="pressable flex items-center justify-center rounded-control"
                  style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
                >
                  <span
                    aria-hidden="true"
                    className="block rounded-pill"
                    style={{
                      width: '24px',
                      height: '24px',
                      backgroundColor: boardAccentColor(choice.value),
                      boxShadow: selected
                        ? '0 0 0 2px var(--surface), 0 0 0 4px var(--accent)'
                        : '0 0 0 1px var(--hairline)',
                    }}
                  />
                </button>
              );
            })}
          </div>
        </fieldset>

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
