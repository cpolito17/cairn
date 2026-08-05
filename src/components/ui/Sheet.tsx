/**
 * Bottom sheet. PROJECT-SPEC.md §8.4 (24px top corners, centered grabber, over
 * the scrim), §8.5 (drawer curve, enters from the bottom edge and dismisses
 * downward — the way it came).
 *
 * `useIsWide` is exported here because the composer is a sheet on narrow
 * viewports and a modal on wide ones (§8.4); the screen picks, the primitives
 * stay dumb.
 */

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DRAWER, keyboardMotionActive, SHEET_SPRING } from '../../lib/motion';
import { useOverlay } from './overlay';

/** Past this the drag is a dismissal. */
const DISMISS_DISTANCE = 96;
const DISMISS_VELOCITY = 500;

/** True at the wide breakpoint the type scale and gutters already use. */
export function useIsWide(): boolean {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)');
    const listener = (event: MediaQueryListEvent) => setWide(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  return wide;
}

export interface SheetProps {
  open: boolean;
  onClose(): void;
  /** Names the dialog for assistive tech; rendered as the sheet's heading. */
  title: string;
  children: ReactNode;
}

export function Sheet({ open, onClose, title, children }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlay(open, onClose, panel);
  const keyboard = keyboardMotionActive();

  return (
    <AnimatePresence custom={keyboard}>
      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center">
          <motion.div
            className="absolute inset-0 bg-scrim"
            onClick={onClose}
            custom={keyboard}
            variants={{
              closed: (instant: boolean) => ({
                opacity: 0,
                transition: instant ? { duration: 0 } : { duration: 0.2, ease: DRAWER },
              }),
              open: (instant: boolean) => ({
                opacity: 1,
                transition: instant ? { duration: 0 } : { duration: 0.2, ease: DRAWER },
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
            className="relative w-full bg-surface"
            style={{
              maxWidth: '32rem',
              maxHeight: '90dvh',
              borderTopLeftRadius: 'var(--radius-sheet)',
              borderTopRightRadius: 'var(--radius-sheet)',
              paddingBottom: 'env(safe-area-inset-bottom)',
              boxShadow: 'var(--shadow-lg)',
            }}
            custom={keyboard}
            variants={{
              closed: (instant: boolean) => ({
                y: '100%',
                transition: instant ? { duration: 0 } : SHEET_SPRING,
              }),
              open: (instant: boolean) => ({
                y: 0,
                transition: instant ? { duration: 0 } : SHEET_SPRING,
              }),
            }}
            initial="closed"
            animate="open"
            exit="closed"
            // §8.5: springs, not durations, for anything touchable mid-flight —
            // and this panel is dragged. A fixed tween cannot take the flick's
            // velocity, so a sheet thrown downward used to stop dead and then
            // restart at a stranger's pace; the spring is continuous with the
            // gesture. Sheet spring is 0.8 damping / 0.3 response.
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > DISMISS_DISTANCE || info.velocity.y > DISMISS_VELOCITY) {
                onClose();
              }
            }}
          >
            <div className="flex justify-center pt-3 pb-1">
              <span
                aria-hidden="true"
                className="block rounded-pill bg-hairline"
                style={{ width: '36px', height: '4px' }}
              />
            </div>
            <div className="overflow-y-auto px-gutter pb-6" style={{ maxHeight: '80dvh' }}>
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
