/**
 * Centered modal. PROJECT-SPEC.md §8.4, §8.5.
 *
 * Modals are the one exception to the transform-origin rule: popovers and menus
 * scale from their trigger, a modal scales from its own center. It starts at
 * 0.96 rather than 0 — nothing in this app appears from nothing.
 */

import { AnimatePresence, motion } from 'motion/react';
import { useRef, type ReactNode } from 'react';
import { useOverlay } from './overlay';
import { keyboardMotionActive, OUT } from '../../lib/motion';

export interface ModalProps {
  open: boolean;
  onClose(): void;
  title: string;
  /** Rendered as the heading; omit to label the dialog without showing it. */
  showTitle?: boolean;
  children: ReactNode;
  /** See `useOverlay`. Default true. */
  autoFocus?: boolean;
}

export function Modal({ open, onClose, title, showTitle = true, children, autoFocus = true }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, panel, autoFocus);
  const keyboard = keyboardMotionActive();

  return (
    <AnimatePresence custom={keyboard}>
      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center px-gutter">
          <motion.div
            className="absolute inset-0 bg-scrim"
            onClick={onClose}
            custom={keyboard}
            variants={{
              closed: (instant: boolean) => ({
                opacity: 0,
                transition: instant ? { duration: 0 } : { duration: 0.2, ease: OUT },
              }),
              open: (instant: boolean) => ({
                opacity: 1,
                transition: instant ? { duration: 0 } : { duration: 0.2, ease: OUT },
              }),
            }}
            initial="closed"
            animate="open"
            exit="closed"
          />

          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            className="relative w-full bg-surface p-6"
            style={{
              maxWidth: '28rem',
              maxHeight: '85dvh',
              overflowY: 'auto',
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-lg)',
            }}
            custom={keyboard}
            variants={{
              closed: (instant: boolean) => ({
                opacity: 0,
                scale: 0.96,
                transition: instant ? { duration: 0 } : { duration: 0.22, ease: OUT },
              }),
              open: (instant: boolean) => ({
                opacity: 1,
                scale: 1,
                transition: instant ? { duration: 0 } : { duration: 0.22, ease: OUT },
              }),
            }}
            initial="closed"
            animate="open"
            exit="closed"
          >
            {showTitle && (
              <h2 className="mb-4 text-board-title text-text">{title}</h2>
            )}
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
