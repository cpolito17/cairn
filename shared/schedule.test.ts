import { describe, expect, it } from 'vitest';
import {
  blockEnd,
  blockOf,
  crossesMidnight,
  effectiveMinutes,
  isSnapped,
  packLanes,
  scheduledMinutesByDay,
  snapToStep,
  type ScheduleBlock,
} from './schedule';
import type { Task } from './types';

/** Local-time epoch ms — everything in this module is local wall clock. */
function local(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

let seq = 0;

function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    boardId: 'b1',
    name: `task ${seq}`,
    notes: null,
    dueDate: null,
    dueTime: null,
    durationMinutes: null,
    scheduledAt: null,
    difficulty: null,
    priority: false,
    blocked: false,
    dependsOn: [],
    position: `a${seq}`,
    createdAt: 0,
    completedAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

/** `9:00`–`10:00` on one fixed day, as a block. */
function block(id: string, from: string, to: string): ScheduleBlock {
  const start = local('2026-08-04', from);
  const end = local('2026-08-04', to);
  return { id, startMs: start, minutes: (end - start) / 60_000 };
}

function lanesOf(packed: ReturnType<typeof packLanes>): Record<string, [number, number]> {
  return Object.fromEntries(packed.map((p) => [p.block.id, [p.lane, p.lanes]]));
}

describe('snapToStep', () => {
  it('rounds to the nearest 15-minute mark', () => {
    expect(snapToStep(local('2026-08-04', '09:07'))).toBe(local('2026-08-04', '09:00'));
    expect(snapToStep(local('2026-08-04', '09:08'))).toBe(local('2026-08-04', '09:15'));
    expect(snapToStep(local('2026-08-04', '09:23'))).toBe(local('2026-08-04', '09:30'));
  });

  it('leaves a value already on the grid alone', () => {
    for (const time of ['00:00', '09:15', '13:30', '23:45']) {
      const at = local('2026-08-04', time);
      expect(snapToStep(at)).toBe(at);
      expect(isSnapped(at)).toBe(true);
    }
  });

  it('rounds a sub-minute value onto the grid too', () => {
    expect(isSnapped(local('2026-08-04', '09:15') + 1)).toBe(false);
    expect(snapToStep(local('2026-08-04', '09:15') + 1)).toBe(local('2026-08-04', '09:15'));
  });

  it('snaps to local midnight, not to the epoch grid', () => {
    // A whole-hour timezone makes these the same; a :30 or :45 offset does not.
    // Snapping through the local day is what keeps 9:15 AM meaning 9:15 AM.
    const midnight = local('2026-08-04', '00:00');
    expect(snapToStep(midnight + 7 * 60_000)).toBe(midnight);
    expect(snapToStep(midnight + 8 * 60_000)).toBe(midnight + 15 * 60_000);
  });

  it('rounds a value just under the next midnight up to it', () => {
    const nextMidnight = local('2026-08-05', '00:00');
    expect(snapToStep(nextMidnight - 60_000)).toBe(nextMidnight);
  });
});

describe('effectiveMinutes', () => {
  it('is the committed duration when there is one', () => {
    expect(effectiveMinutes(task({ durationMinutes: 105 }))).toBe(105);
  });

  it('is 30 minutes when the length is not committed', () => {
    // Dropping onto the grid does not invent a duration (§3.1) — the block
    // simply occupies half an hour until a resize commits one.
    expect(effectiveMinutes(task({ durationMinutes: null }))).toBe(30);
  });
});

describe('blockEnd', () => {
  it('is the start plus the effective minutes', () => {
    const at = local('2026-08-04', '09:00');
    expect(blockEnd(task({ scheduledAt: at, durationMinutes: 90 }))).toBe(
      local('2026-08-04', '10:30'),
    );
    expect(blockEnd(task({ scheduledAt: at, durationMinutes: null }))).toBe(
      local('2026-08-04', '09:30'),
    );
  });

  it('is null for an unscheduled task', () => {
    expect(blockEnd(task({ scheduledAt: null, durationMinutes: 60 }))).toBeNull();
  });
});

describe('crossesMidnight', () => {
  it('refuses a block whose end falls on the next day', () => {
    expect(crossesMidnight(local('2026-08-04', '22:00'), 240)).toBe(true);
    expect(crossesMidnight(local('2026-08-04', '23:45'), 30)).toBe(true);
  });

  it('allows a block that ends exactly at midnight', () => {
    // The end is exclusive: a block ending at 00:00 occupies no part of the
    // next day, and refusing it would make 11:00 PM–midnight unschedulable.
    expect(crossesMidnight(local('2026-08-04', '22:00'), 120)).toBe(false);
    expect(crossesMidnight(local('2026-08-04', '23:45'), 15)).toBe(false);
  });

  it('allows the same block earlier in the day', () => {
    expect(crossesMidnight(local('2026-08-04', '08:00'), 240)).toBe(false);
  });

  it('allows a full-length block starting at midnight', () => {
    expect(crossesMidnight(local('2026-08-04', '00:00'), 720)).toBe(false);
  });
});

describe('packLanes', () => {
  it('gives three mutually overlapping blocks three lanes', () => {
    const packed = packLanes([
      block('a', '09:00', '10:00'),
      block('b', '09:15', '10:15'),
      block('c', '09:30', '10:30'),
    ]);
    expect(lanesOf(packed)).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3] });
  });

  it('reuses a lane once its occupant has ended', () => {
    // A 9–10, B 9:30–10:30, C 10–11. All three are one transitive-overlap
    // cluster, but only two ever overlap at once, so the cluster takes two
    // lanes and C sits back in lane 0 that A has vacated.
    const packed = packLanes([
      block('a', '09:00', '10:00'),
      block('b', '09:30', '10:30'),
      block('c', '10:00', '11:00'),
    ]);
    expect(lanesOf(packed)).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2] });
  });

  it('keeps two blocks that merely touch at an edge full width', () => {
    // The end is exclusive, so 9–10 and 10–11 do not overlap: two clusters of
    // one lane each, both rendering at full width.
    const packed = packLanes([block('a', '09:00', '10:00'), block('b', '10:00', '11:00')]);
    expect(lanesOf(packed)).toEqual({ a: [0, 1], b: [0, 1] });
  });

  it('separates clusters that do not touch', () => {
    const packed = packLanes([
      block('a', '09:00', '10:00'),
      block('b', '09:30', '10:30'),
      block('c', '14:00', '15:00'),
    ]);
    expect(lanesOf(packed)).toEqual({ a: [0, 2], b: [1, 2], c: [0, 1] });
  });

  it('does not care what order the blocks arrive in', () => {
    const blocks = [
      block('a', '09:00', '10:00'),
      block('b', '09:30', '10:30'),
      block('c', '10:00', '11:00'),
    ];
    const forward = lanesOf(packLanes(blocks));
    const backward = lanesOf(packLanes([...blocks].reverse()));
    expect(backward).toEqual(forward);
  });

  it('returns the blocks in start order, ties broken by id', () => {
    const packed = packLanes([
      block('z', '09:00', '10:00'),
      block('a', '09:00', '09:30'),
      block('m', '08:00', '08:30'),
    ]);
    expect(packed.map((p) => p.block.id)).toEqual(['m', 'a', 'z']);
  });

  it('is empty for no blocks', () => {
    expect(packLanes([])).toEqual([]);
  });
});

describe('blockOf', () => {
  it('is null for an unscheduled task', () => {
    expect(blockOf(task())).toBeNull();
  });

  it('carries the effective minutes of a task with no committed duration', () => {
    const at = local('2026-08-04', '09:00');
    expect(blockOf(task({ id: 'x', scheduledAt: at }))).toEqual({
      id: 'x',
      startMs: at,
      minutes: 30,
    });
  });
});

describe('scheduledMinutesByDay', () => {
  it('totals the effective minutes of each local day', () => {
    const totals = scheduledMinutesByDay([
      task({ scheduledAt: local('2026-08-04', '09:00'), durationMinutes: 60 }),
      task({ scheduledAt: local('2026-08-04', '14:00'), durationMinutes: 90 }),
      task({ scheduledAt: local('2026-08-05', '09:00'), durationMinutes: null }),
      task({ scheduledAt: null, durationMinutes: 120 }),
    ]);
    expect(totals).toEqual({ '2026-08-04': 150, '2026-08-05': 30 });
  });

  it('counts a completed block — it is the record of when the work happened', () => {
    const totals = scheduledMinutesByDay([
      task({
        scheduledAt: local('2026-08-04', '09:00'),
        durationMinutes: 60,
        completedAt: local('2026-08-04', '10:00'),
      }),
    ]);
    expect(totals).toEqual({ '2026-08-04': 60 });
  });

  it('is empty when nothing is scheduled', () => {
    expect(scheduledMinutesByDay([task(), task()])).toEqual({});
  });
});
