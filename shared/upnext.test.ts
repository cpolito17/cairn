import { describe, expect, it } from 'vitest';
import type { Board, Context, Task } from './types';
import { UP_NEXT_LIMIT, dueMoment, upNext } from './upnext';

/** Local-time epoch ms, matching how `dueMoment` reads a date and time. */
function local(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

const NOW = local('2026-08-03', '09:00');

let seq = 0;

function board(overrides: Partial<Board> = {}): Board {
  seq += 1;
  return {
    id: `b${seq}`,
    context: 'personal',
    name: `board ${seq}`,
    description: null,
    position: `a${seq}`,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    boardId: 'b1',
    name: `task ${seq}`,
    notes: null,
    dueDate: null,
    dueTime: null,
    duration: null,
    difficulty: null,
    priority: false,
    blocked: false,
    dependsOn: null,
    position: `a${seq}`,
    createdAt: 0,
    completedAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

function ids(tasks: Task[]): string[] {
  return tasks.map((t) => t.id);
}

describe('dueMoment', () => {
  it('sorts an untimed task at the end of its day', () => {
    expect(dueMoment({ dueDate: '2026-08-03', dueTime: null })).toBe(local('2026-08-03', '23:59'));
  });

  it('sorts a timed task at its time', () => {
    expect(dueMoment({ dueDate: '2026-08-03', dueTime: '15:00' })).toBe(
      local('2026-08-03', '15:00'),
    );
  });
});

describe('upNext selection', () => {
  const personal = board({ id: 'bp', context: 'personal' });
  const work = board({ id: 'bw', context: 'work' });
  const archived = board({ id: 'ba', context: 'personal', archivedAt: 1000 });
  const boards = [personal, work, archived];

  function run(tasks: Task[], context: Context = 'personal'): Task[] {
    return upNext(boards, tasks, context, NOW);
  }

  it('excludes tasks with no due date', () => {
    const dated = task({ id: 'dated', boardId: 'bp', dueDate: '2026-08-04' });
    const undated = task({ id: 'undated', boardId: 'bp' });
    expect(ids(run([undated, dated]))).toEqual(['dated']);
  });

  it('excludes completed tasks', () => {
    const open = task({ id: 'open', boardId: 'bp', dueDate: '2026-08-04' });
    const done = task({ id: 'done', boardId: 'bp', dueDate: '2026-08-04', completedAt: 5 });
    expect(ids(run([done, open]))).toEqual(['open']);
  });

  it('excludes blocked tasks', () => {
    const free = task({ id: 'free', boardId: 'bp', dueDate: '2026-08-04' });
    const stuck = task({ id: 'stuck', boardId: 'bp', dueDate: '2026-08-04', blocked: true });
    expect(ids(run([stuck, free]))).toEqual(['free']);
  });

  it('excludes tasks on archived boards', () => {
    const live = task({ id: 'live', boardId: 'bp', dueDate: '2026-08-04' });
    const hidden = task({ id: 'hidden', boardId: 'ba', dueDate: '2026-08-04' });
    expect(ids(run([hidden, live]))).toEqual(['live']);
  });

  it('excludes the other context', () => {
    const mine = task({ id: 'mine', boardId: 'bp', dueDate: '2026-08-04' });
    const theirs = task({ id: 'theirs', boardId: 'bw', dueDate: '2026-08-04' });
    expect(ids(run([mine, theirs]))).toEqual(['mine']);
    expect(ids(run([mine, theirs], 'work'))).toEqual(['theirs']);
  });

  it('excludes tasks whose board is not in the list at all', () => {
    const orphan = task({ id: 'orphan', boardId: 'gone', dueDate: '2026-08-04' });
    expect(ids(run([orphan]))).toEqual([]);
  });

  it('returns an empty array when nothing qualifies', () => {
    expect(run([])).toEqual([]);
  });
});

describe('upNext ordering', () => {
  const personal = board({ id: 'bp', context: 'personal' });

  function run(tasks: Task[]): Task[] {
    return upNext([personal], tasks, 'personal', NOW);
  }

  function due(id: string, dueDate: string, dueTime: string | null = null, rest: Partial<Task> = {}) {
    return task({ id, boardId: 'bp', dueDate, dueTime, ...rest });
  }

  it('puts overdue tasks ahead of everything, most overdue first', () => {
    const soon = due('soon', '2026-08-03', '10:00');
    const later = due('later', '2026-08-10');
    const overdueByOne = due('overdue-1d', '2026-08-02', '08:00');
    const overdueByThree = due('overdue-3d', '2026-07-31', '08:00');

    expect(ids(run([later, soon, overdueByOne, overdueByThree]))).toEqual([
      'overdue-3d',
      'overdue-1d',
      'soon',
      'later',
    ]);
  });

  it('sorts a 3:00 PM task before an untimed task on the same day', () => {
    const timed = due('timed', '2026-08-05', '15:00');
    const untimed = due('untimed', '2026-08-05');
    expect(ids(run([untimed, timed]))).toEqual(['timed', 'untimed']);
  });

  it('sorts an untimed task before anything on the following day', () => {
    const untimed = due('untimed', '2026-08-05');
    const nextMorning = due('next', '2026-08-06', '00:30');
    expect(ids(run([nextMorning, untimed]))).toEqual(['untimed', 'next']);
  });

  it('breaks a tie toward the priority-flagged task', () => {
    const plain = due('plain', '2026-08-05', '12:00');
    const flagged = due('flagged', '2026-08-05', '12:00', { priority: true });
    expect(ids(run([plain, flagged]))).toEqual(['flagged', 'plain']);
  });

  it('breaks a priority tie toward the higher difficulty', () => {
    const easy = due('easy', '2026-08-05', '12:00', { priority: true, difficulty: 2 });
    const hard = due('hard', '2026-08-05', '12:00', { priority: true, difficulty: 5 });
    expect(ids(run([easy, hard]))).toEqual(['hard', 'easy']);
  });

  it('weighs an unset difficulty as the midpoint 3 in the tie-break', () => {
    const unset = due('unset', '2026-08-05', '12:00');
    const four = due('four', '2026-08-05', '12:00', { difficulty: 4 });
    const two = due('two', '2026-08-05', '12:00', { difficulty: 2 });
    expect(ids(run([two, unset, four]))).toEqual(['four', 'unset', 'two']);
  });

  it('breaks a difficulty tie toward the lower id, not input order', () => {
    const b = due('b-second', '2026-08-05', '12:00');
    const a = due('a-first', '2026-08-05', '12:00');
    expect(ids(run([b, a]))).toEqual(['a-first', 'b-second']);
    expect(ids(run([a, b]))).toEqual(['a-first', 'b-second']);
  });

  it('applies the whole tie-break chain in order', () => {
    const same = { dueDate: '2026-08-05', dueTime: '12:00' } as const;
    const tasks = [
      task({ id: 'z-plain-easy', boardId: 'bp', ...same, difficulty: 1 }),
      task({ id: 'a-plain-hard', boardId: 'bp', ...same, difficulty: 5 }),
      task({ id: 'm-prio-easy', boardId: 'bp', ...same, priority: true, difficulty: 1 }),
      task({ id: 'a-prio-hard', boardId: 'bp', ...same, priority: true, difficulty: 5 }),
      task({ id: 'b-prio-hard', boardId: 'bp', ...same, priority: true, difficulty: 5 }),
    ];
    expect(ids(run(tasks))).toEqual([
      'a-prio-hard',
      'b-prio-hard',
      'm-prio-easy',
      'a-plain-hard',
      'z-plain-easy',
    ]);
  });

  it('caps at five', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      due(`t${i}`, `2026-08-${String(10 + i).padStart(2, '0')}`),
    );
    const result = run([...many].reverse());
    expect(result).toHaveLength(UP_NEXT_LIMIT);
    expect(UP_NEXT_LIMIT).toBe(5);
    expect(ids(result)).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('returns an identical array across repeated calls on identical input', () => {
    const tasks = [
      due('c', '2026-08-05', '12:00'),
      due('a', '2026-08-05', '12:00'),
      due('b', '2026-08-05', '12:00'),
      due('d', '2026-08-01'),
      due('e', '2026-08-05', '09:00', { priority: true }),
    ];
    const first = ids(run(tasks));
    for (let i = 0; i < 5; i++) expect(ids(run(tasks))).toEqual(first);
    // ...and independent of the order the caller happened to hold them in.
    expect(ids(run([...tasks].reverse()))).toEqual(first);
  });

  it('does not mutate or reorder the input array', () => {
    const tasks = [due('c', '2026-08-05'), due('a', '2026-08-04')];
    const before = ids(tasks);
    run(tasks);
    expect(ids(tasks)).toEqual(before);
  });

  it('reads only the injected `now`, never the clock', () => {
    const past = due('past', '2026-08-01');
    const future = due('future', '2026-09-01');
    // Both orderings are the same regardless of `now`, which is the point:
    // `now` decides what counts as overdue, not what the sort compares.
    const early = upNext([personal], [future, past], 'personal', local('2026-07-01', '00:00'));
    const late = upNext([personal], [future, past], 'personal', local('2027-01-01', '00:00'));
    expect(ids(early)).toEqual(['past', 'future']);
    expect(ids(late)).toEqual(['past', 'future']);
  });
});
