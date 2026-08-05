/**
 * A board card on the context home. PROJECT-SPEC.md §8.4, §9.3.
 *
 * The one place the nested-enclosure treatment applies: an outer shell at
 * `--surface` with a hairline and a 16px radius, holding an inner content area
 * at a concentric smaller radius — 4px of frame around a 12px inner, so the two
 * curves stay parallel rather than one looking bolted inside the other.
 *
 * Progress comes from `boardProgress()` through the store's selector. Nothing
 * here counts tasks itself.
 *
 * Below the progress bar the card previews the board's next few active tasks,
 * so the home screen answers "what is in here" without a navigation — and each
 * preview row carries its own check-off button, so the commonest action on a
 * task does not require one either. It is a preview and not the board: the
 * rows are capped, so a 40-task board and a 4-task board stay comparable.
 *
 * **The preview's own order, not the board's.** Priority-flagged tasks sort
 * first — this is a five-slot glance at "what matters", and a priority task
 * sitting past the cap because of where it happens to live in the board's own
 * (manually dragged) order would defeat the point of flagging it at all.
 * Blocked and gated tasks sort last, ahead of nothing — they are not
 * actionable right now, so they are the last thing worth the cap's five slots.
 * Within each group the board's own order holds, because the sort is stable
 * and ties are never broken. The dragged order is still what the board screen
 * itself shows; only this five-item glance reads it differently.
 *
 * The card is no longer one big link. It cannot be: a button inside an anchor
 * is invalid and, in practice, unclickable. The header and each task name are
 * separate controls; the check-off buttons are their siblings.
 */

import { Check, LinkSimple, Plus } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toggleComplete } from '../lib/actions';
import { prefersReducedMotion } from '../lib/motion';
import { useActiveTasks, useBlockedBy, useBoardProgress, useStore } from '../lib/store';
import { TaskDetails } from './TaskDetails';
import { boardPath, Link } from '../lib/router';
import { isGated, lookupOf } from '../../shared/dependencies';
import type { Board, Task } from '../../shared/types';
import { NumberTicker, ProgressBar } from './ProgressBar';
import { boardAccentColor } from '../lib/boardAccent';

/** How many task names a card previews before it stops and counts the rest. */
const PREVIEW_LIMIT = 5;

export function BoardCard({
  board,
  onEditBoard,
  onEditTask,
  onAddTask,
}: {
  board: Board;
  onEditBoard(): void;
  onEditTask(task: Task): void;
  onAddTask(): void;
}) {
  const { percent, done, total } = useBoardProgress(board.id);
  const active = useActiveTasks(board.id);
  const tasks = useStore((state) => state.tasks);
  const preview = useMemo(() => {
    const lookup = lookupOf(tasks);
    // A stable sort, so ties fall back to the board's own order rather than
    // shuffling on every render — `Array.prototype.sort` has guaranteed that
    // since ES2019, which is what makes leaving ties alone below safe.
    return [...active]
      .sort((a, b) => {
        const aBlocked = a.blocked || isGated(a, lookup);
        const bBlocked = b.blocked || isGated(b, lookup);
        if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
        if (a.priority !== b.priority) return a.priority ? -1 : 1;
        return 0;
      })
      .slice(0, PREVIEW_LIMIT);
  }, [active, tasks]);
  const overflow = active.length - preview.length;
  const to = boardPath(board.id);
  const accent = boardAccentColor(board.accent);

  return (
    <div
      style={{
        backgroundColor: 'var(--surface)',
        border: 'var(--hairline-width) solid var(--hairline)',
        borderRadius: 'var(--radius-card)',
        padding: 'var(--space-1)',
      }}
    >
      <div
        className="p-4"
        style={{ backgroundColor: 'var(--bg)', borderRadius: 'var(--radius-control)' }}
      >
        {/* The header is the card's navigation, and the hover belongs to it
            rather than to the whole card — the hover has to point at what is
            actually clickable now that the task rows are not. */}
        <div className="-m-2 flex items-center gap-1">
          <button
            type="button"
            data-no-drag=""
            onClick={onEditBoard}
            className="pressable hoverable flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-2 text-left"
            aria-label={`Edit ${board.name}`}
          >
            <span
              aria-hidden="true"
              className="block shrink-0 rounded-pill"
              style={{ width: '10px', height: '10px', backgroundColor: accent }}
            />
            <h3 className="min-w-0 truncate text-row text-text" style={{ fontWeight: 600 }}>
              {board.name}
            </h3>
          </button>
          {/* Navigation into the board still lives below, on the description
              and progress block — this slot is for the one action worth a
              shortcut from the dashboard: adding to a board without leaving
              it. */}
          <button
            type="button"
            data-no-drag=""
            onClick={onAddTask}
            className="pressable hoverable flex shrink-0 items-center justify-center rounded-control text-text-secondary"
            style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
            aria-label={`Add task to ${board.name}`}
          >
            <Plus size={18} />
          </button>
        </div>

        <Link to={to} className="pressable hoverable -mx-2 mt-2 block rounded-control px-2 pb-2">
          {board.description && (
            <p className="mt-1 truncate text-meta text-text-secondary">{board.description}</p>
          )}

          <div className="mt-5 flex items-center gap-3">
            <span className="min-w-0 flex-1">
              <ProgressBar percent={percent} label={`${board.name} progress`} color={accent} />
            </span>
            <span className="shrink-0 text-row text-text" style={{ fontWeight: 600 }}>
              <NumberTicker value={percent} />
            </span>
          </div>

          <p className="mt-2 text-meta text-text-secondary">
            {done} of {total} {total === 1 ? 'task' : 'tasks'}
          </p>
        </Link>

        <ul className="mt-3" aria-label={`${board.name} tasks`}>
          {preview.map((task) => (
            <PreviewRow key={task.id} task={task} onEditTask={onEditTask} />
          ))}

          {preview.length === 0 && (
            <li className="py-1 text-meta text-text-tertiary">
              {total === 0 ? 'No tasks yet' : 'Everything here is done'}
            </li>
          )}

          {overflow > 0 && (
            <li className="px-0 py-1 text-meta text-text-tertiary">+{overflow} more</li>
          )}
        </ul>
      </div>
    </div>
  );
}

/**
 * One preview row: the task's name, and the button that completes it.
 *
 * Hovering anywhere on the row opens the details card — notes, dates,
 * difficulty and the rest — so the card can stay a list of names without the
 * information being lost.
 */
function PreviewRow({ task, onEditTask }: { task: Task; onEditTask(task: Task): void }) {
  // A task waiting on an incomplete prerequisite reads as unavailable here for
  // the same reason it does on the board, and its button refuses in the same
  // way (§6.4).
  const waiting = useBlockedBy(task.id);

  return (
    <TaskDetails task={task} className="flex items-center gap-1">
      <button
        type="button"
        data-no-drag=""
        onClick={() => onEditTask(task)}
        className="hoverable -ml-2 min-w-0 flex-1 truncate rounded-chip px-2 py-1 text-meta"
        style={{ color: waiting ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}
      >
        {task.priority && !waiting && (
          <span
            aria-hidden="true"
            className="mr-2 inline-block size-1 rounded-pill align-middle"
            style={{ backgroundColor: 'var(--accent)' }}
          />
        )}
        {waiting && (
          <LinkSimple size={12} className="mr-1 inline-block shrink-0 align-middle" />
        )}
        {task.name}
      </button>
      <CompleteButton task={task} waitingOn={waiting?.name ?? null} />
    </TaskDetails>
  );
}

/* --- the check-off button ------------------------------------------------- */

/** The fill wipes up, then the disc pops. Together under §8.5's 300ms ceiling. */
const LOAD_MS = 160;
const POP_MS = 130;

type Phase = 'idle' | 'loading' | 'popping';

/**
 * Complete a task from the dashboard.
 *
 * The gesture is deliberately two beats — the accent fill loads upward through
 * the disc, and then the disc pops and throws a ring — and the mutation is held
 * until they finish. Completing first would be honest but unwatchable: the task
 * leaves the active list the moment it commits, so the row would be gone before
 * the animation it is meant to celebrate had started.
 *
 * Holding the write also gives the press its own weight. The delay is 290ms,
 * which is under §8.5's hard ceiling and short enough that the row disappearing
 * still reads as caused by the tap.
 *
 * Two paths skip all of it and commit immediately: a keyboard activation, which
 * §8.5 says gets no animation ever, and reduced motion, where the pop is the
 * whole effect and there is nothing left worth waiting for.
 */
function CompleteButton({ task, waitingOn }: { task: Task; waitingOn: string | null }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const timers = useRef<number[]>([]);

  // A completed task leaves the active list, so this component is unmounted by
  // its own last timer. Anything still pending — including on a card that is
  // unmounted for another reason mid-animation — is cleared here.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const id of pending) window.clearTimeout(id);
    };
  }, []);

  function start(viaKeyboard: boolean) {
    if (phase !== 'idle') return;

    // A gated task still calls through: `toggleComplete` refuses it and says
    // what it is waiting on. Celebrating a completion that will not happen is
    // the one thing the animation must not do, so it does not start.
    if (waitingOn !== null) {
      toggleComplete(task);
      return;
    }

    if (viaKeyboard || prefersReducedMotion()) {
      toggleComplete(task);
      return;
    }

    setPhase('loading');
    timers.current.push(
      window.setTimeout(() => setPhase('popping'), LOAD_MS),
      window.setTimeout(() => toggleComplete(task), LOAD_MS + POP_MS),
    );
  }

  const filled = phase !== 'idle';

  return (
    <button
      type="button"
      // `detail === 0` is a click the keyboard synthesised — the same test the
      // board screen's checkbox uses to tell Space and Enter from a thumb.
      onClick={(event) => start(event.detail === 0)}
      aria-disabled={waitingOn !== null || undefined}
      aria-label={
        waitingOn === null
          ? `Complete "${task.name}"`
          : `"${task.name}" is waiting on "${waitingOn}"`
      }
      // Board cards drag to reorder, and a long press on a 44px target is a
      // press. This keeps the button out of that gesture.
      data-no-drag=""
      className="pressable relative flex shrink-0 items-center justify-center rounded-control"
      style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
    >
      {/* The ring thrown off by the pop. Rendered only while popping so the
          animation restarts cleanly rather than being retriggered. */}
      {phase === 'popping' && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute rounded-pill"
          style={{
            width: '24px',
            height: '24px',
            border: '2px solid var(--accent)',
            animation: `cairn-burst ${POP_MS + 90}ms var(--ease-out) forwards`,
          }}
        />
      )}

      <span
        aria-hidden="true"
        className="relative flex items-center justify-center overflow-hidden rounded-pill"
        style={{
          width: '24px',
          height: '24px',
          border: '1px solid',
          borderColor: filled
            ? 'var(--accent)'
            : 'color-mix(in srgb, var(--text-tertiary) 60%, transparent)',
          borderStyle: waitingOn === null ? 'solid' : 'dashed',
          color: filled ? 'var(--on-accent)' : 'var(--text-tertiary)',
          transition: `border-color ${LOAD_MS}ms var(--ease-out), color ${LOAD_MS}ms var(--ease-out)`,
          animation: phase === 'popping' ? `cairn-pop ${POP_MS}ms var(--ease-out)` : undefined,
        }}
      >
        {/* The load: the accent floods the disc from the bottom up. A clip-path
            wipe rather than a growing shape, for the same reason the board
            screen's check draws in — §8.5 forbids the scale-from-nothing. */}
        <span
          className="absolute inset-0 block"
          style={{
            backgroundColor: 'var(--accent)',
            clipPath: filled ? 'inset(0 0 0 0)' : 'inset(100% 0 0 0)',
            transition: `clip-path ${LOAD_MS}ms var(--ease-out)`,
          }}
        />
        <Check size={14} weight="bold" className="relative" />
      </span>
    </button>
  );
}
