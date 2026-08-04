/**
 * Toasts. PROJECT-SPEC.md §8.4 (Toasts), §8.5 (spatial consistency).
 *
 * Full-width cards at 12px radius, a leading semantic glyph in a circular chip,
 * one line, a trailing dismiss. They enter and leave by the bottom edge — the
 * same edge, because a card that arrives from below and vanishes upward reads
 * as two different objects — and swipe-to-dismiss runs along that same axis.
 *
 * Stacking is a real stack: the newest card is the front, its predecessors are
 * offset and scaled behind it rather than listed above it. Lifetimes, including
 * the pause while the tab is hidden, are owned by `lib/toasts.ts`.
 */

import { ArrowClockwise, CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { UI_SPRING } from '../../lib/motion';
import { useToasts, type Toast, type ToastTone } from '../../lib/toasts';

/** How far each card behind the front one is offset and shrunk. */
const STACK_OFFSET = 10;
const STACK_SCALE = 0.05;

/** Past this the swipe is a dismissal rather than a fidget. */
const DISMISS_DISTANCE = 56;
const DISMISS_VELOCITY = 400;

const GLYPHS: Record<ToastTone, typeof Info> = {
  error: WarningCircle,
  success: CheckCircle,
  info: Info,
};

const TONE_COLOR: Record<ToastTone, string> = {
  error: 'var(--negative)',
  success: 'var(--positive)',
  info: 'var(--text-secondary)',
};

export function Toaster() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);

  return (
    <div
      // A live region so a rollback is announced, not just drawn.
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-gutter"
      style={{ paddingBottom: 'calc(var(--space-4) + env(safe-area-inset-bottom))' }}
    >
      <div className="relative w-full" style={{ maxWidth: '32rem', height: '56px' }}>
        <AnimatePresence initial={false}>
          {toasts.map((toast, index) => (
            <ToastCard
              key={toast.id}
              toast={toast}
              depth={toasts.length - 1 - index}
              onDismiss={() => dismiss(toast.id)}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ToastCard({
  toast,
  depth,
  onDismiss,
}: {
  toast: Toast;
  depth: number;
  onDismiss: () => void;
}) {
  const Glyph = GLYPHS[toast.tone];
  const front = depth === 0;

  return (
    <motion.div
      className="pointer-events-auto absolute inset-x-0 bottom-0 flex items-center gap-3
                 rounded-control bg-surface px-4 shadow-md"
      style={{
        minHeight: '56px',
        border: 'var(--hairline-width) solid var(--hairline)',
        zIndex: 10 - depth,
        // The stack grows upward, so the cards behind pivot from their bottom
        // edge and stay pinned to the front card's baseline.
        transformOrigin: 'bottom center',
      }}
      initial={{ y: 24, opacity: 0, scale: 1 }}
      animate={{
        y: -depth * STACK_OFFSET,
        scale: 1 - depth * STACK_SCALE,
        // Anything deeper than the third card is not visible anyway.
        opacity: depth > 2 ? 0 : 1,
      }}
      exit={{ y: 24, opacity: 0 }}
      // A toast is swiped, so it springs rather than tweening (§8.5) — and it
      // is the default UI spring, 1.0 damping / 0.3 response, stated in
      // `visualDuration` so 0.3 means the response §8.5 names and not the
      // spring's total settle time, which is what plain `duration` would set.
      transition={UI_SPRING}
      drag={front ? 'y' : false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.7 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > DISMISS_DISTANCE || info.velocity.y > DISMISS_VELOCITY) onDismiss();
      }}
    >
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center rounded-pill"
        style={{
          width: '28px',
          height: '28px',
          background: `color-mix(in srgb, ${TONE_COLOR[toast.tone]} 14%, var(--surface-2))`,
          color: TONE_COLOR[toast.tone],
        }}
      >
        <Glyph size={18} weight="regular" />
      </span>

      <p className="min-w-0 flex-1 truncate text-body text-text">{toast.message}</p>

      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
          className="pressable flex shrink-0 items-center gap-1 rounded-chip px-2 py-1 text-meta
                     text-accent"
          style={{ fontWeight: 600, minHeight: '32px' }}
        >
          <ArrowClockwise size={16} />
          {toast.action.label}
        </button>
      )}

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="pressable flex shrink-0 items-center justify-center rounded-chip
                   text-text-tertiary"
        style={{ width: '32px', height: '32px' }}
      >
        <X size={16} />
      </button>
    </motion.div>
  );
}
