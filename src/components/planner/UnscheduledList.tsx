/**
 * The unscheduled task list. PROJECT-SPEC-V2.md §6.2; PROJECT-SPEC.md §8.3,
 * §8.4, §8.5.
 *
 * Incomplete, unscheduled tasks from every non-archived board in the current
 * context, in one of four orders, optionally grouped under their boards. The
 * ordering and the grouping are `shared/planner.ts` reached through the store's
 * selectors — this file renders whatever list it is handed and decides nothing
 * about what is in it or what order it comes in.
 *
 * **Blocked and gated tasks are here, recessed** (§6.2): the name drops to
 * `--text-secondary` and the marker shows, which is §8.4's existing blocked-row
 * treatment. Leaving them out would be the easy reading and the wrong one —
 * planning to do something after its prerequisite clears is legitimate, and the
 * rule that matters gates the *completion*, not the plan.
 *
 * Sort and grouping persist through `settings` (§3.2), so they go through the
 * store's settings mutation: optimistic, rolled back with a retryable toast,
 * and nothing of its own to maintain.
 *
 * Empty, loading and error states are all here, because §8.4 requires all three
 * of every list surface and this is a list surface.
 */

import { Clock, Flag, LinkSimple, Prohibit, Timer } from '@phosphor-icons/react';
import { motion } from 'motion/react';
import { useId, useState } from 'react';
import type { TaskGroup } from '../../../shared/planner';
import type { Context, PlannerSort, Settings, Task } from '../../../shared/types';
import { claimColdLoad, staggerDelay } from '../../lib/coldload';
import { formatDue, formatDuration } from '../../lib/dates';
import { OUT } from '../../lib/motion';
import {
  updateSettingsSpec,
  useBlockedBy,
  useStore,
  useUnscheduled,
  useUnscheduledGroups,
} from '../../lib/store';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EmptyLine, ErrorLine, loadErrorMessage } from '../ui/Section';
import { SkeletonRow } from '../ui/Skeleton';

const SORT_LABELS: { value: PlannerSort; label: string }[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'difficulty', label: 'Difficulty' },
  { value: 'dueDate', label: 'Due date' },
  { value: 'duration', label: 'Duration' },
];

export interface UnscheduledListProps {
  context: Context;
  settings: Settings;
  onOpen(task: Task): void;
}

export function UnscheduledList({ context, settings, onOpen }: UnscheduledListProps) {
  const status = useStore((state) => state.status);
  const tasks = useUnscheduled(context, settings.plannerSort);
  const groups = useUnscheduledGroups(context, settings.plannerSort);

  return (
    <div className="flex min-h-0 flex-col">
      <Controls settings={settings} count={status === 'ready' ? tasks.length : null} />

      {status === 'loading' ? (
        <ListSkeleton />
      ) : status === 'error' ? (
        <ListError />
      ) : tasks.length === 0 ? (
        <EmptyLine>Everything is scheduled.</EmptyLine>
      ) : settings.plannerGroupByBoard ? (
        <Grouped groups={groups} onOpen={onOpen} />
      ) : (
        <Rows tasks={tasks} onOpen={onOpen} offset={0} />
      )}
    </div>
  );
}

/** The sort control and the group-by-board toggle. Both persist (§6.2). */
function Controls({ settings, count }: { settings: Settings; count: number | null }) {
  const mutate = useStore((state) => state.mutate);
  const ready = useStore((state) => state.status === 'ready');
  const sortId = useId();

  return (
    <div className="mb-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-section text-text-secondary" style={{ textTransform: 'uppercase' }}>
          Unscheduled{count === null ? '' : ` · ${count}`}
        </span>
      </div>

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label
            htmlFor={sortId}
            className="mb-1 block text-text-secondary"
            style={{ fontSize: '13px', fontWeight: 500 }}
          >
            Sort
          </label>
          {/* A native select, for the same reason the settings sheet uses one:
              it is operable from the keyboard, a screen reader and a mobile
              picker without re-implementing any of the three. The well is
              §8.4's — surface-2, 12px radius, no border at rest, and the focus
              ring comes from the global `:focus-visible` rule. */}
          <select
            id={sortId}
            value={settings.plannerSort}
            disabled={!ready}
            onChange={(event) =>
              void mutate(
                updateSettingsSpec(settings, {
                  plannerSort: event.target.value as PlannerSort,
                }),
              )
            }
            className="w-full rounded-control border-0 bg-surface-2 px-3 text-text
                       disabled:opacity-60"
            style={{ height: 'var(--tap-target)', outlineOffset: '0px' }}
          >
            {SORT_LABELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* `aria-pressed` rather than a checkbox: it is a toggle on a view, not
            a value in a form, and it reads as "Group by board, pressed". */}
        <button
          type="button"
          aria-pressed={settings.plannerGroupByBoard}
          disabled={!ready}
          onClick={() =>
            void mutate(
              updateSettingsSpec(settings, {
                plannerGroupByBoard: !settings.plannerGroupByBoard,
              }),
            )
          }
          className={[
            'pressable shrink-0 rounded-chip px-3 text-meta disabled:opacity-60',
            settings.plannerGroupByBoard
              ? 'bg-accent-tint text-accent'
              : 'bg-surface-2 text-text-secondary',
          ].join(' ')}
          style={{ height: 'var(--tap-target)', fontWeight: 600 }}
        >
          Group
        </button>
      </div>
    </div>
  );
}

function Grouped({ groups, onOpen }: { groups: TaskGroup[]; onOpen(task: Task): void }) {
  let offset = 0;
  return (
    <>
      {groups.map((group) => {
        const start = offset;
        offset += group.tasks.length;
        return (
          <section key={group.boardId} className="mb-4">
            {/* §8.3's section header: 13px uppercase, 600, +0.02em. */}
            <h3
              className="mb-2 truncate text-section text-text-secondary"
              style={{ textTransform: 'uppercase' }}
            >
              {group.boardName}
            </h3>
            <Rows tasks={group.tasks} onOpen={onOpen} offset={start} />
          </section>
        );
      })}
    </>
  );
}

function Rows({
  tasks,
  onOpen,
  offset,
}: {
  tasks: Task[];
  onOpen(task: Task): void;
  offset: number;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {tasks.map((task, index) => (
        <li key={task.id}>
          <UnscheduledRow task={task} index={offset + index} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A row: the name, then only the chips whose fields are set — duration, due,
 * priority — plus the blocked or waiting-on marker when there is one (§6.2,
 * §8.4). No checkbox: this list is about *when*, and completing from it would
 * be a second completion path with its own transition to keep in step.
 *
 * The 40ms stagger is §8.5's, on the cold load only. A row that appears later
 * because a task was unscheduled arrives without an entrance, which is right —
 * the stagger says "this surface just arrived" and would be a lie the second
 * time.
 */
function UnscheduledRow({
  task,
  index,
  onOpen,
}: {
  task: Task;
  index: number;
  onOpen(task: Task): void;
}) {
  const waiting = useBlockedBy(task.id);
  const recessed = waiting !== null || task.blocked;
  const [now] = useState(() => Date.now());
  const [cold] = useState(() => claimColdLoad(`planner-row:${task.id}`));
  const due = formatDue(task, now);

  return (
    <motion.div
      initial={cold ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: OUT, delay: cold ? staggerDelay(index) : 0 }}
    >
      <button
        type="button"
        onClick={() => onOpen(task)}
        className="hoverable pressable flex w-full flex-col items-start gap-1 rounded-control
                   px-3 py-2 text-left"
        style={{ minHeight: 'var(--tap-target)' }}
      >
        <span
          className="w-full text-row"
          style={{
            color: recessed ? 'var(--text-secondary)' : 'var(--text)',
            wordBreak: 'break-word',
          }}
        >
          {task.name}
        </span>

        <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
          {/* Same glyphs the task row uses for the same fields — clock for a
              due moment, timer for a length. Two names for one field is how a
              second list stops looking like the same app. */}
          {due && <Chip icon={<Clock size={16} />}>{due}</Chip>}
          {task.durationMinutes !== null && (
            <Chip icon={<Timer size={16} />}>{formatDuration(task.durationMinutes)}</Chip>
          )}
          {task.priority && (
            <Chip tone="accent" icon={<Flag size={16} weight="fill" />} aria-label="Priority" />
          )}
          {task.blocked && (
            <Chip tone="tertiary" icon={<Prohibit size={16} />}>
              Blocked
            </Chip>
          )}
          {waiting && (
            <Chip tone="tertiary" icon={<LinkSimple size={16} />}>
              Waiting on {waiting.name}
            </Chip>
          )}
        </span>
      </button>
    </motion.div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1">
      {[0, 1, 2, 3, 4].map((row) => (
        <SkeletonRow key={row} />
      ))}
    </div>
  );
}

function ListError() {
  const load = useStore((state) => state.load);
  const failure = useStore((state) => state.failure);

  return (
    <ErrorLine
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      }
    >
      {loadErrorMessage('your unscheduled tasks', failure)}
    </ErrorLine>
  );
}
