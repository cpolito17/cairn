/**
 * A block on the grid. PROJECT-SPEC-V2.md §6.3; PROJECT-SPEC.md §8.3, §8.4.
 *
 * Top is the start, height is the duration, and the width is its lane's slice
 * of the column — all of it computed upstream (`shared/planner.ts`) and handed
 * here as numbers to turn into `calc()`. This component decides nothing about
 * *where* a block goes; it decides what one looks like.
 *
 * Four appearances, and each is a state the data already has:
 *
 * - **Committed:** an accent-tint fill with an accent edge down its leading
 *   side. The ordinary case.
 * - **Uncommitted** (`durationMinutes` null): 30 minutes tall with a dotted
 *   1px outline in place of that edge. Scheduled, length not decided — the
 *   dotted line is the only honest way to draw a block whose bottom is a
 *   default rather than a decision.
 * - **Completed:** `--text-tertiary` throughout, struck through, no accent
 *   anywhere. Completion does not clear the block, so the hour stays occupied.
 * - **Ghost:** the other context's block. A `--surface-2` fill, no border, no
 *   accent, the single word "Busy", and `pointer-events: none`. It carries no
 *   name and no id, because `PlacedBlock` never gave it one.
 *
 * Content is chosen by available height rather than by duration in the
 * abstract: at 45 minutes and above there is room for the name on two lines
 * plus a time range; below that there is room for one truncated line and
 * anything else is a squeeze.
 */

import { Flag } from '@phosphor-icons/react';
import type { PlacedBlock } from '../../../shared/planner';
import { formatBlockTime } from '../../lib/dates';
import type { Task } from '../../../shared/types';
import { minutesInto, offsetOf } from './scale';

/** At and above this many minutes a block shows its time range (§6.3). */
export const EXPANDED_MINUTES = 45;

/** The gutter between two lanes, and between a block and its column edge. */
const LANE_GAP = '2px';

export interface BlockProps {
  block: PlacedBlock;
  /** Local midnight of the column this block sits in. */
  dayStart: number;
  /** The task, for a real block. Ghosts are handed nothing. */
  task?: Task | undefined;
  onOpen(task: Task): void;
}

export function Block({ block, dayStart, task, onOpen }: BlockProps) {
  const top = offsetOf(minutesInto(block.startMs, dayStart));
  const height = offsetOf(block.minutes);
  // `1/lanes` of the column at `lane/lanes`, with the gap taken out of the
  // width rather than added to the offset, so the last lane ends flush.
  const left = `calc(${(100 * block.lane) / block.lanes}% + ${LANE_GAP})`;
  const width = `calc(${100 / block.lanes}% - ${LANE_GAP} * 2)`;

  const position = { top, height, left, width } as const;

  if (block.ghost || task === undefined) {
    return <GhostBlock position={position} />;
  }

  return <TaskBlock block={block} task={task} position={position} onOpen={onOpen} />;
}

type Position = { top: string; height: string; left: string; width: string };

/**
 * The other context's time, and nothing else about it (§6.3). Not a button, not
 * focusable, `pointer-events: none`, and `aria-hidden` — a screen reader
 * walking the grid should not stop on a band that says "Busy" seven times.
 */
function GhostBlock({ position }: { position: Position }) {
  return (
    <div
      aria-hidden="true"
      className="absolute overflow-hidden rounded-chip bg-surface-2"
      style={{ ...position, pointerEvents: 'none' }}
    >
      <span className="block truncate px-2 py-1 text-meta text-text-tertiary">Busy</span>
    </div>
  );
}

/**
 * A block's edges, written per side rather than as a shorthand plus an
 * override.
 *
 * The shorthand-plus-override version had a real bug in it: React writes an
 * inline style object property by property, and a property whose value is
 * `undefined` is written as the empty string — which *resets* that side rather
 * than leaving the shorthand's value in place. `border` then `borderLeft:
 * undefined` therefore produced a block with no left edge at all, and the
 * dotted outline that says "length not committed" silently lost a quarter of
 * itself. Every side is stated here, so there is nothing to reset.
 */
function edgesOf({ done, uncommitted }: { done: boolean; uncommitted: boolean }) {
  // §6.3: the dotted outline stands *in place of* the fill edge, so a block
  // never has both.
  if (uncommitted) {
    const dotted = '1px dotted var(--accent)';
    return { borderTop: dotted, borderRight: dotted, borderBottom: dotted, borderLeft: dotted };
  }
  // A completed block carries no accent anywhere — including on its edges,
  // which is why this is a hairline and not a dimmed accent.
  if (done) {
    const hairline = 'var(--hairline-width) solid var(--hairline)';
    return {
      borderTop: hairline,
      borderRight: hairline,
      borderBottom: hairline,
      borderLeft: hairline,
    };
  }
  const edge = '1px solid color-mix(in srgb, var(--accent) 40%, transparent)';
  return {
    borderTop: edge,
    borderRight: edge,
    borderBottom: edge,
    borderLeft: '3px solid var(--accent)',
  };
}

function TaskBlock({
  block,
  task,
  position,
  onOpen,
}: {
  block: PlacedBlock;
  task: Task;
  position: Position;
  onOpen(task: Task): void;
}) {
  const done = task.completedAt !== null;
  const uncommitted = task.durationMinutes === null;
  const edges = edgesOf({ done, uncommitted });
  const expanded = block.minutes >= EXPANDED_MINUTES;
  const endMs = block.startMs + block.minutes * 60_000;
  const range = `${formatBlockTime(block.startMs)} – ${formatBlockTime(endMs)}`;

  return (
    <button
      type="button"
      onClick={() => onOpen(task)}
      // The label carries what the block's own height may have hidden, so a
      // 15-minute block is as legible to a screen reader as an hour-long one.
      aria-label={`${task.name}, ${range}${done ? ', completed' : ''}`}
      className="planner-block pressable absolute flex flex-col items-start overflow-hidden
                 rounded-chip px-2 py-1 text-left"
      style={{
        ...position,
        background: done ? 'var(--surface-2)' : 'var(--accent-tint)',
        ...edges,
        color: done ? 'var(--text-tertiary)' : 'var(--text)',
      }}
    >
      <span
        className="w-full text-left"
        style={{
          fontSize: '0.8125rem',
          fontWeight: 500,
          lineHeight: 1.25,
          textDecoration: done ? 'line-through' : undefined,
          // Two lines when there is room for two, one when there is not — and
          // the truncation is the same mechanism either way, so a name that
          // fits is never clipped by a hair.
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: expanded ? 2 : 1,
          overflow: 'hidden',
          wordBreak: 'break-word',
        }}
      >
        {task.name}
      </span>

      {expanded && (
        <span className="flex w-full items-center gap-1 text-meta" style={{ opacity: 0.85 }}>
          <span className="truncate">{range}</span>
          {task.priority && (
            <Flag
              size={12}
              weight="fill"
              aria-label="Priority"
              // §8.4: the priority marker is accent — but a completed block has
              // no accent anywhere, so there it takes the block's own tertiary.
              style={{ color: done ? 'var(--text-tertiary)' : 'var(--accent)', flexShrink: 0 }}
            />
          )}
        </span>
      )}
    </button>
  );
}
