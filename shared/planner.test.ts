/**
 * The Planner's pure logic. PROJECT-SPEC-V2.md §6.2, §6.3, §6.4.
 *
 * Two things are worth testing here and they are both invariants rather than
 * examples: every sort is a *total* order — so sorting twice cannot reshuffle
 * and unset is last in all four modes — and a ghost is packed with the real
 * blocks rather than beside them.
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  groupByBoard,
  isSameDay,
  layoutDay,
  sortUnscheduled,
  startOfWeek,
  weekDays,
} from './planner';
import type { PlannerSort, Task } from './types';

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    boardId: 'board-1',
    name: id,
    notes: null,
    dueDate: null,
    dueTime: null,
    durationMinutes: null,
    scheduledAt: null,
    difficulty: null,
    priority: false,
    blocked: false,
    dependsOn: null,
    position: 'a0',
    createdAt: 0,
    completedAt: null,
    updatedAt: 0,
    ...patch,
  };
}

const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

const ids = (tasks: Task[]) => tasks.map((entry) => entry.id);

describe('the calendar', () => {
  it('starts the week on Sunday', () => {
    // 2026-03-04 is a Wednesday; its week starts Sunday 2026-03-01.
    expect(startOfWeek(at(2026, 3, 4, 15, 30))).toBe(at(2026, 3, 1));
    // A Sunday is its own week start, at midnight rather than at its own time.
    expect(startOfWeek(at(2026, 3, 1, 23, 59))).toBe(at(2026, 3, 1));
  });

  it('walks days by the local calendar, not by 86,400,000', () => {
    expect(addDays(at(2026, 3, 4), 1)).toBe(at(2026, 3, 5));
    expect(addDays(at(2026, 3, 1), -1)).toBe(at(2026, 2, 28));
    // Across a month boundary and a leap-year February.
    expect(addDays(at(2028, 2, 28), 1)).toBe(at(2028, 2, 29));
  });

  it('gives seven midnights, Sunday first', () => {
    const days = weekDays(at(2026, 3, 4, 9));
    expect(days).toHaveLength(7);
    expect(days[0]).toBe(at(2026, 3, 1));
    expect(days[6]).toBe(at(2026, 3, 7));
    expect(days.every((day) => new Date(day).getHours() === 0)).toBe(true);
  });

  it('compares days by the calendar, not by proximity', () => {
    expect(isSameDay(at(2026, 3, 4, 0, 1), at(2026, 3, 4, 23, 59))).toBe(true);
    expect(isSameDay(at(2026, 3, 4, 23, 59), at(2026, 3, 5, 0, 1))).toBe(false);
  });
});

describe('the unscheduled sorts', () => {
  /** One list carrying every unset the four sorts have to place last. */
  const list: Task[] = [
    task('b-plain'),
    task('a-flagged', { priority: true }),
    task('c-due-soon', { dueDate: '2026-03-02' }),
    task('d-due-later', { dueDate: '2026-03-09' }),
    task('e-hard', { difficulty: 5 }),
    task('f-easy', { difficulty: 1 }),
    task('g-short', { durationMinutes: 15 }),
    task('h-long', { durationMinutes: 240 }),
  ];

  it('puts flagged first, then due ascending with undated last', () => {
    expect(ids(sortUnscheduled(list, 'priority'))).toEqual([
      'a-flagged',
      'c-due-soon',
      'd-due-later',
      'b-plain',
      'e-hard',
      'f-easy',
      'g-short',
      'h-long',
    ]);
  });

  it('runs difficulty 5→1 with unset last', () => {
    const order = ids(sortUnscheduled(list, 'difficulty'));
    expect(order.slice(0, 2)).toEqual(['e-hard', 'f-easy']);
    // Everything with no difficulty follows, and among those the dated ones
    // come first — the tie-break is the due moment, not the id.
    expect(order.slice(2, 4)).toEqual(['c-due-soon', 'd-due-later']);
    expect(order.slice(4)).toEqual(['a-flagged', 'b-plain', 'g-short', 'h-long']);
  });

  it('runs due ascending with undated last, breaking ties on the flag', () => {
    const order = ids(sortUnscheduled(list, 'dueDate'));
    expect(order.slice(0, 2)).toEqual(['c-due-soon', 'd-due-later']);
    expect(order[2]).toBe('a-flagged');
  });

  it('runs duration ascending with unset last', () => {
    const order = ids(sortUnscheduled(list, 'duration'));
    expect(order.slice(0, 2)).toEqual(['g-short', 'h-long']);
    expect(order.slice(2, 4)).toEqual(['c-due-soon', 'd-due-later']);
  });

  it('sorts a task with no time at the end of its due day, not at its start', () => {
    const untimed = task('untimed', { dueDate: '2026-03-02' });
    const timed = task('timed', { dueDate: '2026-03-02', dueTime: '09:00' });
    expect(ids(sortUnscheduled([untimed, timed], 'dueDate'))).toEqual(['timed', 'untimed']);
  });

  it.each<PlannerSort>(['priority', 'difficulty', 'dueDate', 'duration'])(
    'is a total order in %s mode — same input, same output, whatever the arrival order',
    (sort) => {
      const once = sortUnscheduled(list, sort);
      const twice = sortUnscheduled(once, sort);
      const fromReversed = sortUnscheduled([...list].reverse(), sort);
      expect(ids(twice)).toEqual(ids(once));
      expect(ids(fromReversed)).toEqual(ids(once));
    },
  );

  it('leaves its input alone', () => {
    const original = ids(list);
    sortUnscheduled(list, 'priority');
    expect(ids(list)).toEqual(original);
  });
});

describe('grouping by board', () => {
  const boards = [
    { id: 'b1', name: 'Website' },
    { id: 'b2', name: 'Home' },
    { id: 'b3', name: 'Empty' },
  ];
  const tasks = [
    task('t1', { boardId: 'b2', durationMinutes: 60 }),
    task('t2', { boardId: 'b1', durationMinutes: 240 }),
    task('t3', { boardId: 'b1', durationMinutes: 15 }),
  ];

  it('follows board order and sorts within each group', () => {
    const groups = groupByBoard(tasks, boards, 'duration');
    expect(groups.map((group) => group.boardName)).toEqual(['Website', 'Home']);
    expect(ids(groups[0].tasks)).toEqual(['t3', 't2']);
  });

  it('omits a board with nothing unscheduled rather than heading an empty list', () => {
    const groups = groupByBoard(tasks, boards, 'duration');
    expect(groups.some((group) => group.boardId === 'b3')).toBe(false);
  });
});

describe('laying out a day', () => {
  const day = at(2026, 3, 4);

  it('keeps only what starts on that day', () => {
    const layout = layoutDay(
      day,
      [
        task('today', { scheduledAt: at(2026, 3, 4, 9), durationMinutes: 60 }),
        task('tomorrow', { scheduledAt: at(2026, 3, 5, 9), durationMinutes: 60 }),
        task('unscheduled'),
      ],
      [],
    );
    expect(layout.blocks.map((block) => block.taskId)).toEqual(['today']);
    expect(layout.dayStart).toBe(day);
  });

  it('gives a null duration 30 minutes, the length the grid draws it at', () => {
    const layout = layoutDay(day, [task('loose', { scheduledAt: at(2026, 3, 4, 9) })], []);
    expect(layout.blocks[0].minutes).toBe(30);
  });

  it('packs three mutual overlaps into three lanes and leaves a fourth alone', () => {
    const layout = layoutDay(
      day,
      [
        task('a', { scheduledAt: at(2026, 3, 4, 9), durationMinutes: 60 }),
        task('b', { scheduledAt: at(2026, 3, 4, 9, 15), durationMinutes: 60 }),
        task('c', { scheduledAt: at(2026, 3, 4, 9, 30), durationMinutes: 60 }),
        task('d', { scheduledAt: at(2026, 3, 4, 14), durationMinutes: 60 }),
      ],
      [],
    );
    const lanes = Object.fromEntries(
      layout.blocks.map((block) => [block.taskId, [block.lane, block.lanes]]),
    );
    expect(lanes).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3], d: [0, 1] });
  });

  it('packs a ghost with the real block it overlaps, and names nothing', () => {
    const layout = layoutDay(
      day,
      [task('mine', { scheduledAt: at(2026, 3, 4, 10), durationMinutes: 60 })],
      [task('theirs', { scheduledAt: at(2026, 3, 4, 10, 30), durationMinutes: 60 })],
    );

    expect(layout.blocks).toHaveLength(2);
    expect(layout.blocks.every((block) => block.lanes === 2)).toBe(true);
    expect(new Set(layout.blocks.map((block) => block.lane))).toEqual(new Set([0, 1]));

    const ghost = layout.blocks.find((block) => block.ghost);
    // The renderer cannot leak what it was never given: a ghost carries no id
    // to look a task up by.
    expect(ghost?.taskId).toBeNull();
    expect(JSON.stringify(ghost)).not.toContain('theirs');
  });

  it('does not pack blocks that merely touch', () => {
    const layout = layoutDay(
      day,
      [
        task('early', { scheduledAt: at(2026, 3, 4, 9), durationMinutes: 60 }),
        task('late', { scheduledAt: at(2026, 3, 4, 10), durationMinutes: 60 }),
      ],
      [],
    );
    expect(layout.blocks.every((block) => block.lanes === 1)).toBe(true);
  });
});
