/**
 * Up Next. PROJECT-SPEC.md §6.7, §7.2, §9.3.
 *
 * Answers "what now?" without opening anything: the five most urgent dated,
 * unblocked, incomplete tasks across every board of the current context. The
 * ranking is `selectUpNext` — this component does not filter or sort, it only
 * renders what the selector hands it.
 *
 * Layout is one row that scrolls horizontally and bleeds off the right edge on
 * narrow viewports, which is what signals there is more without a scrollbar or
 * an arrow. On wide viewports the same row simply fits.
 *
 * Overdue entries use `--negative` **for the date text only** — the name stays
 * at full contrast, because an overdue task is not a warning, it is a task.
 */

import { Check, Flag } from '@phosphor-icons/react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { claimColdLoad, staggerDelay } from '../lib/coldload';
import { usePersistedCollapse, upNextKey } from '../lib/collapse';
import { formatDue, formatOverdue } from '../lib/dates';
import { toggleComplete } from '../lib/actions';
import { boardPath, navigate } from '../lib/router';
import { useStore, useUpNext } from '../lib/store';
import type { Context, Task } from '../../shared/types';
import { Skeleton } from './ui/Skeleton';
import { Collapsible, SectionHeader } from './ui/Section';
import { OUT } from '../lib/motion';

export function UpNext({ context }: { context: Context }) {
  const tasks = useUpNext(context);
  const [collapsed, toggle] = usePersistedCollapse(upNextKey(context));
  // Cold load only: navigating away and back must not replay the entrance.
  const [cold] = useState(() => claimColdLoad(`upnext:${context}`));

  return (
    <section className="mb-section">
      <SectionHeader collapsed={collapsed} onToggle={toggle} regionId="up-next">
        Up Next
      </SectionHeader>

      <Collapsible id="up-next" collapsed={collapsed}>
        {tasks.length === 0 ? (
          // One quiet line. No illustration, no call to action — this surface
          // must not shout when it has nothing to say (§6.7).
          <p className="pb-2 text-body text-text-secondary">Nothing scheduled</p>
        ) : (
          <ul className="edge-scroll -mx-gutter flex gap-3 px-gutter pb-2">
            {tasks.map((task, index) => (
              <motion.li
                key={task.id}
                className="shrink-0"
                style={{ width: '15rem', scrollSnapAlign: 'start' }}
                initial={cold ? { opacity: 0, y: 8 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, ease: OUT, delay: cold ? staggerDelay(index) : 0 }}
              >
                <UpNextCard task={task} />
              </motion.li>
            ))}
          </ul>
        )}
      </Collapsible>
    </section>
  );
}

function UpNextCard({ task }: { task: Task }) {
  const board = useStore((state) => state.boards[task.boardId]);
  const [now] = useState(() => Date.now());
  const overdue = formatOverdue(task, now);
  const due = overdue ?? formatDue(task, now);

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
        onClick={() =>
          navigate(boardPath(task.boardId), { state: { highlightTaskId: task.id } })
        }
        className="pressable hoverable min-w-0 flex-1 rounded-card py-3 pr-2 text-left"
      >
        <span className="flex items-start gap-1">
          <span
            className="min-w-0 flex-1 text-row text-text"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
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
        <span className="mt-2 block truncate text-meta text-text-secondary">
          {board?.name ?? ''}
        </span>
        {due && (
          <span
            className="mt-1 block text-meta"
            style={{ color: overdue ? 'var(--negative)' : 'var(--text-secondary)' }}
          >
            {due}
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
