/**
 * Schedule geometry — the only place this math exists.
 *
 * The Planner, the composer's stepper, and the Worker's block validation all
 * answer the same handful of questions: where does a moment land on the
 * 15-minute grid, how long is a block really, does it run past midnight, and
 * which blocks have to share their column. Written once here, pure and tested,
 * so the client and the Worker cannot disagree about the shape of a block —
 * a server that computes a different end than the client drew is a server
 * whose 400s look arbitrary.
 *
 * **Everything is local wall-clock time.** No timezone is stored (V2 §2): one
 * user, one clock. Day boundaries come from `Date`'s local accessors rather
 * than from dividing epoch milliseconds, so a DST transition cannot move a
 * block onto the wrong day or knock it off the grid.
 *
 * PROJECT-SPEC-V2.md §3.1, §6.
 */

import { DEFAULT_BLOCK_MINUTES, SCHEDULE_STEP_MINUTES, type Task } from './types';

const MINUTE_MS = 60_000;

/** The grid, in milliseconds. */
export const STEP_MS = SCHEDULE_STEP_MINUTES * MINUTE_MS;

/** Local midnight starting the day that contains `at`. */
export function startOfLocalDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight ending the day that contains `at` — the next day's start. */
export function endOfLocalDay(at: number): number {
  const date = new Date(at);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

/** `YYYY-MM-DD` for the local day containing `at`. */
export function localDayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The nearest 15-minute mark to `ms`.
 *
 * Measured from local midnight rather than from the epoch, deliberately. The
 * epoch grid and the local grid coincide only for whole-hour offsets; in a zone
 * at :30 or :45 an epoch-aligned snap would put every block a quarter hour off
 * the wall clock the user is reading.
 */
export function snapToStep(ms: number): number {
  const dayStart = startOfLocalDay(ms);
  return dayStart + Math.round((ms - dayStart) / STEP_MS) * STEP_MS;
}

/** True when `ms` already sits on the grid. The Worker's admission test. */
export function isSnapped(ms: number): boolean {
  return Number.isInteger(ms) && snapToStep(ms) === ms;
}

/**
 * How long a block actually occupies, in minutes.
 *
 * A scheduled task with no committed duration is a real state — dropping onto
 * the grid does not invent one (§3.1) — and it renders as a 30-minute block
 * with a dotted outline. Both the midnight rule and the lane packing measure it
 * with this, so "how long is it" has exactly one answer.
 */
export function effectiveMinutes(task: Pick<Task, 'durationMinutes'>): number {
  return task.durationMinutes ?? DEFAULT_BLOCK_MINUTES;
}

/** The exclusive end of a task's block, or null when it is unscheduled. */
export function blockEnd(task: Pick<Task, 'durationMinutes' | 'scheduledAt'>): number | null {
  if (task.scheduledAt === null) return null;
  return task.scheduledAt + effectiveMinutes(task) * MINUTE_MS;
}

/**
 * True when a block starting at `startMs` and running `minutes` would spill
 * into the next local day. A crossing block is a 400 (§3.1).
 *
 * The end is exclusive: a block ending exactly at midnight occupies no part of
 * the next day, and refusing it would make the last slot of the evening
 * unschedulable.
 */
export function crossesMidnight(startMs: number, minutes: number): boolean {
  return startMs + minutes * MINUTE_MS > endOfLocalDay(startMs);
}

/* --- lane packing ---------------------------------------------------------- */

/** A placed block, reduced to what the geometry needs. */
export interface ScheduleBlock {
  id: string;
  startMs: number;
  minutes: number;
}

/**
 * One block's place in its overlap cluster: which lane it sits in, and how many
 * lanes the whole cluster takes. A block renders at `1 / lanes` of the column
 * width, offset by `lane / lanes`.
 */
export interface PackedBlock {
  block: ScheduleBlock;
  lane: number;
  lanes: number;
}

/** A scheduled task as a block, or null when it has no block. */
export function blockOf(
  task: Pick<Task, 'id' | 'durationMinutes' | 'scheduledAt'>,
): ScheduleBlock | null {
  if (task.scheduledAt === null) return null;
  return { id: task.id, startMs: task.scheduledAt, minutes: effectiveMinutes(task) };
}

/**
 * Assign every block a lane, and every cluster a lane count.
 *
 * A **cluster** is a transitive-overlap set: A overlapping B and B overlapping
 * C puts all three together even when A and C never touch. The cluster is what
 * carries the lane count, so the column width stays constant across it rather
 * than changing under a block halfway down.
 *
 * Sweeping in start order and dropping each block into the lowest lane whose
 * occupant has already ended is optimal here, not merely tidy: overlaps of
 * intervals form an interval graph, whose chromatic number is its maximum
 * clique — the deepest simultaneous overlap — and that is exactly what the
 * sweep produces. So "the cluster takes the minimum number of lanes" is a
 * property of this loop, not an extra pass.
 *
 * Overlap is half-open. Two blocks that merely touch at an edge — 9–10 and
 * 10–11 — do not overlap, are separate clusters, and both render full width.
 *
 * The input is not mutated; the result is in start order, ties by id, so the
 * same set of blocks always packs the same way whatever order it arrives in.
 */
export function packLanes(blocks: readonly ScheduleBlock[]): PackedBlock[] {
  const sorted = [...blocks].sort(
    (a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const packed: PackedBlock[] = [];
  // The blocks of the cluster being built, and the end of each of its lanes.
  let cluster: PackedBlock[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const closeCluster = () => {
    for (const entry of cluster) entry.lanes = laneEnds.length;
    packed.push(...cluster);
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const block of sorted) {
    const end = block.startMs + block.minutes * MINUTE_MS;

    // Nothing in the cluster is still running, so nothing later can reach back
    // into it: the cluster is complete and its lane count is final.
    if (cluster.length > 0 && block.startMs >= clusterEnd) closeCluster();

    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= block.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }

    // `lanes` is provisional until the cluster closes; `closeCluster` fixes it.
    cluster.push({ block, lane, lanes: 0 });
    clusterEnd = Math.max(clusterEnd, end);
  }

  if (cluster.length > 0) closeCluster();
  return packed;
}

/**
 * Scheduled minutes per local day, keyed `YYYY-MM-DD`. The year view's heat map
 * reads this.
 *
 * Completed blocks count: completion does not clear the block (§3.1), and a day
 * you worked eight hours is a day that was full. Days with nothing scheduled
 * are absent rather than zero — the caller is iterating a calendar, not this
 * map, and a sparse map is cheaper to build and to read.
 */
export function scheduledMinutesByDay(
  tasks: readonly Pick<Task, 'durationMinutes' | 'scheduledAt'>[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const task of tasks) {
    if (task.scheduledAt === null) continue;
    const key = localDayKey(task.scheduledAt);
    totals[key] = (totals[key] ?? 0) + effectiveMinutes(task);
  }
  return totals;
}
