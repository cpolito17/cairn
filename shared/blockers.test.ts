import { describe, expect, it } from 'vitest';
import { blockerDepths, layoutBlockers } from './blockers';
import type { Task } from './types';

function task(id: string, dependsOn: string | null = null): Task {
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
    dependsOn,
    position: id,
    createdAt: 0,
    completedAt: null,
    updatedAt: 0,
  };
}

function nodeRows(tasks: Task[]): Record<string, { depth: number; y: number }> {
  const nodes = layoutBlockers(tasks).trees.flatMap((tree) => tree.nodes);
  return Object.fromEntries(nodes.map((node) => [node.task.id, { depth: node.depth, y: node.y }]));
}

describe('Blockers dependency forests', () => {
  it('centres a root over four dependents', () => {
    const tasks = [
      task('root'),
      task('one', 'root'),
      task('two', 'root'),
      task('three', 'root'),
      task('four', 'root'),
    ];
    const layout = layoutBlockers(tasks);

    expect(layout.trees).toHaveLength(1);
    expect(layout.trees[0].leafRows).toBe(4);
    expect(nodeRows(tasks)).toEqual({
      root: { depth: 0, y: 1.5 },
      one: { depth: 1, y: 0 },
      two: { depth: 1, y: 1 },
      three: { depth: 1, y: 2 },
      four: { depth: 1, y: 3 },
    });
  });

  it('lays out a five-deep chain in five columns on one row', () => {
    const tasks = [
      task('one'),
      task('two', 'one'),
      task('three', 'two'),
      task('four', 'three'),
      task('five', 'four'),
    ];
    const tree = layoutBlockers(tasks).trees[0];

    expect(tree.maxDepth).toBe(4);
    expect(tree.leafRows).toBe(1);
    expect([...blockerDepths(tasks).values()]).toEqual([0, 1, 2, 3, 4]);
    expect(tree.nodes.every((node) => node.y === 0)).toBe(true);
  });

  it('returns an entirely standalone board without inventing a tree', () => {
    const tasks = [task('one'), task('two'), task('three')];
    const layout = layoutBlockers(tasks);

    expect(layout.trees).toEqual([]);
    expect(layout.standalone.map((entry) => entry.id)).toEqual(['one', 'two', 'three']);
    expect([...blockerDepths(tasks).values()]).toEqual([0, 0, 0]);
  });

  it('keeps two trees separate and leaves unrelated tasks in the compact list', () => {
    const tasks = [
      task('root-a'),
      task('a-child', 'root-a'),
      task('loose'),
      task('root-b'),
      task('b-child-1', 'root-b'),
      task('b-child-2', 'root-b'),
    ];
    const layout = layoutBlockers(tasks);

    expect(layout.trees.map((tree) => tree.rootId)).toEqual(['root-a', 'root-b']);
    expect(layout.trees.map((tree) => tree.nodes.map((node) => node.task.id))).toEqual([
      ['root-a', 'a-child'],
      ['root-b', 'b-child-1', 'b-child-2'],
    ]);
    expect(layout.standalone.map((entry) => entry.id)).toEqual(['loose']);
    expect(layout.trees[0].nodes.every((node) => node.y === 0)).toBe(true);
    expect(layout.trees[1].leafRows).toBe(2);
  });

  it('breaks a stored cycle deterministically and returns every task', () => {
    const tasks = [
      task('a', 'b'),
      task('b', 'c'),
      task('c', 'a'),
      task('dependent', 'a'),
      task('standalone'),
    ];
    const layout = layoutBlockers(tasks);
    const returned = [
      ...layout.standalone.map((entry) => entry.id),
      ...layout.trees.flatMap((tree) => tree.nodes.map((node) => node.task.id)),
    ];

    expect(layout.cycleTaskIds).toEqual(['a', 'b', 'c']);
    expect(new Set(returned)).toEqual(new Set(tasks.map((entry) => entry.id)));
    expect(layout.trees[0].rootId).toBe('a');
    expect(layout.trees.flatMap((tree) => tree.nodes).every(
      (node) => Number.isFinite(node.depth) && Number.isFinite(node.y),
    )).toBe(true);
  });
});
