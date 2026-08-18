/**
 * The Overdue Audit.
 *
 * A list of every overdue task Up Next would otherwise rank first, each with
 * the three things you can honestly do about one: move the date, admit it is
 * blocked on something outside your control, or leave it alone.
 *
 * **Why this exists.** Overdue outranks everything in Up Next, deliberately —
 * but a task that cannot be progressed still sits at the top of the strip every
 * day, and enough of them turn the surface that answers "what now?" into a list
 * of things the answer is definitely not. The strip cannot fix that by ranking,
 * because nothing in the data distinguishes "late and actionable" from "late and
 * stuck". Only the reader knows, so the reader is asked — once a day, on the
 * first visit (`lib/overdueAudit.ts` for the cadence and where the mark lives).
 *
 * **The three actions, and why exactly three.**
 *
 *   * **Reschedule** writes a new due date. The task stops being overdue and
 *     re-enters the strip on its own merits. This is the honest answer for work
 *     that simply did not happen yet.
 *   * **Blocked** sets the same `blocked` flag the composer sets (§6.4), which
 *     removes the task from Up Next entirely while leaving it overdue
 *     everywhere it is *read* rather than ranked — its row keeps the negative
 *     due chip and gains the blocked marker beside it. Overdue is a fact and
 *     the audit does not get to erase it; what the flag says is "and I know".
 *   * **Ignore** writes nothing at all. The task keeps its date, keeps its place
 *     at the top of the strip, and will be offered again tomorrow. It is the
 *     answer for "late, and I am going to do it today".
 *
 * Ignoring is therefore the only action that is not persistent, and that is the
 * point: it is a decision about this panel, not about the task.
 *
 * The list is live. Acting on a task removes it from `selectOverdue` on the
 * next render with no bookkeeping here — rescheduling changes its due moment,
 * blocking makes it un-answerable — so the only thing this component tracks is
 * which rows were ignored.
 */

import { CalendarBlank, EyeSlash, Prohibit } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { setBlocked, setDueDate } from '../lib/actions';
import { formatOverdue } from '../lib/dates';
import { useOverdue, useStore } from '../lib/store';
import type { Context, Task } from '../../shared/types';
import { Button } from './ui/Button';
import { Dialog, DialogHeader } from './ui/Dialog';

export interface OverdueAuditProps {
  open: boolean;
  onClose(): void;
  context: Context;
}

export function OverdueAudit({ open, onClose, context }: OverdueAuditProps) {
  const overdue = useOverdue(context);
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => new Set());

  // Ignoring is scoped to one showing of the panel. Reopening it — from
  // Settings, or tomorrow morning — asks again, because "not now" said
  // yesterday is not an answer about today.
  useEffect(() => {
    if (open) setIgnored(new Set());
  }, [open, context]);

  const rows = overdue.filter((task) => !ignored.has(task.id));
  const cleared = overdue.length - rows.length;

  return (
    <Dialog open={open} onClose={onClose} title="Overdue Audit">
      <DialogHeader title="Overdue Audit" onClose={onClose} />

      {rows.length === 0 ? (
        <p className="py-6 text-body text-text-secondary">
          {cleared > 0
            ? 'Nothing left to triage.'
            : 'Nothing is overdue. Up Next is answering the right question.'}
        </p>
      ) : (
        <>
          <p className="mb-4 text-body text-text-secondary">
            {rows.length === 1
              ? 'One task is overdue and sitting at the top of Up Next.'
              : `${rows.length} tasks are overdue and sitting at the top of Up Next.`}{' '}
            Move a date, mark what you cannot progress as blocked, or leave it.
          </p>

          <ul className="grid gap-2">
            {rows.map((task) => (
              <AuditRow
                key={task.id}
                task={task}
                onIgnore={() =>
                  setIgnored((was) => new Set(was).add(task.id))
                }
              />
            ))}
          </ul>
        </>
      )}

      <div className="mt-6">
        <Button fullWidth onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

function AuditRow({ task, onIgnore }: { task: Task; onIgnore(): void }) {
  const board = useStore((state) => state.boards[task.boardId]);
  const [now] = useState(() => Date.now());
  const [picking, setPicking] = useState(false);
  const dateField = useRef<HTMLInputElement>(null);

  // The picker is a native date input revealed in place rather than a popover:
  // it is the same control the composer uses (§6.4), it is keyboard- and
  // screen-reader-operable without this file re-implementing any of it, and on
  // a phone it is the platform's own wheel.
  useEffect(() => {
    if (!picking) return;
    const field = dateField.current;
    if (!field) return;
    field.focus();
    // `showPicker` is the difference between "a date field appeared" and "pick
    // a date" — but it throws where it is unsupported or not user-activated,
    // and the focused field is a complete fallback.
    try {
      field.showPicker();
    } catch {
      /* The field is focused and typable either way. */
    }
  }, [picking]);

  return (
    <li
      className="rounded-control bg-surface-2 p-3"
      style={{ border: 'var(--hairline-width) solid var(--hairline)' }}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-row text-text" style={{ overflowWrap: 'anywhere' }}>
            {task.name}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
            <span className="text-text-secondary">{board?.name ?? ''}</span>
            <span className="tabular-nums" style={{ color: 'var(--negative)' }}>
              {formatOverdue(task, now)}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center">
          <AuditAction
            label={`Reschedule "${task.name}"`}
            active={picking}
            onClick={() => setPicking((was) => !was)}
          >
            <CalendarBlank size={20} />
          </AuditAction>
          <AuditAction
            label={`Mark "${task.name}" blocked`}
            onClick={() => setBlocked(task, true)}
          >
            <Prohibit size={20} />
          </AuditAction>
          <AuditAction label={`Ignore "${task.name}" for now`} onClick={onIgnore}>
            <EyeSlash size={20} />
          </AuditAction>
        </div>
      </div>

      {picking && (
        <div className="mt-3">
          <label
            htmlFor={`audit-due-${task.id}`}
            className="mb-2 block text-text-secondary"
            style={{ fontSize: '13px', fontWeight: 500 }}
          >
            New due date
          </label>
          <input
            ref={dateField}
            id={`audit-due-${task.id}`}
            type="date"
            defaultValue={task.dueDate ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              // An empty value is the picker being cleared, not a date of
              // nothing: the row would vanish from an audit the user is still
              // reading, having silently dropped the deadline.
              if (value === '') return;
              setDueDate(task, value);
              setPicking(false);
            }}
            className="w-full rounded-control border-0 bg-surface px-4 text-text"
            style={{ height: 'var(--button-height)', outlineOffset: '0px' }}
          />
        </div>
      )}
    </li>
  );
}

/**
 * One of the three icon actions. A 20px glyph in a ≥44px target (§8.4), at
 * secondary contrast until it is the one holding state open.
 */
function AuditAction({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      onClick={onClick}
      className="pressable hoverable flex items-center justify-center rounded-chip"
      style={{
        width: 'var(--tap-target)',
        height: 'var(--tap-target)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        transition: 'color 160ms var(--ease-out)',
      }}
    >
      {children}
    </button>
  );
}
