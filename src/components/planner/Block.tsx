/**
 * A block on the grid. PROJECT-SPEC-V2.md §6.3, §6.7; PROJECT-SPEC.md §8.3,
 * §8.4, §8.5.
 *
 * Top is the start, height is the duration, and the width is its lane's slice
 * of the column — all of it computed upstream (`shared/planner.ts`) and handed
 * here as numbers to turn into `calc()`. This component decides nothing about
 * *where* a block goes; it decides what one looks like, and it owns the two
 * targets a block presents: its body, which opens the composer, and its bottom
 * edge, which resizes it (§6.7).
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
 * The surface and the content are exported separately from the block itself,
 * because the thing under the finger during a drag is drawn from exactly the
 * same two pieces (`scheduling.tsx`). One block, one appearance: a proxy built
 * from a second copy of these styles would be a copy that drifts.
 *
 * Content is chosen by available height rather than by duration in the
 * abstract: at 45 minutes and above there is room for the name on two lines
 * plus a time range; below that there is room for one truncated line and
 * anything else is a squeeze.
 */

import { Flag } from '@phosphor-icons/react';
import type { PlacedBlock } from '../../../shared/planner';
import { effectiveMinutes } from '../../../shared/schedule';
import { formatBlockTime } from '../../lib/dates';
import { MIN_DURATION_MINUTES, SCHEDULE_STEP_MINUTES, type Task } from '../../../shared/types';
import { resizeTaskSpec, unscheduleTaskSpec, useStore } from '../../lib/store';
import { clampDuration, useDragHandlers, useIsDragging } from './scheduling';
import { minutesInto, offsetOf } from './scale';

/** At and above this many minutes a block shows its time range (§6.3). */
export const EXPANDED_MINUTES = 45;

/** The gutter between two lanes, and between a block and its column edge. */
const LANE_GAP = '2px';
export const LANE_GAP_PX = 2;

/**
 * §6.7: the bottom edge is a resize handle with a ≥44px effective target that
 * does not steal the block's own press target.
 *
 * Those two requirements fight, and the geometry is where they are settled. The
 * band reaches *below* the block into the gap under it — up to half of that gap,
 * so the next block down keeps more room than it gives — and takes the rest
 * from the block itself, capped at 60% of its height. A 2-hour block therefore
 * gives up 33px of its 128 and reads as a body with an edge; a 30-minute block
 * with nothing under it gives up 19px of its 32 and gains 11 below, which is the
 * best a 32px-tall object can do without swallowing its neighbour. The block's
 * own aria label and its keyboard resize are what carry the case the pixels
 * cannot.
 */
const HANDLE_TARGET_PX = 26;
const HANDLE_BELOW_MAX_PX = 6;
const HANDLE_ABOVE_SHARE = 0.35;

export interface BlockProps {
  block: PlacedBlock;
  /** Local midnight of the column this block sits in. */
  dayStart: number;
  /** The task, for a real block. Ghosts are handed nothing. */
  task?: Task | undefined;
  /** Minutes of empty column below this block in its own lane, for the handle. */
  gapBelow: number;
  /** `--planner-hour` per minute, measured once by the column. */
  pixelsPerMinute: number;
  onOpen(task: Task): void;
}

export function Block({
  block,
  dayStart,
  task,
  gapBelow,
  pixelsPerMinute,
  onOpen,
}: BlockProps) {
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

  return (
    <TaskBlock
      block={block}
      task={task}
      position={position}
      gapBelow={gapBelow}
      pixelsPerMinute={pixelsPerMinute}
      onOpen={onOpen}
    />
  );
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

export interface BlockSurface {
  background: string;
  borderTop: string;
  borderRight: string;
  borderBottom: string;
  borderLeft: string;
  color: string;
}

/**
 * A block's fill, edges and text colour.
 *
 * Every side is stated, rather than a shorthand plus an override. The
 * shorthand-plus-override version had a real bug in it: React writes an inline
 * style object property by property, and a property whose value is `undefined`
 * is written as the empty string — which *resets* that side rather than leaving
 * the shorthand's value in place. `border` then `borderLeft: undefined`
 * therefore produced a block with no left edge at all, and the dotted outline
 * that says "length not committed" silently lost a quarter of itself.
 */
export function blockSurface(task: Task): BlockSurface {
  const done = task.completedAt !== null;
  const uncommitted = task.durationMinutes === null;

  // §6.3: the dotted outline stands *in place of* the fill edge, so a block
  // never has both.
  if (uncommitted) {
    const dotted = '1px dotted var(--accent)';
    return {
      background: done ? 'var(--surface-2)' : 'var(--accent-tint)',
      borderTop: dotted,
      borderRight: dotted,
      borderBottom: dotted,
      borderLeft: dotted,
      color: done ? 'var(--text-tertiary)' : 'var(--text)',
    };
  }
  // A completed block carries no accent anywhere — including on its edges,
  // which is why this is a hairline and not a dimmed accent.
  if (done) {
    const hairline = 'var(--hairline-width) solid var(--hairline)';
    return {
      background: 'var(--surface-2)',
      borderTop: hairline,
      borderRight: hairline,
      borderBottom: hairline,
      borderLeft: hairline,
      color: 'var(--text-tertiary)',
    };
  }
  const edge = '1px solid color-mix(in srgb, var(--accent) 40%, transparent)';
  return {
    background: 'var(--accent-tint)',
    borderTop: edge,
    borderRight: edge,
    borderBottom: edge,
    borderLeft: '3px solid var(--accent)',
    color: 'var(--text)',
  };
}

/** The time range a block reads out, given a start and a length. */
export function blockRange(startMs: number, minutes: number): string {
  return `${formatBlockTime(startMs)} – ${formatBlockTime(startMs + minutes * 60_000)}`;
}

/**
 * What is written inside a block: the name, and — where there is room — the
 * range and the priority flag. Shared with the drag proxy, so the thing under
 * the finger says the same as the thing it will become.
 */
export function BlockFace({
  task,
  minutes,
  startMs,
  fade = 1,
}: {
  task: Task;
  minutes: number;
  startMs: number | null;
  /** Opacity for the label, so a shrinking block loses it rather than spills it. */
  fade?: number;
}) {
  const done = task.completedAt !== null;
  const expanded = minutes >= EXPANDED_MINUTES;

  return (
    <span
      className={`flex w-full flex-col items-start px-2 text-left ${expanded ? 'py-1' : 'py-0'}`}
      style={{ opacity: fade, minHeight: expanded ? undefined : offsetOf(MIN_DURATION_MINUTES) }}
    >
      <span
        className="w-full text-left"
        style={{
          fontSize: '0.8125rem',
          fontWeight: 500,
          lineHeight: expanded ? 1.25 : offsetOf(MIN_DURATION_MINUTES),
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

      {expanded && startMs !== null && (
        <span className="flex w-full items-center gap-1 text-meta" style={{ opacity: 0.85 }}>
          <span className="truncate">{blockRange(startMs, minutes)}</span>
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
    </span>
  );
}

function TaskBlock({
  block,
  task,
  position,
  gapBelow,
  pixelsPerMinute,
  onOpen,
}: {
  block: PlacedBlock;
  task: Task;
  position: Position;
  gapBelow: number;
  pixelsPerMinute: number;
  onOpen(task: Task): void;
}) {
  const mutate = useStore((state) => state.mutate);
  const dragging = useIsDragging(task.id);
  const handlers = useDragHandlers(task, 'move');
  const range = blockRange(block.startMs, block.minutes);
  const startMs = task.scheduledAt ?? block.startMs;

  /**
   * §6.7's keyboard path for a block: Shift+↑/↓ resizes by 15 minutes, Delete
   * unschedules. Both write through the same specs the gesture uses, and both
   * animate nothing — §8.5 gives keyboard-initiated actions no animation, ever,
   * and a block is not a FLIP participant, so there is nothing to suppress: the
   * block simply appears at its new length or leaves the grid.
   */
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      void mutate(unscheduleTaskSpec(task));
      return;
    }
    if (!event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

    event.preventDefault();
    const step = event.key === 'ArrowUp' ? -SCHEDULE_STEP_MINUTES : SCHEDULE_STEP_MINUTES;
    const next = clampDuration(startMs, effectiveMinutes(task) + step);
    if (next === task.durationMinutes) return;
    void mutate(resizeTaskSpec(task, next));
  }

  const heightPx = block.minutes * pixelsPerMinute;
  const below = Math.min(HANDLE_BELOW_MAX_PX, (gapBelow * pixelsPerMinute) / 2);
  const above = Math.min(HANDLE_TARGET_PX - below, heightPx * HANDLE_ABOVE_SHARE);

  return (
    <>
      <button
        type="button"
        data-block-id={task.id}
        onClick={() => onOpen(task)}
        onKeyDown={onKeyDown}
        {...handlers}
        // The label carries what the block's own height may have hidden, so a
        // 15-minute block is as legible to a screen reader as an hour-long one.
        aria-label={`${task.name}, ${range}${task.completedAt !== null ? ', completed' : ''}`}
        aria-keyshortcuts="Shift+ArrowUp Shift+ArrowDown Delete"
        className="planner-block pressable absolute flex flex-col items-start overflow-hidden
                   rounded-chip text-left"
        style={{
          ...position,
          ...blockSurface(task),
          // The proxy is standing in for it. Opacity, never `display` — taking
          // the element out of the flow would repack nothing here but would
          // cost a layout, and §8.5 wants neither.
          opacity: dragging ? 0 : 1,
          pointerEvents: dragging ? 'none' : undefined,
          // A drag surface is not a text-selection surface: without this a long
          // press on iOS raises the selection magnifier instead of lifting the
          // block.
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          touchAction: 'pan-y',
        }}
      >
        <BlockFace task={task} minutes={block.minutes} startMs={startMs} />
      </button>

      {!dragging && <ResizeHandle task={task} position={position} above={above} below={below} />}
    </>
  );
}

/**
 * The resize edge. A sibling of the block rather than a child, because its
 * target reaches past the block's own box and a child of an `overflow: hidden`
 * button cannot. It carries no role and no focus: the keyboard reaches the same
 * value through the block itself, and a second tab stop per block would make a
 * day of blocks twice as long to walk.
 */
function ResizeHandle({
  task,
  position,
  above,
  below,
}: {
  task: Task;
  position: Position;
  above: number;
  below: number;
}) {
  const handlers = useDragHandlers(task, 'resize');

  return (
    <div
      aria-hidden="true"
      onPointerDown={handlers.onPointerDown}
      className="planner-resize absolute flex items-start justify-center"
      style={{
        left: position.left,
        width: position.width,
        top: `calc(${position.top} + ${position.height} - ${above}px)`,
        height: `${above + below}px`,
        cursor: 'ns-resize',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
    >
      {/* The grip, sitting on the edge itself. Hover-gated (§8.5); on touch it
          is always faintly there, because a target with no mark is a target
          nobody finds. */}
      <span
        className="planner-grip block rounded-pill"
        style={{
          marginTop: `${Math.max(0, above - 5)}px`,
          width: '24px',
          height: '3px',
          background: 'var(--text-tertiary)',
        }}
      />
    </div>
  );
}
