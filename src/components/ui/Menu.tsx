/**
 * An overflow menu. PROJECT-SPEC.md §8.5 (popovers scale from 0.96 with their
 * transform origin at the trigger, never at their center), §8.4 (≥44px targets).
 *
 * The board header needs the same menu the app shell already has, so it is a
 * component rather than a second copy of the same 60 lines with different
 * items — including the parts that are easy to leave out of a copy: outside
 * pointer-down closes it, Escape closes it, and the trigger reports its state
 * to assistive tech.
 */

import { DotsThreeVertical } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** §8.5 standard out curve. */
const OUT = [0.23, 1, 0.32, 1] as const;

export interface MenuProps {
  label: string;
  children: (close: () => void) => ReactNode;
}

export function Menu({ label, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((was) => !was)}
        className="pressable flex items-center justify-center rounded-chip text-text-secondary"
        style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
      >
        <DotsThreeVertical size={20} weight="bold" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            className="absolute right-0 z-30 mt-1 overflow-hidden bg-surface py-1"
            style={{
              top: '100%',
              minWidth: '208px',
              borderRadius: 'var(--radius-control)',
              border: 'var(--hairline-width) solid var(--hairline)',
              boxShadow: 'var(--shadow-md)',
              transformOrigin: 'top right',
            }}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.16, ease: OUT }}
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({
  icon,
  onClick,
  destructive = false,
  children,
}: {
  icon?: ReactNode;
  onClick(): void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="pressable hoverable flex w-full items-center gap-3 px-4 text-left text-body"
      style={{
        minHeight: 'var(--tap-target)',
        color: destructive ? 'var(--negative)' : 'var(--text)',
      }}
    >
      {icon && (
        <span style={{ color: destructive ? 'var(--negative)' : 'var(--text-secondary)' }}>
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}
