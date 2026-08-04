import { describe, expect, it } from 'vitest';
import { blockedBy, canDependOn, dependencyOptions, isGated, lookupOf } from './dependencies';
import type { Task } from './types';

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

describe('blockedBy', () => {
  it('is null when the task waits on nothing', () => {
    const a = task();
    expect(blockedBy(a, lookupOf([a]))).toBeNull();
  });

  it('returns the prerequisite while it is incomplete', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: 'a' });
    expect(blockedBy(b, lookupOf([a, b]))?.id).toBe('a');
    expect(isGated(b, lookupOf([a, b]))).toBe(true);
  });

  it('releases the dependent the moment the prerequisite completes', () => {
    const a = task({ id: 'a', completedAt: 1 });
    const b = task({ id: 'b', dependsOn: 'a' });
    expect(blockedBy(b, lookupOf([a, b]))).toBeNull();
    expect(isGated(b, lookupOf([a, b]))).toBe(false);
  });

  it('releases the dependent when the prerequisite no longer exists', () => {
    // ON DELETE SET NULL is the durable form of this; a client holding a stale
    // row must not stay stuck on a task that is gone.
    const b = task({ id: 'b', dependsOn: 'gone' });
    expect(blockedBy(b, lookupOf([b]))).toBeNull();
  });
});

describe('canDependOn', () => {
  it('refuses a task depending on itself', () => {
    const a = task({ id: 'a' });
    expect(canDependOn(a, a, lookupOf([a]))).toBe(false);
  });

  it('refuses a prerequisite on another board', () => {
    const a = task({ id: 'a', boardId: 'b2' });
    const b = task({ id: 'b', boardId: 'b1' });
    expect(canDependOn(b, a, lookupOf([a, b]))).toBe(false);
  });

  it('allows a plain link between two tasks on one board', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    expect(canDependOn(b, a, lookupOf([a, b]))).toBe(true);
  });

  it('refuses a direct cycle', () => {
    const a = task({ id: 'a', dependsOn: 'b' });
    const b = task({ id: 'b' });
    expect(canDependOn(b, a, lookupOf([a, b]))).toBe(false);
  });

  it('refuses a cycle through a chain', () => {
    // c → b → a already; a may not then wait on c.
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: 'a' });
    const c = task({ id: 'c', dependsOn: 'b' });
    expect(canDependOn(a, c, lookupOf([a, b, c]))).toBe(false);
  });

  it('allows a longer chain that does not close', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: 'a' });
    const c = task({ id: 'c' });
    expect(canDependOn(c, b, lookupOf([a, b, c]))).toBe(true);
  });

  it('terminates on a cycle already present in the data, and refuses to join it', () => {
    // Corrupt state the UI cannot produce, but the walk still has to end. It
    // refuses rather than returning true: attaching to a chain that already
    // loops would gate the new task forever.
    const a = task({ id: 'a', dependsOn: 'b' });
    const b = task({ id: 'b', dependsOn: 'a' });
    const c = task({ id: 'c' });
    expect(canDependOn(c, a, lookupOf([a, b, c]))).toBe(false);
    expect(canDependOn(a, b, lookupOf([a, b, c]))).toBe(false);
  });
});

describe('dependencyOptions', () => {
  it('offers every legal prerequisite and nothing else', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: 'a' });
    const elsewhere = task({ id: 'x', boardId: 'b2' });
    const options = dependencyOptions(a, [a, b, elsewhere], lookupOf([a, b, elsewhere]));
    // Not itself, not the task already waiting on it, not another board's.
    expect(options).toEqual([]);

    const c = task({ id: 'c' });
    const forC = dependencyOptions(c, [a, b, c, elsewhere], lookupOf([a, b, c, elsewhere]));
    expect(forC.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('keeps completed tasks as options', () => {
    const done = task({ id: 'done', completedAt: 5 });
    const c = task({ id: 'c' });
    const options = dependencyOptions(c, [done], lookupOf([done, c]));
    expect(options.map((t) => t.id)).toEqual(['done']);
  });
});
