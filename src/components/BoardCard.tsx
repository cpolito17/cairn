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
 * so the home screen answers "what is in here" without a navigation. It is a
 * preview and not a list: the rows are inert text inside the card's link, in
 * the board's own order, capped so a 40-task board and a 4-task board are the
 * same height.
 */

import { useActiveTasks, useBoardProgress } from '../lib/store';
import { boardPath, Link } from '../lib/router';
import type { Board } from '../../shared/types';
import { NumberTicker, ProgressBar } from './ProgressBar';

/** How many task names a card previews before it stops and counts the rest. */
const PREVIEW_LIMIT = 5;

export function BoardCard({ board }: { board: Board }) {
  const { percent, done, total } = useBoardProgress(board.id);
  const active = useActiveTasks(board.id);
  const preview = active.slice(0, PREVIEW_LIMIT);
  const overflow = active.length - preview.length;

  return (
    <Link
      to={boardPath(board.id)}
      className="pressable block"
      style={{
        backgroundColor: 'var(--surface)',
        border: 'var(--hairline-width) solid var(--hairline)',
        borderRadius: 'var(--radius-card)',
        padding: 'var(--space-1)',
      }}
    >
      <div
        className="hoverable p-4"
        style={{ backgroundColor: 'var(--bg)', borderRadius: 'var(--radius-control)' }}
      >
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

        {/* The preview. `aria-hidden` because the line above already states the
            board's state to a screen reader, and reading five task names inside
            a link's accessible name would bury the board's own. */}
        <ul aria-hidden="true" className="mt-3 grid gap-1">
          {preview.map((task) => (
            <li key={task.id} className="flex items-baseline gap-2">
              <span
                className="mt-px size-1 shrink-0 rounded-pill"
                style={{
                  backgroundColor: task.priority ? 'var(--accent)' : 'var(--text-tertiary)',
                }}
              />
              <span className="min-w-0 flex-1 truncate text-meta text-text-secondary">
                {task.name}
              </span>
            </li>
          ))}

          {preview.length === 0 && (
            <li className="text-meta text-text-tertiary">
              {total === 0 ? 'No tasks yet' : 'Everything here is done'}
            </li>
          )}

          {overflow > 0 && (
            <li className="text-meta text-text-tertiary">
              +{overflow} more
            </li>
          )}
        </ul>
      </div>
    </Link>
  );
}
