import { describe, expect, it } from 'vitest';
import { blockerDepths, layoutBlockers } from './blockers';
import type { Task } from './types';

function task(id: string, dependsOn: string[] = [], boardId = 'b1'): Task {
  return {
    id,
    boardId,
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

/** `{ id: { depth, row } }` for every node in every component. */
function placement(tasks: Task[]): Record<string, { depth: number; row: number }> {
  const nodes = layoutBlockers(tasks).graphs.flatMap((graph) => graph.nodes);
  return Object.fromEntries(nodes.map((node) => [node.task.id, { depth: node.depth, row: node.row }]));
}

const depths = (tasks: Task[]) => Object.fromEntries(blockerDepths(tasks));

describe('single-prerequisite shapes', () => {
  it('spreads four dependents of one root down a column', () => {
    const tasks = [
      task('root'),
      task('one', ['root']),
      task('two', ['root']),
      task('three', ['root']),
      task('four', ['root']),
    ];
    const layout = layoutBlockers(tasks);

    expect(layout.graphs).toHaveLength(1);
    expect(layout.graphs[0].layers).toEqual([['root'], ['one', 'two', 'three', 'four']]);
    expect(placement(tasks)).toEqual({
      root: { depth: 0, row: 0 },
      one: { depth: 1, row: 0 },
      two: { depth: 1, row: 1 },
      three: { depth: 1, row: 2 },
      four: { depth: 1, row: 3 },
    });
  });

  it('lays out a five-deep chain in five columns on one row', () => {
    const tasks = [
      task('one'),
      task('two', ['one']),
      task('three', ['two']),
      task('four', ['three']),
      task('five', ['four']),
    ];
    const graph = layoutBlockers(tasks).graphs[0];

    expect(graph.maxDepth).toBe(4);
    expect([...blockerDepths(tasks).values()]).toEqual([0, 1, 2, 3, 4]);
    expect(graph.nodes.every((node) => node.row === 0)).toBe(true);
  });

  it('returns an entirely standalone board without inventing a graph', () => {
    const tasks = [task('one'), task('two'), task('three')];
    const layout = layoutBlockers(tasks);

    expect(layout.graphs).toEqual([]);
    expect(layout.standalone.map((entry) => entry.id)).toEqual(['one', 'two', 'three']);
    expect([...blockerDepths(tasks).values()]).toEqual([0, 0, 0]);
  });

  it('keeps two components separate and leaves unrelated tasks in the compact list', () => {
    const tasks = [
      task('root-a'),
      task('a-child', ['root-a']),
      task('loose'),
      task('root-b'),
      task('b-child-1', ['root-b']),
      task('b-child-2', ['root-b']),
    ];
    const layout = layoutBlockers(tasks);

    expect(layout.graphs.map((graph) => graph.id)).toEqual(['root-a', 'root-b']);
    expect(layout.graphs.map((graph) => graph.nodes.map((node) => node.task.id))).toEqual([
      ['root-a', 'a-child'],
      ['root-b', 'b-child-1', 'b-child-2'],
    ]);
    expect(layout.standalone.map((entry) => entry.id)).toEqual(['loose']);
  });
});

describe('many prerequisites', () => {
  it('puts a task one column past its furthest prerequisite, not its first', () => {
    // `sink` waits on `near` (depth 0) and on `far` (depth 2). Taking the first
    // link would place it at depth 1 — to the *left* of `far`, drawing that
    // edge backwards across the screen.
    const tasks = [
      task('near'),
      task('a'),
      task('b', ['a']),
      task('far', ['b']),
      task('sink', ['near', 'far']),
    ];
    expect(depths(tasks)).toEqual({ near: 0, a: 0, b: 1, far: 2, sink: 3 });
  });

  it('draws a diamond as one component with the join past both branches', () => {
    const tasks = [
      task('start'),
      task('left', ['start']),
      task('right', ['start']),
      task('join', ['left', 'right']),
    ];
    const layout = layoutBlockers(tasks);

    expect(layout.graphs).toHaveLength(1);
    expect(layout.graphs[0].layers).toEqual([['start'], ['left', 'right'], ['join']]);
    expect(layout.standalone).toEqual([]);
  });

  it('records every prerequisite as an incoming edge on the dependent', () => {
    const tasks = [task('a'), task('b'), task('c'), task('sink', ['a', 'b', 'c'])];
    const nodes = layoutBlockers(tasks).graphs[0].nodes;
    const sink = nodes.find((node) => node.task.id === 'sink');
    expect(sink?.prerequisiteIds).toEqual(['a', 'b', 'c']);
    // ...and as an outgoing edge on each prerequisite, so both ends agree.
    for (const id of ['a', 'b', 'c']) {
      expect(nodes.find((node) => node.task.id === id)?.dependentIds).toEqual(['sink']);
    }
  });

  it('joins two chains into one component when a task waits on both', () => {
    const tasks = [
      task('a1'),
      task('a2', ['a1']),
      task('b1'),
      task('b2', ['b1']),
      task('merge', ['a2', 'b2']),
    ];
    const layout = layoutBlockers(tasks);
    expect(layout.graphs).toHaveLength(1);
    expect(layout.graphs[0].nodes).toHaveLength(5);
    expect(depths(tasks).merge).toBe(2);
  });

  it('orders a layer by the average position of its prerequisites', () => {
    // One base so this is a single component, four tasks above it, then two
    // that each wait on a different pair. `low` waits on the topmost pair and
    // `high` on the bottom pair, so `low` must sort above `high` — even though
    // `high` was entered first, which is what makes this a test of the
    // barycentre rather than of input order.
    const tasks = [
      task('base'),
      task('r0', ['base']),
      task('r1', ['base']),
      task('r2', ['base']),
      task('r3', ['base']),
      task('high', ['r2', 'r3']),
      task('low', ['r0', 'r1']),
    ];
    const layers = layoutBlockers(tasks).graphs[0].layers;
    expect(layers[1]).toEqual(['r0', 'r1', 'r2', 'r3']);
    expect(layers[2]).toEqual(['low', 'high']);
  });

  it('is stable: the same input always produces the same placement', () => {
    const build = () => [
      task('a'),
      task('b'),
      task('c', ['a', 'b']),
      task('d', ['a']),
      task('e', ['c', 'd']),
    ];
    expect(placement(build())).toEqual(placement(build()));
  });
});

describe('untrusted stored data', () => {
  it('breaks a stored cycle deterministically and returns every task', () => {
    const tasks = [
      task('a', ['b']),
      task('b', ['c']),
      task('c', ['a']),
      task('dependent', ['a']),
      task('standalone'),
    ];
    const layout = layoutBlockers(tasks);
    const returned = [
      ...layout.standalone.map((entry) => entry.id),
      ...layout.graphs.flatMap((graph) => graph.nodes.map((node) => node.task.id)),
    ];

    expect(new Set(layout.cycleTaskIds)).toEqual(new Set(['a', 'b', 'c']));
    expect(new Set(returned)).toEqual(new Set(tasks.map((entry) => entry.id)));
    expect(
      layout.graphs
        .flatMap((graph) => graph.nodes)
        .every((node) => Number.isFinite(node.depth) && Number.isFinite(node.row)),
    ).toBe(true);
  });

  it('breaks only the edge that closes a cycle, keeping the rest of the graph', () => {
    // a → b → c → a, plus an honest edge b → d that must survive the repair.
    const tasks = [task('a', ['c']), task('b', ['a']), task('c', ['b']), task('d', ['b'])];
    const nodes = layoutBlockers(tasks).graphs[0].nodes;
    const edges = nodes.flatMap((node) =>
      node.prerequisiteIds.map((id) => `${id}->${node.task.id}`),
    );
    // One of the three cycle edges is dropped; d keeps its prerequisite.
    expect(edges).toContain('b->d');
    expect(edges.filter((edge) => edge !== 'b->d')).toHaveLength(2);
  });

  it('ignores a self-link, a cross-board link, and a link to nothing', () => {
    const tasks = [
      task('self', ['self']),
      task('elsewhere', ['other-board-task']),
      task('dangling', ['ghost']),
      task('real', ['self']),
    ];
    const layout = layoutBlockers(tasks);

    // Only `self → real` is a real edge, so those two form the one component
    // and the other two are standalone.
    expect(layout.standalone.map((entry) => entry.id)).toEqual(['elsewhere', 'dangling']);
    expect(layout.graphs).toHaveLength(1);
    expect(layout.graphs[0].nodes.map((node) => node.task.id)).toEqual(['self', 'real']);
    expect(layout.cycleTaskIds).toEqual([]);
  });

  it('drops a duplicate link rather than drawing the same edge twice', () => {
    const tasks = [task('a'), task('b', ['a', 'a'])];
    const nodes = layoutBlockers(tasks).graphs[0].nodes;
    expect(nodes.find((node) => node.task.id === 'b')?.prerequisiteIds).toEqual(['a']);
  });

  it('refuses to hang on a wide graph', () => {
    // 300 tasks all waiting on one root and all feeding one sink: the shape
    // where a naive per-path walk would go exponential.
    const middle = Array.from({ length: 300 }, (_, i) => task(`m${i}`, ['root']));
    const tasks = [
      task('root'),
      ...middle,
      task('sink', middle.map((entry) => entry.id)),
    ];
    const layout = layoutBlockers(tasks);
    expect(layout.graphs).toHaveLength(1);
    expect(depths(tasks).sink).toBe(2);
  });
});
