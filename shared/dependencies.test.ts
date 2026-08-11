import { describe, expect, it } from 'vitest';
import {
  blockedBy,
  blockedByCount,
  canDependOn,
  dependencyOptions,
  firstBlocker,
  isGated,
  lookupOf,
  normalizeDependsOn,
} from './dependencies';
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

const ids = (tasks: Task[]) => tasks.map((t) => t.id);

describe('blockedBy', () => {
  it('is empty when the task waits on nothing', () => {
    const a = task();
    expect(blockedBy(a, lookupOf([a]))).toEqual([]);
    expect(isGated(a, lookupOf([a]))).toBe(false);
  });

  it('returns the prerequisite while it is incomplete', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: ['a'] });
    expect(ids(blockedBy(b, lookupOf([a, b])))).toEqual(['a']);
    expect(isGated(b, lookupOf([a, b]))).toBe(true);
  });

  it('returns every outstanding prerequisite, in link order', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const c = task({ id: 'c', dependsOn: ['a', 'b'] });
    expect(ids(blockedBy(c, lookupOf([a, b, c])))).toEqual(['a', 'b']);
    expect(blockedByCount(c, lookupOf([a, b, c]))).toBe(2);
  });

  it('stays gated while any one prerequisite is outstanding', () => {
    // The whole point of the set: finishing two of three releases nothing.
    const a = task({ id: 'a', completedAt: 1 });
    const b = task({ id: 'b', completedAt: 1 });
    const c = task({ id: 'c' });
    const d = task({ id: 'd', dependsOn: ['a', 'b', 'c'] });
    const lookup = lookupOf([a, b, c, d]);
    expect(isGated(d, lookup)).toBe(true);
    expect(ids(blockedBy(d, lookup))).toEqual(['c']);
    expect(firstBlocker(d, lookup)?.id).toBe('c');
  });

  it('releases the dependent once the last prerequisite completes', () => {
    const a = task({ id: 'a', completedAt: 1 });
    const b = task({ id: 'b', completedAt: 2 });
    const c = task({ id: 'c', dependsOn: ['a', 'b'] });
    expect(blockedBy(c, lookupOf([a, b, c]))).toEqual([]);
    expect(isGated(c, lookupOf([a, b, c]))).toBe(false);
    expect(firstBlocker(c, lookupOf([a, b, c]))).toBeNull();
  });

  it('ignores a prerequisite that no longer exists', () => {
    // The join table cascades on delete; a client holding a stale row must not
    // stay stuck on a task that is gone.
    const b = task({ id: 'b', dependsOn: ['gone'] });
    expect(blockedBy(b, lookupOf([b]))).toEqual([]);
  });

  it('ignores missing links without dropping the real ones beside them', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: ['gone', 'a'] });
    expect(ids(blockedBy(b, lookupOf([a, b])))).toEqual(['a']);
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

  it('allows a second, unrelated prerequisite', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const c = task({ id: 'c', dependsOn: ['a'] });
    expect(canDependOn(c, b, lookupOf([a, b, c]))).toBe(true);
  });

  it('refuses a prerequisite that is already linked', () => {
    const a = task({ id: 'a' });
    const c = task({ id: 'c', dependsOn: ['a'] });
    expect(canDependOn(c, a, lookupOf([a, c]))).toBe(false);
  });

  it('refuses a direct cycle', () => {
    const a = task({ id: 'a', dependsOn: ['b'] });
    const b = task({ id: 'b' });
    expect(canDependOn(b, a, lookupOf([a, b]))).toBe(false);
  });

  it('refuses a cycle through a chain', () => {
    // c → b → a already; a may not then wait on c.
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: ['a'] });
    const c = task({ id: 'c', dependsOn: ['b'] });
    expect(canDependOn(a, c, lookupOf([a, b, c]))).toBe(false);
  });

  it('refuses a cycle reachable through only one of several branches', () => {
    // The case a chain walk could not see: `d` waits on `x` and on `c`, and
    // only the `c` branch leads back to `a`. Following one link would have
    // missed it and stored a loop.
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: ['a'] });
    const c = task({ id: 'c', dependsOn: ['b'] });
    const x = task({ id: 'x' });
    const d = task({ id: 'd', dependsOn: ['x', 'c'] });
    expect(canDependOn(a, d, lookupOf([a, b, c, d, x]))).toBe(false);
  });

  it('allows a diamond, which is not a cycle', () => {
    // a → b, a → c, and d waiting on both b and c. Two paths to the same
    // ancestor is the shape multiple prerequisites exist for.
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: ['a'] });
    const c = task({ id: 'c', dependsOn: ['a'] });
    const d = task({ id: 'd', dependsOn: ['b'] });
    expect(canDependOn(d, c, lookupOf([a, b, c, d]))).toBe(true);
  });

  it('allows a longer chain that does not close', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: ['a'] });
    const c = task({ id: 'c' });
    expect(canDependOn(c, b, lookupOf([a, b, c]))).toBe(true);
  });

  it('terminates on a cycle already present in the data, and refuses to join it', () => {
    // Corrupt state the UI cannot produce, but the search still has to end. It
    // refuses rather than returning true: attaching to a chain that already
    // loops would gate the new task forever.
    const a = task({ id: 'a', dependsOn: ['b'] });
    const b = task({ id: 'b', dependsOn: ['a'] });
    const c = task({ id: 'c' });
    expect(canDependOn(c, a, lookupOf([a, b, c]))).toBe(false);
    expect(canDependOn(a, b, lookupOf([a, b, c]))).toBe(false);
  });

  it('terminates on a wide graph without revisiting shared ancestors', () => {
    // A fan-in of a few hundred edges converging on one root: the `seen` set is
    // what keeps this from being exponential in the number of paths.
    const root = task({ id: 'root' });
    const middle = Array.from({ length: 200 }, (_, i) =>
      task({ id: `m${i}`, dependsOn: ['root'] }),
    );
    const sink = task({ id: 'sink', dependsOn: middle.map((m) => m.id) });
    const lookup = lookupOf([root, ...middle, sink]);
    expect(canDependOn(root, sink, lookup)).toBe(false);
    expect(canDependOn(task({ id: 'fresh' }), sink, lookup)).toBe(true);
  });
});

describe('dependencyOptions', () => {
  it('offers every legal prerequisite and nothing else', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b', dependsOn: ['a'] });
    const elsewhere = task({ id: 'x', boardId: 'b2' });
    const options = dependencyOptions(a, [a, b, elsewhere], lookupOf([a, b, elsewhere]));
    // Not itself, not the task already waiting on it, not another board's.
    expect(options).toEqual([]);

    const c = task({ id: 'c' });
    const forC = dependencyOptions(c, [a, b, c, elsewhere], lookupOf([a, b, c, elsewhere]));
    expect(ids(forC)).toEqual(['a', 'b']);
  });

  it('drops prerequisites the task already has', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const c = task({ id: 'c', dependsOn: ['a'] });
    expect(ids(dependencyOptions(c, [a, b], lookupOf([a, b, c])))).toEqual(['b']);
  });

  it('keeps completed tasks as options', () => {
    const done = task({ id: 'done', completedAt: 5 });
    const c = task({ id: 'c' });
    const options = dependencyOptions(c, [done], lookupOf([done, c]));
    expect(ids(options)).toEqual(['done']);
  });
});

describe('normalizeDependsOn', () => {
  it('drops duplicates and self-links, keeping order', () => {
    expect(normalizeDependsOn('me', ['a', 'b', 'a', 'me', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('leaves a clean list alone', () => {
    expect(normalizeDependsOn('me', ['a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeDependsOn('me', [])).toEqual([]);
  });
});
