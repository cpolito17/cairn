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
 */

import { useBoardProgress } from '../lib/store';
import { boardPath, Link } from '../lib/router';
import type { Board } from '../../shared/types';
import { NumberTicker, ProgressBar } from './ProgressBar';

export function BoardCard({ board }: { board: Board }) {
  const { percent, done, total } = useBoardProgress(board.id);

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
      </div>
    </Link>
  );
}
