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
 * task does not require one either. It is a preview and not the board: the rows
 * are in the board's own order and capped, so a 40-task board and a 4-task
 * board stay comparable.
 *
 * The card is no longer one big link. It cannot be: a button inside an anchor
 * is invalid and, in practice, unclickable. The header and each task name are
 * links; the check-off buttons are their siblings.
 */

import { Check } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { toggleComplete } from '../lib/actions';
import { prefersReducedMotion } from '../lib/motion';
import { useActiveTasks, useBoardProgress } from '../lib/store';
import { boardPath, Link } from '../lib/router';
import type { Board, Task } from '../../shared/types';
import { NumberTicker, ProgressBar } from './ProgressBar';

/** How many task names a card previews before it stops and counts the rest. */
const PREVIEW_LIMIT = 5;

export function BoardCard({ board }: { board: Board }) {
  const { percent, done, total } = useBoardProgress(board.id);
  const active = useActiveTasks(board.id);
  const preview = active.slice(0, PREVIEW_LIMIT);
  const overflow = active.length - preview.length;
  const to = boardPath(board.id);

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
        <Link to={to} className="pressable hoverable -m-2 block rounded-control p-2">
          <h3 className="text-row text-text" style={{ fontWeight: 600 }}>
            {board.name}
          </h3>
          {board.description && (
            <p className="mt-1 truncate text-meta text-text-secondary">{board.description}</p>
          )}

          <div className="mt-5 flex items-center gap-3">
            <span className="min-w-0 flex-1">
              <ProgressBar percent={percent} label={`${board.name} progress`} />
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
            <li key={task.id} className="flex items-center gap-1">
              <Link
                to={to}
                className="hoverable -ml-2 min-w-0 flex-1 truncate rounded-chip px-2 py-1
                           text-meta text-text-secondary"
              >
                {task.priority && (
                  <span
                    aria-hidden="true"
                    className="mr-2 inline-block size-1 rounded-pill align-middle"
                    style={{ backgroundColor: 'var(--accent)' }}
                  />
                )}
                {task.name}
              </Link>
              <CompleteButton task={task} />
            </li>
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
function CompleteButton({ task }: { task: Task }) {
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
      aria-label={`Complete "${task.name}"`}
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
