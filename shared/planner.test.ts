/**
 * The Planner's pure logic. PROJECT-SPEC-V2.md §6.2, §6.3, §6.4.
 *
 * Two things are worth testing here and they are both invariants rather than
 * examples: every sort is a *total* order — so sorting twice cannot reshuffle
 * and unset is last in all four modes — and a ghost is packed with the real
 * blocks rather than beside them.
 *
 * §6.5 and §6.6 add two more: the month grid is always six rows whatever month
 * it is drawing, and the heat bucket is exact at its boundaries — "up to 25% of
 * a workday" has to mean 25% included, at every workday length, which is a
 * property of integer arithmetic rather than of a ratio compared to 0.25.
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  groupByBoard,
  heatBucket,
  heatByDay,
  isSameDay,
  isSameMonth,
  layoutDay,
  layoutMonth,
  monthGridDays,
  sortUnscheduled,
  startOfMonth,
  startOfWeek,
  weekDays,
  workdayMinutes,
  yearGridWeeks,
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

describe('the month calendar', () => {
  it('finds the first of the month, whatever time of day it is handed', () => {
    expect(startOfMonth(at(2026, 8, 17, 23, 59))).toBe(at(2026, 8, 1));
    expect(isSameMonth(at(2026, 8, 1), at(2026, 8, 31, 12))).toBe(true);
    expect(isSameMonth(at(2026, 8, 31), at(2026, 9, 1))).toBe(false);
    // Same month number, different year, is not the same month.
    expect(isSameMonth(at(2026, 8, 4), at(2025, 8, 4))).toBe(false);
  });

  it('steps months without letting the day of the month overflow one', () => {
    // The classic failure: 31 January plus a month is 3 March, because February
    // has no 31st. Stepping from the 1st is what rules it out.
    expect(addMonths(at(2026, 1, 31), 1)).toBe(at(2026, 2, 1));
    expect(addMonths(at(2026, 3, 15), -1)).toBe(at(2026, 2, 1));
    expect(addMonths(at(2026, 12, 5), 1)).toBe(at(2027, 1, 1));
    expect(addMonths(at(2026, 8, 4), 12)).toBe(at(2027, 8, 1));
  });

  it('gives six rows for a month that begins on a Sunday', () => {
    // 2026-02-01 is a Sunday, and February 2026 is exactly four weeks long —
    // the month that would collapse a five-row grid to four.
    const days = monthGridDays(at(2026, 2, 14));
    expect(days).toHaveLength(42);
    expect(days[0]).toBe(at(2026, 2, 1));
    expect(new Date(days[0]).getDay()).toBe(0);
    // Two whole weeks of March follow, and they are the adjacent-month days.
    expect(days[41]).toBe(at(2026, 3, 14));
  });

  it('gives six rows for a month that needs all six', () => {
    // 2026-08-01 is a Saturday, so August spends a row on one day and needs a
    // sixth to reach the 31st.
    const days = monthGridDays(at(2026, 8, 4));
    expect(days).toHaveLength(42);
    expect(days[0]).toBe(at(2026, 7, 26));
    expect(days[41]).toBe(at(2026, 9, 5));
    expect(days.every((day) => new Date(day).getHours() === 0)).toBe(true);
  });
});

describe('laying out a month', () => {
  it('marks the adjacent-month days and keeps every day in start order', () => {
    const grid = layoutMonth(
      at(2026, 8, 1),
      [
        task('afternoon', { scheduledAt: at(2026, 8, 4, 14), durationMinutes: 60 }),
        task('morning', { scheduledAt: at(2026, 8, 4, 9), durationMinutes: 60 }),
        task('july', { scheduledAt: at(2026, 7, 28, 9), durationMinutes: 60 }),
      ],
      [],
    );

    expect(grid).toHaveLength(42);
    expect(grid.filter((day) => day.inMonth)).toHaveLength(31);

    const fourth = grid.find((day) => day.dayStart === at(2026, 8, 4));
    expect(fourth?.entries.map((entry) => entry.taskId)).toEqual(['morning', 'afternoon']);

    // A leading day of the previous month is drawn, and drawn as not in month —
    // its blocks are real, it is only the contrast that differs.
    const july = grid.find((day) => day.dayStart === at(2026, 7, 28));
    expect(july?.inMonth).toBe(false);
    expect(july?.entries).toHaveLength(1);
  });

  it('interleaves the other context as unlabelled entries', () => {
    const grid = layoutMonth(
      at(2026, 8, 1),
      [task('mine', { scheduledAt: at(2026, 8, 4, 11), durationMinutes: 60 })],
      [task('theirs', { scheduledAt: at(2026, 8, 4, 9), durationMinutes: 60 })],
    );

    const fourth = grid.find((day) => day.dayStart === at(2026, 8, 4));
    expect(fourth?.entries.map((entry) => entry.ghost)).toEqual([true, false]);
    // The ghost is counted — a cell that dropped it would say the day is
    // emptier than it is — and it is anonymous.
    expect(fourth?.entries[0].taskId).toBeNull();
    expect(JSON.stringify(fourth)).not.toContain('theirs');
  });
});

describe('the year calendar', () => {
  it('gives 53 week starts ending with the week containing the anchor', () => {
    const weeks = yearGridWeeks(at(2026, 8, 5, 13));
    expect(weeks).toHaveLength(53);
    // 2026-08-05 is a Wednesday; its week starts Sunday 2026-08-02.
    expect(weeks[52]).toBe(at(2026, 8, 2));
    expect(weeks[0]).toBe(at(2025, 8, 3));
    expect(weeks.every((week) => new Date(week).getDay() === 0)).toBe(true);
  });
});

describe('the heat map', () => {
  const workday = workdayMinutes({ workdayStartMinutes: 540, workdayEndMinutes: 1020 });

  it('measures against the configured working day', () => {
    expect(workday).toBe(480);
    expect(workdayMinutes({ workdayStartMinutes: 540, workdayEndMinutes: 780 })).toBe(240);
  });

  it('puts a day with nothing scheduled in the empty bucket', () => {
    expect(heatBucket(0, workday)).toBe(0);
  });

  it('puts a day at exactly a quarter of a workday in the first bucket', () => {
    // 120 of 480 minutes: "up to 25%" includes 25%.
    expect(heatBucket(120, workday)).toBe(1);
    expect(heatBucket(121, workday)).toBe(2);
    // And at a workday length where a quarter is not a round number of hours.
    expect(heatBucket(105, workdayMinutes({ workdayStartMinutes: 540, workdayEndMinutes: 960 }))).toBe(1);
  });

  it('is inclusive at the half and three-quarter marks too', () => {
    expect(heatBucket(240, workday)).toBe(2);
    expect(heatBucket(241, workday)).toBe(3);
    expect(heatBucket(360, workday)).toBe(3);
    expect(heatBucket(361, workday)).toBe(4);
  });

  it('puts a full day and an overbooked one in the same top bucket', () => {
    // Exactly a workday, and half again as much: there is no darker square, and
    // §6.6's top bucket is open on purpose.
    expect(heatBucket(480, workday)).toBe(4);
    expect(heatBucket(720, workday)).toBe(4);
  });

  it('moves a day into a higher bucket when the workday shortens', () => {
    // 9–5 makes two hours a quarter of the day; 9–1 makes it a half.
    const short = workdayMinutes({ workdayStartMinutes: 540, workdayEndMinutes: 780 });
    expect(heatBucket(120, workday)).toBe(1);
    expect(heatBucket(120, short)).toBe(2);
  });

  it('counts a null duration as 30 minutes, the length the grid draws', () => {
    const heat = heatByDay([task('loose', { scheduledAt: at(2026, 8, 4, 9) })], []);
    expect(heat['2026-08-04'].minutes).toBe(30);
    expect(heatBucket(heat['2026-08-04'].minutes, workday)).toBe(1);
  });

  it('counts both contexts toward the heat and names only the current one', () => {
    const heat = heatByDay(
      [task('mine', { scheduledAt: at(2026, 8, 4, 14), durationMinutes: 60 })],
      [task('theirs', { scheduledAt: at(2026, 8, 4, 9), durationMinutes: 120 })],
    );

    expect(heat['2026-08-04'].minutes).toBe(180);
    expect(ids(heat['2026-08-04'].own)).toEqual(['mine']);
  });

  it('shows heat for a day whose only blocks belong to the other context', () => {
    const heat = heatByDay([], [task('theirs', { scheduledAt: at(2026, 8, 4, 9), durationMinutes: 120 })]);
    expect(heat['2026-08-04'].minutes).toBe(120);
    expect(heat['2026-08-04'].own).toEqual([]);
  });

  it('lists a day’s own tasks in start order and leaves empty days out', () => {
    const heat = heatByDay(
      [
        task('afternoon', { scheduledAt: at(2026, 8, 4, 14), durationMinutes: 60 }),
        task('morning', { scheduledAt: at(2026, 8, 4, 9), durationMinutes: 60 }),
        task('unscheduled'),
      ],
      [],
    );
    expect(ids(heat['2026-08-04'].own)).toEqual(['morning', 'afternoon']);
    expect(Object.keys(heat)).toEqual(['2026-08-04']);
  });
});
