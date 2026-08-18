/**
 * Up Next. PROJECT-SPEC.md §6.7, §7.2, §9.3.
 *
 * Answers "what now?" without opening anything: the most urgent dated,
 * unblocked, incomplete tasks across every board of the current context. The
 * ranking is `selectUpNext` — this component does not filter or sort, it only
 * renders what the selector hands it.
 *
 * Layout is a row that scrolls horizontally and bleeds off the right edge on
 * narrow viewports, which is what signals there is more without a scrollbar or
 * an arrow. On wide viewports the same row simply fits.
 *
 * **The strip is resizable, one row at a time.** A minus and a plus in the
 * section header add and remove rows of five between one and three. The default
 * is still the single row of five §6.7 specified, and the preference is
 * remembered per context and per device (`lib/collapse.ts` says why it is not
 * server state).
 *
 * Rows are a slice of one ranking, not several: row two holds ranks 6–10 and
 * row three 11–15, so growing the strip only ever reveals what was already next
 * and never reorders what is already on screen. A row that is not full does not
 * render at all, which is what keeps the plus from producing an empty band.
 *
 * Overdue entries use `--negative` **for the date text only** — the name stays
 * at full contrast, because an overdue task is not a warning, it is a task.
 */

import { CalendarBlank, Check, Clock, Flag, Minus, Plus } from '@phosphor-icons/react';
import { motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { claimColdLoad, staggerDelay } from '../lib/coldload';
import {
  usePersistedCollapse,
  usePersistedCount,
  upNextKey,
  upNextRowsKey,
} from '../lib/collapse';
import { formatBlockTime, formatDue, formatOverdue } from '../lib/dates';
import { toggleComplete } from '../lib/actions';
import { useStore, useUpNext } from '../lib/store';
import { isScheduledEntry, UP_NEXT_LIMIT, UP_NEXT_MAX_ROWS } from '../../shared/upnext';
import type { Context, Task } from '../../shared/types';
import { Skeleton } from './ui/Skeleton';
import { TaskDetails } from './TaskDetails';
import { Collapsible, SectionHeader } from './ui/Section';
import { OUT } from '../lib/motion';

export function UpNext({
  context,
  onOpenTask,
}: {
  context: Context;
  onOpenTask(task: Task): void;
}) {
  const ranked = useUpNext(context);
  const [collapsed, toggle] = usePersistedCollapse(upNextKey(context));
  const [rows, setRows] = usePersistedCount(upNextRowsKey(context), 1, 1, UP_NEXT_MAX_ROWS);
  // Cold load only: navigating away and back must not replay the entrance.
  const [cold] = useState(() => claimColdLoad(`upnext:${context}`));

  // A row the ranking cannot fill is not drawn. The plus is disabled at the
  // same point, so the control and the strip agree about what another row
  // would be worth — pressing a live plus always adds something visible.
  const shown = ranked.slice(0, rows * UP_NEXT_LIMIT);
  const canGrow = rows < UP_NEXT_MAX_ROWS && ranked.length > rows * UP_NEXT_LIMIT;

  return (
    <section className="mb-section">
      <SectionHeader
        collapsed={collapsed}
        onToggle={toggle}
        regionId="up-next"
        action={
          // Hidden rather than disabled when the strip is empty: a stepper for
          // rows of nothing is a control with nothing to control.
          ranked.length > 0 && !collapsed ? (
            <RowStepper
              rows={rows}
              canGrow={canGrow}
              onChange={setRows}
            />
          ) : null
        }
      >
        Up Next
      </SectionHeader>

      <Collapsible id="up-next" collapsed={collapsed}>
        {shown.length === 0 ? (
          // One quiet line. No illustration, no call to action — this surface
          // must not shout when it has nothing to say (§6.7).
          <p className="pb-2 text-body text-text-secondary">Nothing scheduled</p>
        ) : (
          <div className="grid gap-3">
            {Array.from({ length: rows }, (_, row) =>
              shown.slice(row * UP_NEXT_LIMIT, (row + 1) * UP_NEXT_LIMIT),
            )
              .filter((entries) => entries.length > 0)
              .map((entries, row) => (
                <ul
                  key={row}
                  className="edge-scroll -mx-gutter flex gap-3 px-gutter pb-2"
                  {...(row > 0 ? { 'aria-label': `Up Next, row ${row + 1}` } : {})}
                >
                  {entries.map((task, index) => (
                    <motion.li
                      key={task.id}
                      className="shrink-0"
                      // Sized to its content between a floor and a ceiling
                      // rather than fixed: a name that used to be clipped at
                      // two lines now widens the card until it fits, and only
                      // wraps once the card has reached the ceiling. The floor
                      // keeps a one-word task from collapsing to a chip.
                      style={{
                        width: 'max-content',
                        minWidth: '15rem',
                        maxWidth: 'min(26rem, 85vw)',
                        scrollSnapAlign: 'start',
                      }}
                      initial={cold ? { opacity: 0, y: 8 } : false}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.24,
                        ease: OUT,
                        // One stagger across the whole strip, not one per row:
                        // the rows are a wrap of a single list, and restarting
                        // the count on each would read as three lists arriving.
                        delay: cold ? staggerDelay(row * UP_NEXT_LIMIT + index) : 0,
                      }}
                    >
                      <TaskDetails task={task} className="block h-full">
                        <UpNextCard task={task} onOpenTask={onOpenTask} />
                      </TaskDetails>
                    </motion.li>
                  ))}
                </ul>
              ))}
          </div>
        )}
      </Collapsible>
    </section>
  );
}

/**
 * The minus/plus that sizes the strip.
 *
 * A pair of icon buttons with the count between them, in the header's trailing
 * action slot where "New board" sits on the section below. Both ends refuse by
 * `disabled` rather than by disappearing: a control that vanishes at its limit
 * makes the reader wonder what they did, and §8.4 asks for reduced opacity on
 * the same shape rather than a grey restyle.
 *
 * The count is the live region, not the buttons — pressing plus should announce
 * "2 rows", not re-read the button that was just pressed.
 */
function RowStepper({
  rows,
  canGrow,
  onChange,
}: {
  rows: number;
  canGrow: boolean;
  onChange(rows: number): void;
}) {
  return (
    <span className="flex items-center gap-1">
      <StepButton
        label="Show one row fewer"
        disabled={rows <= 1}
        onClick={() => onChange(rows - 1)}
      >
        <Minus size={16} />
      </StepButton>

      <span
        aria-live="polite"
        className="min-w-4 text-center text-meta tabular-nums text-text-secondary"
      >
        {rows}
      </span>

      <StepButton
        label="Show one row more"
        disabled={!canGrow}
        onClick={() => onChange(rows + 1)}
      >
        <Plus size={16} />
      </StepButton>
    </span>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="pressable hoverable flex items-center justify-center rounded-chip
                 text-text-secondary disabled:opacity-40"
      style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
    >
      {children}
    </button>
  );
}

function UpNextCard({ task, onOpenTask }: { task: Task; onOpenTask(task: Task): void }) {
  const board = useStore((state) => state.boards[task.boardId]);
  const [now] = useState(() => Date.now());
  // An entry present because of its block leads with the scheduled time behind
  // a clock; one present because of its date leads with the date behind a
  // calendar (§8). An entry with both shows the one its tier is about, which is
  // why this asks the ranking rather than checking `scheduledAt` itself.
  const scheduled = isScheduledEntry(task, now);
  const overdue = scheduled ? null : formatOverdue(task, now);
  const line = scheduled
    ? formatBlockTime(task.scheduledAt as number)
    : (overdue ?? formatDue(task, now));

  return (
    <div
      className="flex h-full items-start gap-1 pr-2"
      style={{
        backgroundColor: 'var(--surface)',
        border: 'var(--hairline-width) solid var(--hairline)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={false}
        aria-label={`Complete "${task.name}"`}
        onClick={() => toggleComplete(task)}
        className="pressable flex shrink-0 items-center justify-center rounded-card"
        style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
      >
        <span
          aria-hidden="true"
          className="flex items-center justify-center rounded-chip"
          style={{
            width: '24px',
            height: '24px',
            border: '1px solid color-mix(in srgb, var(--text-tertiary) 60%, transparent)',
            color: 'var(--on-accent)',
          }}
        >
          <Check size={16} weight="bold" style={{ opacity: 0 }} />
        </span>
      </button>

      <button
        type="button"
        onClick={() => onOpenTask(task)}
        className="pressable hoverable min-w-0 flex-1 rounded-card px-3 py-3 text-left"
      >
        <span className="flex items-start gap-1">
          <span
            className="min-w-0 flex-1 text-row text-text"
            style={{ overflowWrap: 'anywhere' }}
          >
            {task.name}
          </span>
          {task.priority && (
            <Flag
              size={16}
              weight="fill"
              className="mt-1 shrink-0 text-accent"
              aria-label="Priority"
            />
          )}
        </span>
        <span className="mt-2 block text-meta text-text-secondary">
          {board?.name ?? ''}
        </span>
        {line && (
          <span
            className="mt-1 flex items-center gap-1 text-meta tabular-nums"
            style={{ color: overdue ? 'var(--negative)' : 'var(--text-secondary)' }}
          >
            {scheduled ? (
              <Clock size={13} aria-hidden="true" />
            ) : (
              <CalendarBlank size={13} aria-hidden="true" />
            )}
            {line}
          </span>
        )}
      </button>
    </div>
  );
}

/** The strip's loading state: cards matching the real geometry, shimmering. */
export function UpNextSkeleton() {
  return (
    <section className="mb-section">
      <SectionHeader>Up Next</SectionHeader>
      <ul className="edge-scroll -mx-gutter flex gap-3 px-gutter pb-2">
        {[0, 1, 2].map((index) => (
          <li key={index} className="shrink-0" style={{ width: '15rem' }}>
            <div
              className="p-4"
              style={{
                backgroundColor: 'var(--surface)',
                border: 'var(--hairline-width) solid var(--hairline)',
                borderRadius: 'var(--radius-card)',
              }}
            >
              <Skeleton width="70%" height="1rem" />
              <div className="mt-3">
                <Skeleton width="45%" height="0.75rem" />
              </div>
              <div className="mt-2">
                <Skeleton width="55%" height="0.75rem" />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
