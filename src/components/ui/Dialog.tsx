/**
 * "Bottom sheet on narrow, centered modal on wide" — the shape the composer,
 * the board editor, and the move picker all take. PROJECT-SPEC.md §8.4, §9.5.
 *
 * Both underlying primitives already exist; what they lacked was the one
 * decision about which of them a given viewport gets, and that decision has to
 * be identical everywhere or the app has two personalities at 767px and 769px.
 *
 * The title is rendered by `DialogHeader` rather than by the primitive, because
 * the composer's header carries the explicit top-left close (§9.5) and a
 * heading dropped in above it would be a second, competing title.
 */

import type { ReactNode } from 'react';
import { X } from '@phosphor-icons/react';
import { Modal } from './Modal';
import { Sheet, useIsWide } from './Sheet';

export interface DialogProps {
  open: boolean;
  onClose(): void;
  /** Names the dialog for assistive tech. Rendered by `DialogHeader`. */
  title: string;
  children: ReactNode;
}

export function Dialog({ open, onClose, title, children }: DialogProps) {
  const wide = useIsWide();

  return wide ? (
    <Modal open={open} onClose={onClose} title={title} showTitle={false}>
      {children}
    </Modal>
  ) : (
    <Sheet open={open} onClose={onClose} title={title}>
      {children}
    </Sheet>
  );
}

export interface DialogHeaderProps {
  title: string;
  /** The explicit close, top-left (§9.5). Omitted where cancel does the job. */
  onClose?(): void;
}

export function DialogHeader({ title, onClose }: DialogHeaderProps) {
  return (
    <div className="mb-4 flex items-center gap-2 pt-2">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="pressable -ml-2 flex shrink-0 items-center justify-center rounded-chip
                     text-text-secondary"
          style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
        >
          <X size={20} />
        </button>
      )}
      <h2 className="min-w-0 flex-1 truncate text-board-title text-text">{title}</h2>
    </div>
  );
}
