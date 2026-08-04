/**
 * Section headers and the collapsible region beneath them.
 * PROJECT-SPEC.md §8.3 (13px uppercase, 600, +0.02em), §8.5 (the Completed
 * group collapses and expands via height and opacity together).
 *
 * The collapse animates `height: auto` through motion's layout height rather
 * than a CSS transition, because a CSS transition cannot go to `auto` and the
 * usual workaround — a hard-coded max-height — either clips a long list or
 * spends most of the animation collapsing empty space. Height is a layout
 * property and §8.5 is otherwise strict about transform and opacity; this is
 * the one place the spec asks for height by name, and it is a once-in-a-while
 * interaction on a bounded list rather than a per-frame concern.
 */

import { AnimatePresence, motion } from 'motion/react';
import { CaretDown } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { OUT } from '../../lib/motion';

export interface SectionHeaderProps {
  children: ReactNode;
  /** Present only when the section collapses. */
  collapsed?: boolean;
  onToggle?(): void;
  /** Identifies the region this header controls, for `aria-controls`. */
  regionId?: string;
  /** A trailing tertiary action, e.g. "New board". */
  action?: ReactNode;
}

export function SectionHeader({
  children,
  collapsed,
  onToggle,
  regionId,
  action,
}: SectionHeaderProps) {
  const label = (
    <span
      className="text-section text-text-secondary"
      style={{ textTransform: 'uppercase' }}
    >
      {children}
    </span>
  );

  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={regionId}
          className="pressable -ml-2 flex items-center gap-2 rounded-chip px-2"
          style={{ minHeight: 'var(--tap-target)' }}
        >
          {label}
          <CaretDown
            size={16}
            className="text-text-tertiary"
            style={{
              transform: collapsed ? 'rotate(-90deg)' : 'none',
              transition: 'transform 200ms var(--ease-out)',
            }}
          />
        </button>
      ) : (
        <span className="flex items-center" style={{ minHeight: 'var(--tap-target)' }}>
          {label}
        </span>
      )}
      {action}
    </div>
  );
}

export function Collapsible({
  id,
  collapsed,
  children,
}: {
  id: string;
  collapsed: boolean;
  children: ReactNode;
}) {
  // The clip is only wanted while the height is moving. Left on permanently it
  // would cut the top off a task row travelling down into the Completed group,
  // which is exactly the disappear-and-reappear §8.5 forbids.
  const [clipping, setClipping] = useState(false);

  return (
    <AnimatePresence initial={false}>
      {!collapsed && (
        <motion.div
          id={id}
          style={{ overflow: clipping ? 'hidden' : 'visible' }}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.24, ease: OUT }}
          onAnimationStart={() => setClipping(true)}
          onAnimationComplete={() => setClipping(false)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The app's empty state: one quiet typographic line. No illustration, no
 * emoji, no call to action unless the caller passes a real one (§8.4, §9.3).
 */
export function EmptyLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="py-8">
      <p className="text-body text-text-secondary">{children}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

/** The app's error state: plain language about what happened, plus a retry. */
export function ErrorLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="py-8">
      <p className="text-body text-text-secondary">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * What a failed load says, given why it failed.
 *
 * One sentence naming what did not load, one naming the likely cause. The
 * second sentence is the whole point of the split: telling someone whose
 * connection is fine that their connection dropped sends them to debug the
 * wrong thing, which is exactly what happened when a Worker started answering
 * 500s and every screen blamed the network.
 */
export function loadErrorMessage(
  subject: string,
  failure: 'offline' | 'server' | null,
): string {
  return failure === 'server'
    ? `Couldn’t load ${subject}. The server responded with an error — this is not your connection.`
    : `Couldn’t load ${subject}. The connection may have dropped.`;
}
