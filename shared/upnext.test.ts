import { describe, expect, it } from 'vitest';
import type { Board, Context, Task } from './types';
import { UP_NEXT_LIMIT, dueMoment, effectiveDueMoment, upNext } from './upnext';

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
    accent: null,
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
    durationMinutes: null,
    scheduledAt: null,
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

describe('effectiveDueMoment', () => {
  it('is the plain due moment for an unflagged task', () => {
    expect(effectiveDueMoment(task({ dueDate: '2026-08-10', dueTime: '12:00' }))).toBe(
      local('2026-08-10', '12:00'),
    );
  });

  it('subtracts 24 hours for a priority-flagged task', () => {
    expect(
      effectiveDueMoment(task({ dueDate: '2026-08-10', dueTime: '12:00', priority: true })),
    ).toBe(local('2026-08-09', '12:00'));
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

  it('excludes a task that is neither dated nor scheduled today', () => {
    const dated = task({ id: 'dated', boardId: 'bp', dueDate: '2026-08-04' });
    const floating = task({ id: 'floating', boardId: 'bp' });
    expect(ids(run([floating, dated]))).toEqual(['dated']);
  });

  it('excludes completed tasks', () => {
    const open = task({ id: 'open', boardId: 'bp', dueDate: '2026-08-04' });
    const done = task({ id: 'done', boardId: 'bp', dueDate: '2026-08-04', completedAt: 5 });
    const doneToday = task({
      id: 'done-today',
      boardId: 'bp',
      scheduledAt: local('2026-08-03', '08:00'),
      completedAt: 5,
    });
    expect(ids(run([done, doneToday, open]))).toEqual(['open']);
  });

  it('excludes blocked tasks, scheduled or not', () => {
    const free = task({ id: 'free', boardId: 'bp', dueDate: '2026-08-04' });
    const stuck = task({ id: 'stuck', boardId: 'bp', dueDate: '2026-08-04', blocked: true });
    const stuckToday = task({
      id: 'stuck-today',
      boardId: 'bp',
      scheduledAt: local('2026-08-03', '10:00'),
      blocked: true,
    });
    expect(ids(run([stuck, stuckToday, free]))).toEqual(['free']);
  });

  it('excludes a task gated by an incomplete prerequisite', () => {
    const prerequisite = task({ id: 'pre', boardId: 'bp' });
    const gated = task({
      id: 'gated',
      boardId: 'bp',
      dueDate: '2026-08-04',
      dependsOn: 'pre',
    });
    const gatedButScheduled = task({
      id: 'gated-today',
      boardId: 'bp',
      scheduledAt: local('2026-08-03', '10:00'),
      dependsOn: 'pre',
    });
    expect(ids(run([prerequisite, gated, gatedButScheduled]))).toEqual([]);
  });

  it('excludes tasks on archived boards', () => {
    const live = task({ id: 'live', boardId: 'bp', dueDate: '2026-08-04' });
    const hidden = task({ id: 'hidden', boardId: 'ba', dueDate: '2026-08-04' });
    expect(ids(run([hidden, live]))).toEqual(['live']);
  });

  it('excludes the other context', () => {
    const mine = task({ id: 'mine', boardId: 'bp', dueDate: '2026-08-04' });
    const theirs = task({ id: 'theirs', boardId: 'bw', dueDate: '2026-08-04' });
    const theirBlock = task({
      id: 'their-block',
      boardId: 'bw',
      scheduledAt: local('2026-08-03', '10:00'),
    });
    expect(ids(run([mine, theirs, theirBlock]))).toEqual(['mine']);
    expect(ids(run([mine, theirs, theirBlock], 'work'))).toEqual(['their-block', 'theirs']);
  });

  it('excludes tasks whose board is not in the list at all', () => {
    const orphan = task({ id: 'orphan', boardId: 'gone', dueDate: '2026-08-04' });
    expect(ids(run([orphan]))).toEqual([]);
  });

  it('returns an empty array when nothing qualifies', () => {
    expect(run([])).toEqual([]);
  });
});

describe('upNext tiers', () => {
  const personal = board({ id: 'bp', context: 'personal' });

  function run(tasks: Task[]): Task[] {
    return upNext([personal], tasks, 'personal', NOW);
  }

  function due(
    id: string,
    dueDate: string,
    dueTime: string | null = null,
    rest: Partial<Task> = {},
  ): Task {
    return task({ id, boardId: 'bp', dueDate, dueTime, ...rest });
  }

  function at(id: string, time: string, rest: Partial<Task> = {}): Task {
    return task({ id, boardId: 'bp', scheduledAt: local('2026-08-03', time), ...rest });
  }

  /* --- tier 1 ------------------------------------------------------------- */

  it('puts overdue first, most overdue first', () => {
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

  it('ranks overdue ahead of something scheduled for this morning', () => {
    const overdue = due('overdue', '2026-08-02', '17:00');
    const scheduled = at('scheduled', '10:00');
    expect(ids(run([scheduled, overdue]))).toEqual(['overdue', 'scheduled']);
  });

  it('keeps an overdue task out of tier 2 even when it is scheduled today', () => {
    // A task appears in the first tier it qualifies for and never twice.
    const both = due('both', '2026-08-01', '09:00', {
      scheduledAt: local('2026-08-03', '23:00'),
    });
    const scheduled = at('scheduled', '08:00');
    const result = run([scheduled, both]);
    expect(ids(result)).toEqual(['both', 'scheduled']);
    expect(result.filter((t) => t.id === 'both')).toHaveLength(1);
  });

  it('treats a due moment exactly at `now` as not yet overdue', () => {
    const exactly = due('exactly', '2026-08-03', '09:00');
    const scheduled = at('scheduled', '14:00');
    // Tier 1 is "in the past", so a task due this very minute is tier 3.
    expect(ids(run([exactly, scheduled]))).toEqual(['scheduled', 'exactly']);
  });

  /* --- tier 2 ------------------------------------------------------------- */

  it('ranks a task scheduled today ahead of one merely due later today', () => {
    const scheduled = at('scheduled', '16:00');
    const dated = due('dated', '2026-08-03', '10:00');
    expect(ids(run([dated, scheduled]))).toEqual(['scheduled', 'dated']);
  });

  it('includes a scheduled task with no due date at all', () => {
    expect(ids(run([at('scheduled', '11:00')]))).toEqual(['scheduled']);
  });

  it('sorts tier 2 by start time, a passed start ahead of one still to come', () => {
    const early = at('early', '08:00');
    const later = at('later', '14:00');
    expect(ids(run([later, early]))).toEqual(['early', 'later']);
  });

  it('counts a block at either edge of the local day, and no other day', () => {
    const first = at('first', '00:00');
    const last = at('last', '23:45');
    const tomorrow = task({
      id: 'tomorrow',
      boardId: 'bp',
      scheduledAt: local('2026-08-04', '09:00'),
    });
    const yesterday = task({
      id: 'yesterday',
      boardId: 'bp',
      scheduledAt: local('2026-08-02', '09:00'),
    });
    expect(ids(run([tomorrow, last, yesterday, first]))).toEqual(['first', 'last']);
  });

  it('falls to tier 3 for a task scheduled another day but due at some point', () => {
    const tomorrowsBlock = due('tomorrow', '2026-08-09', null, {
      scheduledAt: local('2026-08-04', '09:00'),
    });
    const dated = due('dated', '2026-08-05');
    expect(ids(run([tomorrowsBlock, dated]))).toEqual(['dated', 'tomorrow']);
  });

  /* --- tier 3 ------------------------------------------------------------- */

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
});

describe('upNext priority bonus', () => {
  const personal = board({ id: 'bp', context: 'personal' });

  function run(tasks: Task[]): Task[] {
    return upNext([personal], tasks, 'personal', NOW);
  }

  function due(
    id: string,
    dueDate: string,
    dueTime: string | null = null,
    rest: Partial<Task> = {},
  ): Task {
    return task({ id, boardId: 'bp', dueDate, dueTime, ...rest });
  }

  it('changes the order for a flagged task due within a day of another', () => {
    const flagged = due('flagged', '2026-08-06', '09:00', { priority: true });
    const plain = due('plain', '2026-08-05', '12:00');
    // Flagged is due 21 hours later, so the 24-hour bonus pulls it ahead.
    expect(ids(run([plain, flagged]))).toEqual(['flagged', 'plain']);
    // ...and without the flag it would not be.
    expect(ids(run([plain, { ...flagged, priority: false }]))).toEqual(['plain', 'flagged']);
  });

  it('does not change the order for a flagged task due next month', () => {
    const flagged = due('flagged', '2026-09-10', '09:00', { priority: true });
    const plain = due('plain', '2026-08-05', '09:00');
    expect(ids(run([flagged, plain]))).toEqual(['plain', 'flagged']);
  });

  it('has no cliff — one day of bonus and nothing more', () => {
    const flagged = due('flagged', '2026-08-07', '09:00', { priority: true });
    const plain = due('plain', '2026-08-05', '08:00');
    // Due 49 hours apart: a day of bonus is not enough, and there is no rule
    // that promotes the flag past that.
    expect(ids(run([flagged, plain]))).toEqual(['plain', 'flagged']);
  });

  it('does not reorder tier 1 — overdue ranks by how overdue, flag or not', () => {
    const flagged = due('flagged', '2026-08-02', '09:00', { priority: true });
    const older = due('older', '2026-08-01', '09:00');
    expect(ids(run([flagged, older]))).toEqual(['older', 'flagged']);
  });

  it('does not pull a tier-3 task into tier 1 by making it look overdue', () => {
    // The bonus is a sort key, not a re-classification: a flagged task due in
    // twelve hours is still not overdue.
    const flagged = due('flagged', '2026-08-03', '21:00', { priority: true });
    const overdue = due('overdue', '2026-08-02', '09:00');
    const scheduled = task({
      id: 'scheduled',
      boardId: 'bp',
      scheduledAt: local('2026-08-03', '10:00'),
    });
    expect(ids(run([flagged, scheduled, overdue]))).toEqual([
      'overdue',
      'scheduled',
      'flagged',
    ]);
  });
});

describe('upNext ties', () => {
  const personal = board({ id: 'bp', context: 'personal' });

  function run(tasks: Task[]): Task[] {
    return upNext([personal], tasks, 'personal', NOW);
  }

  function due(
    id: string,
    dueDate: string,
    dueTime: string | null = null,
    rest: Partial<Task> = {},
  ): Task {
    return task({ id, boardId: 'bp', dueDate, dueTime, ...rest });
  }

  it('breaks a tie toward the higher difficulty', () => {
    const easy = due('easy', '2026-08-05', '12:00', { difficulty: 2 });
    const hard = due('hard', '2026-08-05', '12:00', { difficulty: 5 });
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

  it('breaks a tier-2 tie on difficulty then id, not on start time alone', () => {
    const start = local('2026-08-03', '11:00');
    const plain = task({ id: 'z', boardId: 'bp', scheduledAt: start });
    const harder = task({ id: 'a', boardId: 'bp', scheduledAt: start, difficulty: 5 });
    const alsoPlain = task({ id: 'a2', boardId: 'bp', scheduledAt: start });
    expect(ids(run([plain, alsoPlain, harder]))).toEqual(['a', 'a2', 'z']);
  });

  it('applies the whole chain in order within a tier', () => {
    const same = { dueDate: '2026-08-05', dueTime: '12:00' } as const;
    const tasks = [
      task({ id: 'z-plain-easy', boardId: 'bp', ...same, difficulty: 1 }),
      task({ id: 'a-plain-hard', boardId: 'bp', ...same, difficulty: 5 }),
      task({ id: 'm-prio-easy', boardId: 'bp', ...same, priority: true, difficulty: 1 }),
      task({ id: 'a-prio-hard', boardId: 'bp', ...same, priority: true, difficulty: 5 }),
      task({ id: 'b-prio-hard', boardId: 'bp', ...same, priority: true, difficulty: 5 }),
    ];
    // The flagged three share an effective moment 24 hours earlier than the
    // plain two, so they lead; within each group, difficulty then id.
    expect(ids(run(tasks))).toEqual([
      'a-prio-hard',
      'b-prio-hard',
      'm-prio-easy',
      'a-plain-hard',
      'z-plain-easy',
    ]);
  });

  it('is a total order — shuffling the input cannot change the result', () => {
    const pool = [
      due('a', '2026-08-01', '09:00'),
      due('b', '2026-08-01', '09:00', { difficulty: 5 }),
      task({ id: 'c', boardId: 'bp', scheduledAt: local('2026-08-03', '11:00') }),
      task({
        id: 'd',
        boardId: 'bp',
        scheduledAt: local('2026-08-03', '11:00'),
        difficulty: 4,
      }),
      due('e', '2026-08-09', '09:00'),
      due('f', '2026-08-09', '09:00', { priority: true }),
    ];
    const expected = ids(run(pool));
    expect(expected).toEqual(['b', 'a', 'd', 'c', 'f']);

    for (let shuffle = 0; shuffle < 25; shuffle += 1) {
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      expect(ids(run(shuffled))).toEqual(expected);
    }
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

  it('does not mutate or reorder the input array', () => {
    const tasks = [due('c', '2026-08-05'), due('a', '2026-08-04')];
    const before = ids(tasks);
    run(tasks);
    expect(ids(tasks)).toEqual(before);
  });
});
