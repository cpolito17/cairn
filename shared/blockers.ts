/**
 * Pure dependency-graph layout for the Blockers view.
 *
 * A task may now wait on any number of others (§14 addendum), so a board is a
 * **directed acyclic graph**, not the forest this module was originally written
 * for. Three things follow, and they are the whole of the difference:
 *
 *   * **Depth is the longest path from a root**, not the length of a chain. A
 *     task must be drawn to the right of *every* prerequisite, so its column is
 *     one past the furthest-right of them. Using the shortest path — or the
 *     first prerequisite's — would put an edge travelling leftwards on screen,
 *     which reads as the dependency pointing the wrong way.
 *   * **Groups are connected components**, not trees. Two tasks belong in the
 *     same drawing if they are joined by any chain of links in either
 *     direction; there is no single root to name a group by any more.
 *   * **Vertical order is a barycentre pass**, not a tidy-tree centring. With
 *     one parent per node, centring a parent over its children is exact and
 *     optimal. With several, no arrangement satisfies everyone, so each layer
 *     is ordered by the average position of its prerequisites — the standard
 *     one-pass heuristic, which is cheap, deterministic, and good enough for
 *     graphs the size of a task board.
 *
 * This module assigns **rows**, not pixels: a node's `row` is its index within
 * its depth layer. The screen turns rows into coordinates, because that needs
 * the measured height of every card and this file has no business knowing about
 * measurement.
 *
 * Stored data is still treated as untrusted. Any cycle that survived the
 * Worker's checks is broken here — the offending edge is dropped, chosen
 * deterministically — so every task is returned and no walk can hang. The cycle
 * ids are surfaced for diagnostics; rendering does not need a special alarming
 * state.
 */

import type { Task } from './types';

export interface BlockerNode {
  task: Task;
  /** Longest prerequisite-path length from a root. Roots are 0. */
  depth: number;
  /** Index within this node's depth layer, top to bottom. */
  row: number;
  /** Prerequisites, after invalid and cyclic links are removed. To the left. */
  prerequisiteIds: string[];
  /** Direct dependents. To the right. */
  dependentIds: string[];
}

export interface BlockerGraph {
  /**
   * The component's identity: the id of its first task in input order. Used as
   * a React key and for stable sorting, and it deliberately does not claim to
   * be a "root" — a component can have several.
   */
  id: string;
  nodes: BlockerNode[];
  /** Task ids by depth, each layer already in its drawing order. */
  layers: string[][];
  maxDepth: number;
}

export interface BlockerLayout {
  standalone: Task[];
  graphs: BlockerGraph[];
  /** Tasks participating in cycles found and safely broken during layout. */
  cycleTaskIds: string[];
}

interface Graph {
  tasks: Task[];
  byId: Map<string, Task>;
  /** Kept edges, dependent → prerequisites. */
  prerequisites: Map<string, string[]>;
  /** The same edges reversed, prerequisite → dependents. */
  dependents: Map<string, string[]>;
  cycleTaskIds: string[];
}

/** Depths for every task after invalid and cyclic links are made safe. */
export function blockerDepths(tasks: Task[]): Map<string, number> {
  return depthsOf(normalize(tasks));
}

/** Classify and lay out one board's tasks without mutating the input. */
export function layoutBlockers(tasks: Task[]): BlockerLayout {
  const graph = normalize(tasks);
  const depths = depthsOf(graph);

  const standalone = graph.tasks.filter(
    (task) =>
      (graph.prerequisites.get(task.id)?.length ?? 0) === 0 &&
      (graph.dependents.get(task.id)?.length ?? 0) === 0,
  );

  const graphs = componentsOf(graph, standalone).map((members) =>
    layoutComponent(members, graph, depths),
  );

  return { standalone, graphs, cycleTaskIds: graph.cycleTaskIds };
}

/**
 * Drop every link that cannot be drawn, and every link that would make the
 * graph cyclic.
 *
 * Order of business matters: self-links, cross-board links and links to tasks
 * that are not here are removed first, because they are not really edges at
 * all, and only then are the survivors walked for cycles. A cycle is broken by
 * dropping the single edge that closed it — the back edge — which is both the
 * smallest possible repair and a deterministic one, since tasks are visited in
 * input order and each task's prerequisites in their own stored order.
 */
function normalize(tasks: Task[]): Graph {
  // Entity ids are unique by schema. Keeping the first occurrence makes even a
  // malformed duplicate deterministic and preserves the caller's order.
  const byId = new Map<string, Task>();
  const ordered: Task[] = [];
  for (const task of tasks) {
    if (byId.has(task.id)) continue;
    byId.set(task.id, task);
    ordered.push(task);
  }

  const prerequisites = new Map<string, string[]>();
  for (const task of ordered) {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const id of task.dependsOn) {
      if (id === task.id || seen.has(id)) continue;
      const prerequisite = byId.get(id);
      if (!prerequisite || prerequisite.boardId !== task.boardId) continue;
      seen.add(id);
      kept.push(id);
    }
    prerequisites.set(task.id, kept);
  }

  // Depth-first over the prerequisite edges, dropping any edge that points at a
  // node still on the stack. The three-state colouring is the same one
  // `canDependOn` uses and for the same reason: a node reached twice by
  // different paths is a diamond, and only a node reached while it is still
  // being explored is a cycle.
  const ON_STACK = 1;
  const FINISHED = 2;
  const state = new Map<string, number>();
  const cycleIds = new Set<string>();

  for (const start of ordered) {
    if (state.get(start.id) === FINISHED) continue;

    const frames: { id: string; next: number }[] = [{ id: start.id, next: 0 }];
    state.set(start.id, ON_STACK);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const deps = prerequisites.get(frame.id) as string[];

      if (frame.next >= deps.length) {
        state.set(frame.id, FINISHED);
        frames.pop();
        continue;
      }

      const id = deps[frame.next];
      const colour = state.get(id);

      if (colour === ON_STACK) {
        // The back edge. Everything from that node forward along the stack is
        // in the cycle, and this one link is what closes it.
        const from = frames.findIndex((entry) => entry.id === id);
        for (let i = from; i < frames.length; i += 1) cycleIds.add(frames[i].id);
        deps.splice(frame.next, 1);
        continue;
      }

      frame.next += 1;
      if (colour === FINISHED) continue;

      state.set(id, ON_STACK);
      frames.push({ id, next: 0 });
    }
  }

  const dependents = new Map<string, string[]>(ordered.map((task) => [task.id, []]));
  for (const task of ordered) {
    for (const id of prerequisites.get(task.id) as string[]) {
      dependents.get(id)?.push(task.id);
    }
  }

  return {
    tasks: ordered,
    byId,
    prerequisites,
    dependents,
    cycleTaskIds: ordered.filter((task) => cycleIds.has(task.id)).map((task) => task.id),
  };
}

/**
 * Longest path from a root, for every task.
 *
 * Computed by relaxing along a topological order rather than by walking down
 * from roots: a node's depth is only final once every prerequisite has one, and
 * a downward walk would settle a diamond's join too early — at the depth of
 * whichever branch happened to be visited first.
 */
function depthsOf(graph: Graph): Map<string, number> {
  const depths = new Map<string, number>(graph.tasks.map((task) => [task.id, 0]));

  // Kahn's algorithm. The graph is acyclic by construction at this point, so
  // every node is emitted; the remaining-count guard is belt and braces.
  const remaining = new Map<string, number>(
    graph.tasks.map((task) => [task.id, (graph.prerequisites.get(task.id) as string[]).length]),
  );
  const ready = graph.tasks.filter((task) => remaining.get(task.id) === 0).map((task) => task.id);

  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index];
    const depth = depths.get(id) as number;
    for (const dependent of graph.dependents.get(id) ?? []) {
      depths.set(dependent, Math.max(depths.get(dependent) as number, depth + 1));
      const left = (remaining.get(dependent) as number) - 1;
      remaining.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }

  return depths;
}

/**
 * Weakly connected components, in input order, excluding standalone tasks.
 *
 * "Weakly" because the drawing joins two tasks that share a prerequisite just
 * as much as two in a chain: direction decides which side of the picture a node
 * lands on, not which picture it lands in.
 */
function componentsOf(graph: Graph, standalone: Task[]): Task[][] {
  const alone = new Set(standalone.map((task) => task.id));
  const assigned = new Set<string>();
  const components: Task[][] = [];

  for (const task of graph.tasks) {
    if (alone.has(task.id) || assigned.has(task.id)) continue;

    const members: Task[] = [];
    const pending = [task.id];
    assigned.add(task.id);

    while (pending.length > 0) {
      const id = pending.pop() as string;
      const member = graph.byId.get(id);
      if (member) members.push(member);

      for (const neighbour of [
        ...(graph.prerequisites.get(id) ?? []),
        ...(graph.dependents.get(id) ?? []),
      ]) {
        if (assigned.has(neighbour)) continue;
        assigned.add(neighbour);
        pending.push(neighbour);
      }
    }

    // Back into input order: the traversal order is an implementation detail
    // and must not leak into what the screen renders.
    const ids = new Set(members.map((entry) => entry.id));
    components.push(graph.tasks.filter((entry) => ids.has(entry.id)));
  }

  return components;
}

/**
 * Place one component: layer its nodes by depth, then order each layer.
 *
 * The ordering pass runs left to right. The first layer keeps input order —
 * there is nothing to its left to take a cue from — and every later layer is
 * sorted by the average row of its prerequisites, which pulls a node towards
 * the things it waits on and keeps edges from crossing more than they must.
 * Nodes with equal barycentres fall back to input order, so the result is a
 * total order and two renders of the same data cannot disagree.
 */
function layoutComponent(
  members: Task[],
  graph: Graph,
  depths: Map<string, number>,
): BlockerGraph {
  const inputOrder = new Map(members.map((task, index) => [task.id, index]));
  const maxDepth = members.reduce((max, task) => Math.max(max, depths.get(task.id) as number), 0);

  const layers: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const task of members) layers[depths.get(task.id) as number].push(task.id);

  const rows = new Map<string, number>();
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const layer = layers[depth];

    if (depth > 0) {
      layer.sort((a, b) => {
        const byBarycentre = barycentre(a, graph, rows) - barycentre(b, graph, rows);
        if (byBarycentre !== 0) return byBarycentre;
        return (inputOrder.get(a) as number) - (inputOrder.get(b) as number);
      });
    }

    layer.forEach((id, row) => rows.set(id, row));
  }

  const nodes = members.map((task): BlockerNode => {
    const prerequisiteIds = [...(graph.prerequisites.get(task.id) as string[])];
    const dependentIds = [...(graph.dependents.get(task.id) ?? [])];
    // Both edge lists are sorted the way they will be drawn — top to bottom by
    // the far end's position — so the SVG layer can emit them in order without
    // re-deriving it.
    prerequisiteIds.sort(byPlacement(depths, rows));
    dependentIds.sort(byPlacement(depths, rows));

    return {
      task,
      depth: depths.get(task.id) as number,
      row: rows.get(task.id) as number,
      prerequisiteIds,
      dependentIds,
    };
  });

  return { id: members[0].id, nodes, layers, maxDepth };
}

/**
 * A node's pull towards its prerequisites: the mean row of the ones already
 * placed. A node with none sits where it already is.
 */
function barycentre(id: string, graph: Graph, rows: Map<string, number>): number {
  const prerequisiteIds = graph.prerequisites.get(id) as string[];
  const placed = prerequisiteIds.map((entry) => rows.get(entry)).filter((row) => row !== undefined);
  if (placed.length === 0) return 0;
  return placed.reduce((sum, row) => sum + (row as number), 0) / placed.length;
}

/** Order two ids by where they sit in the drawing: column first, then row. */
function byPlacement(depths: Map<string, number>, rows: Map<string, number>) {
  return (a: string, b: string): number =>
    (depths.get(a) ?? 0) - (depths.get(b) ?? 0) ||
    (rows.get(a) ?? 0) - (rows.get(b) ?? 0) ||
    (a < b ? -1 : a > b ? 1 : 0);
}
