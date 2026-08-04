import { describe, expect, it } from 'vitest';
import { boardProgress } from './progress';
import type { Difficulty, Task } from './types';

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
    dependsOn: null,
    position: `a${seq}`,
    createdAt: 0,
    completedAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

/** `n` tasks of the given difficulty, the first `done` of them complete. */
function tasks(n: number, done: number, difficulty: Difficulty | null): Task[] {
  return Array.from({ length: n }, (_, i) =>
    task({ difficulty, completedAt: i < done ? 1000 : null }),
  );
}

describe('boardProgress', () => {
  it('reads 0% on an empty board, not 100%', () => {
    expect(boardProgress([])).toEqual({ percent: 0, done: 0, total: 0 });
  });

  it('collapses to the plain count ratio when no difficulty is set anywhere', () => {
    // The whole reason unset weighs 3: with no difficulties assigned, every
    // task weighs the same and the weighted model must agree exactly with
    // completed/total for every count, not just the round ones.
    for (let total = 1; total <= 12; total++) {
      for (let done = 0; done <= total; done++) {
        expect(boardProgress(tasks(total, done, null))).toEqual({
          percent: Math.round((done / total) * 100),
          done,
          total,
        });
      }
    }
  });

  it('agrees with the count ratio when every task shares one set difficulty', () => {
    for (const difficulty of [1, 2, 3, 4, 5] as const) {
      expect(boardProgress(tasks(3, 1, difficulty)).percent).toBe(33);
    }
  });

  it('weights a task with no difficulty as 3 alongside ones that have it', () => {
    // Weights 5 (done) + 3 (unset, open) + 1 (open) = 9 total, 5 complete.
    const mixed = [
      task({ difficulty: 5, completedAt: 1000 }),
      task({ difficulty: null }),
      task({ difficulty: 1 }),
    ];
    expect(boardProgress(mixed)).toEqual({ percent: 56, done: 1, total: 3 });
  });

  it('lets a hard task outweigh several easy ones', () => {
    // One difficulty-5 task complete against four difficulty-1 tasks open:
    // 5/9 = 56%, well above the 1-of-5 = 20% the count ratio would report.
    const board = [
      task({ difficulty: 5, completedAt: 1000 }),
      ...tasks(4, 0, 1),
    ];
    const progress = boardProgress(board);
    expect(progress.percent).toBe(56);
    expect(progress).toMatchObject({ done: 1, total: 5 });
  });

  it('reads 100 when every task is complete', () => {
    const board = [
      task({ difficulty: 1, completedAt: 1000 }),
      task({ difficulty: null, completedAt: 1000 }),
      task({ difficulty: 5, completedAt: 1000 }),
    ];
    expect(boardProgress(board)).toEqual({ percent: 100, done: 3, total: 3 });
  });

  it('reads 0 when nothing is complete', () => {
    expect(boardProgress(tasks(4, 0, null))).toEqual({ percent: 0, done: 0, total: 4 });
  });

  it('counts blocked tasks like any other — blocking is an Up Next rule, not a progress one', () => {
    const board = [task({ blocked: true, completedAt: 1000 }), task({ blocked: true })];
    expect(boardProgress(board)).toEqual({ percent: 50, done: 1, total: 2 });
  });

  it('rounds to a whole number', () => {
    // 1 of 3 unset-difficulty tasks: 33.33… → 33.
    expect(boardProgress(tasks(3, 1, null)).percent).toBe(33);
    // 2 of 3: 66.67… → 67.
    expect(boardProgress(tasks(3, 2, null)).percent).toBe(67);
  });
});
