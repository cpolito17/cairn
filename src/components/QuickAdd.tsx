/**
 * Quick add. PROJECT-SPEC.md §6.4, §9.4.
 *
 * The fast path, and the default one: type a name, press Enter, the task is at
 * the end of the list and the field is empty and still focused for the next
 * one. Three tasks in a row is three keystrokes' worth of ceremony, not three
 * dialogs.
 *
 * Nothing here awaits the network. `addTask` applies optimistically through
 * `mutate()` and the field clears in the same tick, so there is no round trip
 * for the user to notice — a failed write rolls the row back and raises a
 * retry toast, which is §6.8's contract and not something this component
 * re-implements.
 *
 * The row is sticky to the bottom of the scroll area so it stays reachable on a
 * long board; on mobile the browser lifts the layout viewport when the keyboard
 * opens, which is what puts it above the keyboard while focused.
 */

import { ArrowsOutSimple } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { addTask } from '../lib/actions';

export interface QuickAddProps {
  boardId: string;
  /** Opens the composer pre-filled with whatever has been typed (§6.4). */
  onExpand(draft: string): void;
  /** An empty board focuses its quick add on arrival (§9.4). */
  autoFocus?: boolean;
}

export function QuickAdd({ boardId, onExpand, autoFocus = false }: QuickAddProps) {
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
    // Only on arrival at an empty board — re-focusing whenever the board's
    // emptiness changes would steal the caret out of the composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commit(event: React.FormEvent) {
    event.preventDefault();
    const name = value.trim();
    if (name === '') return;

    addTask({ boardId, name });
    setValue('');
    // Belt and braces: the input is never unmounted, but an Enter that lands
    // while the row re-renders must not end up somewhere else.
    input.current?.focus();
  }

  return (
    <form
      onSubmit={commit}
      className="sticky bottom-0 z-10 -mx-gutter mt-2 px-gutter pt-2 pb-2"
      style={{
        background:
          'linear-gradient(to bottom, transparent, var(--bg) 40%, var(--bg))',
        paddingBottom: 'calc(var(--space-2) + env(safe-area-inset-bottom))',
      }}
    >
      <div
        className="flex items-center gap-1 rounded-control bg-surface-2 pr-1 pl-3
                   focus-within:outline-2 focus-within:outline-accent"
        style={{ minHeight: 'var(--tap-target)' }}
      >
        <input
          ref={input}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={120}
          aria-label="Add a task"
          placeholder="Add a task"
          className="min-w-0 flex-1 border-0 bg-transparent text-row text-text outline-none
                     placeholder:text-text-tertiary"
          style={{ height: 'var(--tap-target)' }}
        />
        <button
          type="button"
          onClick={() => onExpand(value)}
          aria-label="Open the full composer"
          className="pressable flex shrink-0 items-center justify-center rounded-chip
                     text-text-secondary"
          style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
        >
          <ArrowsOutSimple size={20} />
        </button>
      </div>
    </form>
  );
}
