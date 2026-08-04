/**
 * Quick add. PROJECT-SPEC.md §6.4, §9.4.
 *
 * One button, one destination: adding a task always opens the composer, so the
 * name and everything else — notes, due date, duration, difficulty, priority —
 * are set in the same place every time. The inline field this replaced could
 * only ever produce a bare name, which made "add a task" mean two different
 * things depending on which control the user happened to reach for.
 *
 * The row is sticky to the bottom of the scroll area so it stays reachable on a
 * long board.
 */

import { Plus } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';

export interface QuickAddProps {
  /** Opens the composer. There is no draft to carry any more — it starts empty. */
  onOpen(): void;
  /** An empty board focuses its add control on arrival (§9.4). */
  autoFocus?: boolean;
}

export function QuickAdd({ onOpen, autoFocus = false }: QuickAddProps) {
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (autoFocus) button.current?.focus();
    // Only on arrival at an empty board — re-focusing whenever the board's
    // emptiness changes would steal focus back out of the composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="sticky bottom-0 z-10 -mx-gutter mt-2 px-gutter pt-2 pb-2"
      style={{
        background:
          'linear-gradient(to bottom, transparent, var(--bg) 40%, var(--bg))',
        paddingBottom: 'calc(var(--space-2) + env(safe-area-inset-bottom))',
      }}
    >
      <button
        ref={button}
        type="button"
        onClick={onOpen}
        className="pressable hoverable flex w-full items-center gap-2 rounded-control
                   bg-surface-2 px-3 text-left text-row text-text-secondary"
        style={{ minHeight: 'var(--tap-target)' }}
      >
        <Plus size={20} />
        Add a task
      </button>
    </div>
  );
}
