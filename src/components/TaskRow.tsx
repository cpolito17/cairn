/**
 * The task row — the workhorse. PROJECT-SPEC.md §8.4, §6.4, §6.5.
 *
 * Left to right: a checkbox inside a ≥44px target, the name, then a trailing
 * cluster of chips showing **only the fields that are set**, in the fixed order
 * due · duration · difficulty · priority · blocked · notes. A task with nothing
 * set shows nothing but its name — that is the common case and it has to read
 * as intentional, which is why there are no placeholder dashes and no empty
 * chip slots holding space.
 *
 * The whole row opens the composer; the checkbox is a separate target that does
 * not. They are siblings rather than nested (a button inside a button is
 * invalid and, in practice, unclickable) with the row's own button filling the
 * remaining width.
 *
 * The completion *animation* — the check drawing in, the strikethrough drawing
 * across, the row travelling to the Completed group — is issue 6. Here a
 * completed row simply renders in its completed appearance.
 */

import { Check, Clock, Note, Prohibit, Timer, Flag } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { formatDuration, formatDue } from '../lib/dates';
import type { Task } from '../../shared/types';
import { Chip } from './ui/Chip';
import { Pips } from './ui/Pips';

export interface TaskRowProps {
  task: Task;
  onOpen(task: Task): void;
  onToggle(task: Task): void;
  /** Set briefly when the row is the target of an Up Next tap (§6.7). */
  highlighted?: boolean;
}

export function TaskRow({ task, onOpen, onToggle, highlighted = false }: TaskRowProps) {
  const done = task.completedAt !== null;
  // The clock is read once per mount rather than per render: the due chip's
  // wording is relative ("Tomorrow"), and a value that changed mid-render would
  // make two rows of the same list disagree.
  const [now] = useState(() => Date.now());
  const due = formatDue(task, now);

  const nameColor = done
    ? 'var(--text-tertiary)'
    : task.blocked
      ? 'var(--text-secondary)'
      : 'var(--text)';

  return (
    <div
      className="hoverable relative flex items-stretch gap-1 rounded-control"
      style={{
        minHeight: 'var(--row-height)',
        backgroundColor: highlighted ? 'var(--accent-tint)' : 'transparent',
        transition: 'background-color 420ms var(--ease-out)',
      }}
    >
      <Checkbox checked={done} name={task.name} onToggle={() => onToggle(task)} />

      <button
        type="button"
        onClick={() => onOpen(task)}
        className="pressable flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1
                   rounded-control py-3 pr-3 text-left"
      >
        <span
          className="flex-1 text-row"
          style={{
            // The name outranks the cluster for width: without a floor, six
            // chips squeeze a long name into a three-line column and the row
            // stops being scannable. Below this the cluster wraps to its own
            // line instead, which is what "grows with content" means here.
            minWidth: '9rem',
            color: nameColor,
            textDecoration: done ? 'line-through' : undefined,
            wordBreak: 'break-word',
          }}
        >
          {task.name}
        </span>

        {/* The cluster shrinks and wraps within itself; the chips inside it do
            not, so a narrow viewport breaks the cluster onto its own line
            rather than clipping the last chip off the screen edge. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {due && (
            <Chip icon={<Clock size={16} />} tone="secondary" muted={done}>
              {due}
            </Chip>
          )}
          {task.duration && (
            <Chip icon={<Timer size={16} />} muted={done}>
              {formatDuration(task.duration)}
            </Chip>
          )}
          {task.difficulty !== null && <Pips value={task.difficulty} muted={done} />}
          {task.priority && (
            <Chip
              icon={<Flag size={16} weight="fill" />}
              tone="accent"
              muted={done}
              aria-label="Priority"
            />
          )}
          {task.blocked && (
            <Chip icon={<Prohibit size={16} />} muted={done} aria-label="Blocked" />
          )}
          {task.notes && <Chip icon={<Note size={16} />} muted={done} aria-label="Has notes" />}
        </span>
      </button>
    </div>
  );
}

/**
 * The checkbox. 24px of box inside a 44px target, per §8.4 — the box is what
 * the eye measures and the target is what the thumb hits.
 */
function Checkbox({
  checked,
  name,
  onToggle,
}: {
  checked: boolean;
  name: string;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? `Mark "${name}" incomplete` : `Complete "${name}"`}
      onClick={onToggle}
      className="pressable flex shrink-0 items-center justify-center rounded-control"
      style={{ width: 'var(--tap-target)', minHeight: 'var(--tap-target)' }}
    >
      <span
        aria-hidden="true"
        className="flex items-center justify-center rounded-chip"
        style={{
          width: '24px',
          height: '24px',
          backgroundColor: checked ? 'var(--accent)' : 'transparent',
          border: checked
            ? '1px solid var(--accent)'
            : '1px solid color-mix(in srgb, var(--text-tertiary) 60%, transparent)',
          color: 'var(--on-accent)',
          transition: 'background-color 160ms var(--ease-out), border-color 160ms var(--ease-out)',
        }}
      >
        {checked && <Check size={16} weight="bold" />}
      </span>
    </button>
  );
}

/**
 * Hold a row's highlight for a beat after an Up Next tap, then release it.
 * Returns the id that should currently read as highlighted.
 */
export function useHighlight(targetId: string | null, ms = 1600): string | null {
  const [id, setId] = useState<string | null>(targetId);

  useEffect(() => {
    setId(targetId);
    if (targetId === null) return;
    const handle = window.setTimeout(() => setId(null), ms);
    return () => window.clearTimeout(handle);
  }, [targetId, ms]);

  return id;
}
