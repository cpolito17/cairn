import { describe, expect, it } from 'vitest';
import type { Board, Context, Task } from './types';
import {
  UP_NEXT_LIMIT,
  UP_NEXT_MAX_ROWS,
  blockingCounts,
  dueMoment,
  effectiveDueMoment,
  overdueTasks,
  upNext,
} from './upnext';

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
    dependsOn: [],
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

  it('includes a task that is neither dated nor scheduled, below the dated one', () => {
    // This used to be an exclusion. A date is evidence of urgency; its absence
    // is not evidence of unimportance, and dropping the undated majority made
    // the strip answer "what is due?" while claiming to answer "what now?".
    const dated = task({ id: 'dated', boardId: 'bp', dueDate: '2026-08-04' });
    const floating = task({ id: 'floating', boardId: 'bp' });
    expect(ids(run([floating, dated]))).toEqual(['dated', 'floating']);
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
      dependsOn: ['pre'],
    });
    const gatedButScheduled = task({
      id: 'gated-today',
      boardId: 'bp',
      scheduledAt: local('2026-08-03', '10:00'),
      dependsOn: ['pre'],
    });
    // Both gated tasks stay out — neither can be done now, whatever their date
    // says. The prerequisite itself is now *in*, as tier 4: it is undated, so
    // it used to be dropped, and it is the one task here that can actually be
    // picked up — and doing so releases the other two.
    expect(ids(run([prerequisite, gated, gatedButScheduled]))).toEqual(['pre']);
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
    // The other two blocks are on other days, so they miss tier 2 — but they
    // are still open tasks, so they land in tier 5 behind everything. What this
    // asserts is the tier boundary: only today's blocks come first.
    expect(ids(run([tomorrow, last, yesterday, first])).slice(0, 2)).toEqual([
      'first',
      'last',
    ]);
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

/**
 * The Overdue Audit's list.
 *
 * Its contract is narrower than it looks: not "everything with a date in the
 * past", but "everything the strip would rank in tier 1". Those differ exactly
 * where triage has already happened, and that difference is the whole feature —
 * a task you marked blocked yesterday must not be offered again today.
 */
describe('overdueTasks', () => {
  const personal = board({ id: 'op', context: 'personal' });
  const work = board({ id: 'ow', context: 'work' });
  const archived = board({ id: 'oa', context: 'personal', archivedAt: 1000 });
  const boards = [personal, work, archived];

  function run(tasks: Task[], context: Context = 'personal'): Task[] {
    return overdueTasks(boards, tasks, context, NOW);
  }

  it('is empty when nothing is late', () => {
    const soon = task({ boardId: 'op', dueDate: '2026-08-04' });
    expect(run([soon])).toEqual([]);
  });

  it('lists overdue tasks most overdue first', () => {
    const yesterday = task({ id: 'yesterday', boardId: 'op', dueDate: '2026-08-02' });
    const lastWeek = task({ id: 'lastWeek', boardId: 'op', dueDate: '2026-07-27' });
    const thisMorning = task({
      id: 'thisMorning',
      boardId: 'op',
      dueDate: '2026-08-03',
      dueTime: '08:00',
    });
    expect(ids(run([yesterday, thisMorning, lastWeek]))).toEqual([
      'lastWeek',
      'yesterday',
      'thisMorning',
    ]);
  });

  it('treats an undated-time task as due at the end of its day', () => {
    // Due today with no time is due 23:59, which at 09:00 is not yet overdue.
    const today = task({ id: 'today', boardId: 'op', dueDate: '2026-08-03' });
    expect(run([today])).toEqual([]);
  });

  it('excludes what has already been triaged — blocked and gated', () => {
    const late = task({ id: 'late', boardId: 'op', dueDate: '2026-08-01' });
    const blocked = task({
      id: 'blocked',
      boardId: 'op',
      dueDate: '2026-08-01',
      blocked: true,
    });
    const prerequisite = task({ id: 'prerequisite', boardId: 'op' });
    const gated = task({
      id: 'gated',
      boardId: 'op',
      dueDate: '2026-08-01',
      dependsOn: ['prerequisite'],
    });

    expect(ids(run([late, blocked, prerequisite, gated]))).toEqual(['late']);
  });

  it('excludes completed tasks, other contexts, and archived boards', () => {
    const mine = task({ id: 'mine', boardId: 'op', dueDate: '2026-08-01' });
    const done = task({
      id: 'done',
      boardId: 'op',
      dueDate: '2026-08-01',
      completedAt: NOW,
    });
    const theirs = task({ id: 'theirs', boardId: 'ow', dueDate: '2026-08-01' });
    const shelved = task({ id: 'shelved', boardId: 'oa', dueDate: '2026-08-01' });

    expect(ids(run([mine, done, theirs, shelved]))).toEqual(['mine']);
    expect(ids(run([mine, theirs], 'work'))).toEqual(['theirs']);
  });

  it('is uncapped, unlike the strip', () => {
    const many = Array.from({ length: UP_NEXT_LIMIT * 3, }, (_, index) =>
      task({ id: `late${index}`, boardId: 'op', dueDate: '2026-08-01' }),
    );
    expect(run(many)).toHaveLength(UP_NEXT_LIMIT * 3);
    expect(upNext(boards, many, 'personal', NOW)).toHaveLength(UP_NEXT_LIMIT);
  });

  it('agrees with the strip: everything it lists is what upNext ranks first', () => {
    const late = task({ id: 'late', boardId: 'op', dueDate: '2026-08-01' });
    const later = task({ id: 'later', boardId: 'op', dueDate: '2026-08-02' });
    const upcoming = task({ id: 'upcoming', boardId: 'op', dueDate: '2026-08-09' });

    const audit = ids(run([upcoming, later, late]));
    const strip = ids(upNext(boards, [upcoming, later, late], 'personal', NOW));
    expect(audit).toEqual(['late', 'later']);
    expect(strip.slice(0, audit.length)).toEqual(audit);
  });
});

/** The row cap the strip may be grown to (§6.7's five, up to three times). */
describe('upNext limit', () => {
  const personal = board({ id: 'lp', context: 'personal' });

  it('defaults to five and honours a wider limit', () => {
    const tasks = Array.from({ length: 20 }, (_, index) =>
      task({ id: `t${index}`, boardId: 'lp', dueDate: '2026-08-04' }),
    );
    expect(upNext([personal], tasks, 'personal', NOW)).toHaveLength(UP_NEXT_LIMIT);
    expect(
      upNext([personal], tasks, 'personal', NOW, UP_NEXT_LIMIT * UP_NEXT_MAX_ROWS),
    ).toHaveLength(UP_NEXT_LIMIT * UP_NEXT_MAX_ROWS);
  });

  it('grows the strip by revealing what was already next, in order', () => {
    const tasks = Array.from({ length: 12 }, (_, index) =>
      task({ id: `g${index}`, boardId: 'lp', dueDate: '2026-08-04' }),
    );
    const oneRow = ids(upNext([personal], tasks, 'personal', NOW));
    const three = ids(upNext([personal], tasks, 'personal', NOW, UP_NEXT_LIMIT * 3));
    // The first row is untouched by growing — a wider strip must never reorder
    // what is already on screen.
    expect(three.slice(0, UP_NEXT_LIMIT)).toEqual(oneRow);
  });

  it('caps at what actually qualifies rather than padding', () => {
    const tasks = [
      task({ id: 'a', boardId: 'lp', dueDate: '2026-08-04' }),
      task({ id: 'b', boardId: 'lp', dueDate: '2026-08-05' }),
    ];
    expect(upNext([personal], tasks, 'personal', NOW, 15)).toHaveLength(2);
  });
});

/**
 * Tiers 4 and 5 — the bottleneck tier and the remainder.
 *
 * These are what turned Up Next from a shortlist of dated work into a ranking
 * of everything open. The dated tiers above are unchanged and still win, so the
 * cases that matter here are the boundary (a dated blocker stays in tier 3) and
 * the ordering inside tier 4 (most-depended-on first).
 */
describe('upNext tiers 4 and 5', () => {
  const personal = board({ id: 'bt', context: 'personal' });

  function run(tasks: Task[]): Task[] {
    return upNext([personal], tasks, 'personal', NOW, 50);
  }

  it('ranks an undated blocker above the undated remainder', () => {
    const blocker = task({ id: 'blocker', boardId: 'bt' });
    const waiting = task({ id: 'waiting', boardId: 'bt', dependsOn: ['blocker'] });
    const loose = task({ id: 'loose', boardId: 'bt' });

    // `waiting` is gated, so it is not offered; `blocker` is what to do about it.
    expect(ids(run([loose, waiting, blocker]))).toEqual(['blocker', 'loose']);
  });

  it('sorts tier 4 by how much it is holding up, most first', () => {
    const one = task({ id: 'one', boardId: 'bt' });
    const three = task({ id: 'three', boardId: 'bt' });
    const waitingOnOne = task({ id: 'w1', boardId: 'bt', dependsOn: ['one'] });
    const a = task({ id: 'a', boardId: 'bt', dependsOn: ['three'] });
    const b = task({ id: 'b', boardId: 'bt', dependsOn: ['three'] });
    const c = task({ id: 'c', boardId: 'bt', dependsOn: ['three'] });

    expect(ids(run([one, three, waitingOnOne, a, b, c]))).toEqual(['three', 'one']);
  });

  it('does not count completed dependents — a released prerequisite is not a bottleneck', () => {
    const stale = task({ id: 'stale', boardId: 'bt' });
    const finished = task({
      id: 'finished',
      boardId: 'bt',
      dependsOn: ['stale'],
      completedAt: NOW,
    });
    const live = task({ id: 'live', boardId: 'bt' });
    const waiting = task({ id: 'waiting', boardId: 'bt', dependsOn: ['live'] });

    // `stale` blocks only a finished task, so it drops to tier 5 behind `live`.
    expect(ids(run([stale, finished, live, waiting]))).toEqual(['live', 'stale']);
  });

  it('keeps a dated blocker in tier 3 — first tier it qualifies for, never twice', () => {
    const datedBlocker = task({
      id: 'datedBlocker',
      boardId: 'bt',
      dueDate: '2026-08-20',
    });
    const waiting = task({ id: 'waiting', boardId: 'bt', dependsOn: ['datedBlocker'] });
    const undatedBlocker = task({ id: 'undatedBlocker', boardId: 'bt' });
    const alsoWaiting = task({
      id: 'alsoWaiting',
      boardId: 'bt',
      dependsOn: ['undatedBlocker'],
    });

    // Due in three weeks, but tier 3 still outranks tier 4 — a date is a
    // commitment and the ranking never sinks one below something without.
    expect(ids(run([undatedBlocker, alsoWaiting, datedBlocker, waiting]))).toEqual([
      'datedBlocker',
      'undatedBlocker',
    ]);
  });

  it('breaks tier 5 ties toward the higher difficulty, then the lower id', () => {
    const easy = task({ id: 'a-easy', boardId: 'bt', difficulty: 1 });
    const hard = task({ id: 'z-hard', boardId: 'bt', difficulty: 5 });
    const unset = task({ id: 'm-unset', boardId: 'bt' });

    // Unset weighs the midpoint 3, as it does everywhere else.
    expect(ids(run([easy, unset, hard]))).toEqual(['z-hard', 'm-unset', 'a-easy']);
  });

  it('still excludes what cannot be picked up, however it would have been tiered', () => {
    const blocked = task({ id: 'blocked', boardId: 'bt', blocked: true });
    const done = task({ id: 'done', boardId: 'bt', completedAt: NOW });
    const open = task({ id: 'open', boardId: 'bt' });

    expect(ids(run([blocked, done, open]))).toEqual(['open']);
  });

  it('ranks the whole open board, so the strip length is the only cap', () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      task({ id: `bulk${String(index).padStart(2, '0')}`, boardId: 'bt' }),
    );
    expect(run(many)).toHaveLength(40);
    // The strip itself still shows only what its rows allow.
    expect(upNext([personal], many, 'personal', NOW)).toHaveLength(UP_NEXT_LIMIT);
    expect(
      upNext([personal], many, 'personal', NOW, UP_NEXT_LIMIT * UP_NEXT_MAX_ROWS),
    ).toHaveLength(UP_NEXT_LIMIT * UP_NEXT_MAX_ROWS);
  });
});

describe('blockingCounts', () => {
  it('counts incomplete dependents per prerequisite', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: ['a'] });
    const c = task({ id: 'c', dependsOn: ['a'] });
    const counts = blockingCounts([a, b, c]);
    expect(counts.get('a')).toBe(2);
    expect(counts.has('b')).toBe(false);
  });

  it('ignores links held by a completed dependent', () => {
    const a = task({ id: 'a' });
    const done = task({ id: 'done', dependsOn: ['a'], completedAt: 1 });
    expect(blockingCounts([a, done]).has('a')).toBe(false);
  });

  it('counts each prerequisite of a task with several', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const c = task({ id: 'c', dependsOn: ['a', 'b'] });
    const counts = blockingCounts([a, b, c]);
    expect(counts.get('a')).toBe(1);
    expect(counts.get('b')).toBe(1);
  });
});
