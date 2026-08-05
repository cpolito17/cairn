/**
 * Pure dependency-forest layout for the Blockers view.
 *
 * A task has at most one prerequisite, so a board is a forest rather than a
 * general graph. The only two jobs here are therefore to classify isolated
 * tasks and to place each tree: depth is the prerequisite-chain length from a
 * root, and vertical position is a tidy-tree row where leaves are consecutive
 * and every parent is centred over its first and last dependent.
 *
 * Stored data is still treated as untrusted. If a cycle has somehow survived,
 * one link in that cycle is cut deterministically (the earliest task in input
 * order) so every task is returned and no walk can hang. The cycle ids are
 * surfaced for diagnostics; rendering does not need a special alarming state.
 */

import type { Task } from './types';

export interface BlockerNode {
  task: Task;
  /** Prerequisite-chain length from this tree's root. */
  depth: number;
  /** Vertical row in this tree. May be fractional when centring a parent. */
  y: number;
  /** The prerequisite after invalid and cyclic links have been removed. */
  parentId: string | null;
  /** Direct dependents, in the order supplied to `layoutBlockers`. */
  dependentIds: string[];
}

export interface BlockerTree {
  rootId: string;
  nodes: BlockerNode[];
  /** Number of leaf rows occupied by the tidy layout. */
  leafRows: number;
  maxDepth: number;
}

export interface BlockerLayout {
  standalone: Task[];
  trees: BlockerTree[];
  /** Tasks participating in cycles found and safely broken during layout. */
  cycleTaskIds: string[];
}

interface Forest {
  tasks: Task[];
  byId: Map<string, Task>;
  parentById: Map<string, string | null>;
  childrenById: Map<string, string[]>;
  cycleTaskIds: string[];
}

/**
 * Depths for every task after missing, cross-board, self, and cyclic links are
 * made safe. Standalone tasks and roots are both depth zero.
 */
export function blockerDepths(tasks: Task[]): Map<string, number> {
  return depthsOf(normalize(tasks));
}

/** Classify and lay out one board's tasks without mutating the input. */
export function layoutBlockers(tasks: Task[]): BlockerLayout {
  const forest = normalize(tasks);
  const depths = depthsOf(forest);
  const standalone = forest.tasks.filter(
    (task) =>
      forest.parentById.get(task.id) === null &&
      (forest.childrenById.get(task.id)?.length ?? 0) === 0,
  );
  const roots = forest.tasks.filter(
    (task) =>
      forest.parentById.get(task.id) === null &&
      (forest.childrenById.get(task.id)?.length ?? 0) > 0,
  );

  const trees = roots.map((root) => layoutTree(root.id, forest, depths));
  return { standalone, trees, cycleTaskIds: forest.cycleTaskIds };
}

function normalize(tasks: Task[]): Forest {
  // Entity ids are unique by schema. Keeping the first occurrence makes even a
  // malformed duplicate deterministic and preserves the caller's order.
  const byId = new Map<string, Task>();
  const ordered: Task[] = [];
  for (const task of tasks) {
    if (byId.has(task.id)) continue;
    byId.set(task.id, task);
    ordered.push(task);
  }

  const order = new Map(ordered.map((task, index) => [task.id, index]));
  const parentById = new Map<string, string | null>();

  for (const task of ordered) {
    const parent = task.dependsOn === null ? undefined : byId.get(task.dependsOn);
    parentById.set(
      task.id,
      parent && parent.id !== task.id && parent.boardId === task.boardId ? parent.id : null,
    );
  }

  const cycleIds = new Set<string>();
  const settled = new Set<string>();

  for (const task of ordered) {
    if (settled.has(task.id)) continue;

    const path: string[] = [];
    const inPath = new Map<string, number>();
    let current: string | null = task.id;

    while (current !== null && !settled.has(current)) {
      const repeatedAt = inPath.get(current);
      if (repeatedAt !== undefined) {
        const cycle = path.slice(repeatedAt);
        for (const id of cycle) cycleIds.add(id);

        const cut = cycle.reduce((earliest, id) =>
          (order.get(id) as number) < (order.get(earliest) as number) ? id : earliest,
        );
        parentById.set(cut, null);
        break;
      }

      inPath.set(current, path.length);
      path.push(current);
      current = parentById.get(current) ?? null;
    }

    for (const id of path) settled.add(id);
  }

  const childrenById = new Map(ordered.map((task) => [task.id, [] as string[]]));
  for (const task of ordered) {
    const parent = parentById.get(task.id) ?? null;
    if (parent !== null) childrenById.get(parent)?.push(task.id);
  }

  return {
    tasks: ordered,
    byId,
    parentById,
    childrenById,
    cycleTaskIds: ordered.filter((task) => cycleIds.has(task.id)).map((task) => task.id),
  };
}

function depthsOf(forest: Forest): Map<string, number> {
  const depths = new Map<string, number>();
  const roots = forest.tasks.filter((task) => forest.parentById.get(task.id) === null);

  for (const root of roots) {
    const pending: Array<{ id: string; depth: number }> = [{ id: root.id, depth: 0 }];
    while (pending.length > 0) {
      const current = pending.pop() as { id: string; depth: number };
      if (depths.has(current.id)) continue;
      depths.set(current.id, current.depth);

      const children = forest.childrenById.get(current.id) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({ id: children[index], depth: current.depth + 1 });
      }
    }
  }

  // `normalize` guarantees roots, but retaining a finite fallback here keeps
  // this helper total if its internals are changed later.
  for (const task of forest.tasks) {
    if (!depths.has(task.id)) depths.set(task.id, 0);
  }
  return depths;
}

function layoutTree(rootId: string, forest: Forest, depths: Map<string, number>): BlockerTree {
  const yById = new Map<string, number>();
  let nextLeaf = 0;

  function place(id: string): number {
    const existing = yById.get(id);
    if (existing !== undefined) return existing;

    const children = forest.childrenById.get(id) ?? [];
    let y: number;
    if (children.length === 0) {
      y = nextLeaf;
      nextLeaf += 1;
    } else {
      const childRows = children.map(place);
      y = (childRows[0] + childRows[childRows.length - 1]) / 2;
    }
    yById.set(id, y);
    return y;
  }

  place(rootId);
  const members = forest.tasks.filter((task) => yById.has(task.id));
  const nodes = members.map((task): BlockerNode => ({
    task,
    depth: depths.get(task.id) ?? 0,
    y: yById.get(task.id) as number,
    parentId: forest.parentById.get(task.id) ?? null,
    dependentIds: [...(forest.childrenById.get(task.id) ?? [])],
  }));

  return {
    rootId,
    nodes,
    leafRows: Math.max(1, nextLeaf),
    maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
  };
}
