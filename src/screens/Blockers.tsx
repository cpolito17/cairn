/**
 * Blockers. PROJECT-SPEC-V2.md §7.
 *
 * Each active board is one independently scrolling horizontal row. Dependency
 * trees are the pure result of `shared/blockers.ts`; this screen only turns its
 * depth and tidy-tree rows into pixels, draws one SVG edge layer, and wires the
 * existing composer and completion action to the nodes.
 *
 * The one thing it adds on its own is a way to *extend* a chain: every
 * dependency line carries a hover point that opens the composer in create mode
 * with the link already pointing at the task that line leaves from, and a node
 * with nothing after it grows a stub so it has such a point too. Nothing about
 * it is stored — a created task goes through the same `addTask` every other
 * surface uses, and the tree redraws from the store.
 */

import { CaretDown, Check, Clock, Flag, Plus } from '@phosphor-icons/react';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  layoutBlockers,
  type BlockerLayout,
  type BlockerNode,
} from '../../shared/blockers';
import { blockedBy, lookupOf, type TaskLookup } from '../../shared/dependencies';
import { boardProgress, type BoardProgress } from '../../shared/progress';
import type { Board, Task } from '../../shared/types';
import { toggleComplete } from '../lib/actions';
import { formatDue, formatOverdue } from '../lib/dates';
import { keyboardMotionActive, prefersReducedMotion } from '../lib/motion';
import { useBoards, useStore } from '../lib/store';
import { TaskComposer } from '../components/TaskComposer';
import { TaskDetails } from '../components/TaskDetails';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { EmptyLine, ErrorLine, loadErrorMessage } from '../components/ui/Section';
import { Skeleton } from '../components/ui/Skeleton';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 88;
const COLUMN_GAP = 72;
const ROW_GAP = 28;
const TREE_GAP = 48;
const TREE_PADDING_X = 24;
const TREE_PADDING_Y = 24;

/**
 * The "add a task after this one" affordance.
 *
 * Every dependency line is a place a new task can be hung: hovering one raises
 * a plus in a circle above it, and pressing that opens the composer already
 * waiting on the task the line *leaves from*. A node with nothing after it has
 * no line to hover, so it grows a short stub of its own — which is also the
 * only at-rest hint that any of this is here at all.
 *
 * `ADD_HOTSPOT_WIDTH` (56) and the leaf hotspot's own width (`ADD_STUB` +
 * `ADD_BUTTON` = 72) are both bounded by `COLUMN_GAP`, so no hotspot ever
 * reaches into the column a node occupies. That is what keeps this out of the
 * way of the node cards without a stacking order to maintain.
 */
const ADD_BUTTON = 44;
const ADD_CIRCLE = 28;
/** How far the circle's centre sits above the line it belongs to. */
const ADD_RISE = 26;
/** Hover room below the line, so approaching from underneath still counts. */
const ADD_TAIL = 16;
const ADD_HOTSPOT_WIDTH = 56;
/** The stub drawn off a node that nothing waits on yet. */
const ADD_STUB = 36;
const ADD_TRAIL = ADD_STUB + ADD_BUTTON;

interface BoardModel {
  board: Board;
  tasks: Task[];
  layout: BlockerLayout;
  progress: BoardProgress;
  hasTrees: boolean;
}

interface PositionedNode {
  node: BlockerNode;
  x: number;
  y: number;
}

interface PositionedEdge {
  id: string;
  parentId: string;
  childId: string;
  path: string;
}

/** The stub line drawn off a node that nothing waits on yet. */
interface PositionedStub {
  id: string;
  path: string;
}

/** A hover region holding one plus button, in tree-layer coordinates. */
interface AddPoint {
  id: string;
  /** The task a task created from here will wait on. */
  prerequisiteId: string;
  prerequisiteName: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** The button's offset inside the region. */
  buttonLeft: number;
  buttonTop: number;
  /** Drawn from the circle down to the line, on an edge point only. */
  connectorTop: number | null;
  connectorHeight: number;
}

interface Geometry {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  stubs: PositionedStub[];
  addPoints: AddPoint[];
  width: number;
  height: number;
  leftmostIncompleteX: number | null;
}

export function Blockers() {
  const status = useStore((state) => state.status);
  const context = useStore((state) => state.context);
  const taskRecord = useStore((state) => state.tasks);
  const boards = useBoards(context);
  const [editing, setEditing] = useState<Task | null>(null);
  // Create mode: the board the new task lands on, and the task it starts out
  // waiting on — which is the whole content of the gesture that opened it.
  const [creating, setCreating] = useState<{ boardId: string; dependsOn: string } | null>(null);

  const models = useMemo(() => {
    const allTasks = Object.values(taskRecord);
    return boards
      .map((board): BoardModel => {
        const tasks = allTasks
          .filter((task) => task.boardId === board.id)
          .sort(byTaskPosition);
        const layout = layoutBlockers(tasks);
        return {
          board,
          tasks,
          layout,
          progress: boardProgress(tasks),
          hasTrees: layout.trees.length > 0,
        };
      })
      .sort((a, b) => Number(b.hasTrees) - Number(a.hasTrees));
  }, [boards, taskRecord]);

  const hasAnyDependencies = models.some((model) => model.hasTrees);

  return (
    <>
      <h1 className="mb-section text-board-title text-text">Blockers</h1>

      {status === 'loading' ? (
        <BlockersSkeleton />
      ) : status === 'error' ? (
        <BlockersError />
      ) : !hasAnyDependencies ? (
        <EmptyLine>Tasks waiting on other tasks will appear here.</EmptyLine>
      ) : (
        <div className="grid gap-3">
          {models.map((model) =>
            model.hasTrees ? (
              <DependencyBoard
                key={model.board.id}
                model={model}
                onOpen={setEditing}
                onAdd={(dependsOn) => setCreating({ boardId: model.board.id, dependsOn })}
              />
            ) : (
              <StandaloneBoard key={model.board.id} model={model} onOpen={setEditing} />
            ),
          )}
        </div>
      )}

      {editing && (
        <TaskComposer
          open
          onClose={() => setEditing(null)}
          task={editing}
          boardId={editing.boardId}
          context={context}
        />
      )}

      {creating && (
        // No `task`, so this is the composer's create mode. The new task lands
        // at the end of its board's active list like any other (§7.3) and the
        // tree redraws from the store — there is nothing to re-fetch and
        // nothing here that knows the layout.
        <TaskComposer
          open
          onClose={() => setCreating(null)}
          boardId={creating.boardId}
          initialDependsOn={creating.dependsOn}
          context={context}
        />
      )}
    </>
  );
}

function DependencyBoard({
  model,
  onOpen,
  onAdd,
}: {
  model: BoardModel;
  onOpen(task: Task): void;
  onAdd(prerequisiteId: string): void;
}) {
  const lookup = useMemo(() => lookupOf(model.tasks), [model.tasks]);
  const byId = useMemo(
    () => new Map(model.tasks.map((task) => [task.id, task])),
    [model.tasks],
  );
  const scroll = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());

  // Nodes render at NODE_HEIGHT first — a reasonable guess, and the one every
  // node used to be pinned to outright — then this measures what they
  // actually came out at once a name has wrapped past it, and lays out again
  // from the real numbers. `useLayoutEffect` is what keeps the guess from
  // ever painting: it runs, and the `setNodeHeights` it triggers commits,
  // before the browser shows anything. Re-fires whenever `model.layout`
  // itself is a new object — a new tree shape or an edited name, the two
  // things that can change what a node measures at.
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [nodeHeights, setNodeHeights] = useState<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const measured = new Map<string, number>();
    for (const tree of model.layout.trees) {
      for (const node of tree.nodes) {
        const el = nodeRefs.current.get(node.task.id);
        if (el) measured.set(node.task.id, el.getBoundingClientRect().height);
      }
    }
    setNodeHeights(measured);
  }, [model.layout]);

  const geometry = useMemo(
    () => geometryOf(model.layout, nodeHeights),
    [model.layout, nodeHeights],
  );

  useAutoScrollOnMount(scroll, geometry.leftmostIncompleteX);

  return (
    <section
      className="blockers-bleed overflow-hidden border-y border-hairline"
      aria-labelledby={`blocker-board-${model.board.id}`}
    >
      {/* The title, above the scrolling row rather than sharing its narrow
          sticky column — a board name is not something a 220px sidebar was
          ever going to hold without cutting it off. */}
      <div className="px-gutter py-4">
        <h2
          id={`blocker-board-${model.board.id}`}
          className="text-row text-text"
          style={{ fontWeight: 600, overflowWrap: 'anywhere' }}
        >
          {model.board.name}
        </h2>
        <p className="mt-1 text-meta text-text-secondary">{model.progress.percent}% complete</p>
      </div>

      <div ref={scroll} className="blockers-board-scroll">
        <div className="flex min-w-max items-stretch" style={{ minHeight: geometry.height }}>
          {/* Sticky only while there is something to pin — an empty 220px
              column has nothing left to say once the title moved above. */}
          {model.layout.standalone.length > 0 && (
            <aside className="blockers-sidebar z-20 shrink-0 p-4">
              <div
                className="overflow-y-auto rounded-control bg-surface-2 p-1"
                style={{ maxHeight: '240px', overscrollBehavior: 'contain' }}
              >
                <p className="px-2 pb-1 pt-2 text-meta text-text-tertiary">Standalone</p>
                {model.layout.standalone.map((task) => (
                  <CompactTask key={task.id} task={task} onOpen={onOpen} />
                ))}
              </div>
            </aside>
          )}

          <div
            className="relative shrink-0"
            style={{ width: geometry.width, height: geometry.height }}
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 block"
              width={geometry.width}
              height={geometry.height}
            >
              {geometry.edges.map((edge) => {
                const prerequisite = byId.get(edge.parentId);
                const released = prerequisite?.completedAt !== null;
                return (
                  <path
                    key={edge.id}
                    data-edge-from={edge.parentId}
                    data-edge-to={edge.childId}
                    d={edge.path}
                    fill="none"
                    stroke={
                      released
                        ? 'color-mix(in srgb, var(--positive) 60%, transparent)'
                        : 'var(--text-tertiary)'
                    }
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                    style={{ transition: 'stroke 200ms var(--ease-out)' }}
                  />
                );
              })}

              {geometry.stubs.map((stub) => (
                <path
                  key={stub.id}
                  d={stub.path}
                  fill="none"
                  stroke="color-mix(in srgb, var(--text-tertiary) 45%, transparent)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>

            {geometry.addPoints.map((point) => (
              <AddAfter key={point.id} point={point} onAdd={onAdd} />
            ))}

            {geometry.nodes.map(({ node, x, y }) => (
              <div
                key={node.task.id}
                ref={(el) => {
                  if (el) nodeRefs.current.set(node.task.id, el);
                  else nodeRefs.current.delete(node.task.id);
                }}
                data-blocker-node={node.task.id}
                className="absolute left-0 top-0"
                style={{
                  width: NODE_WIDTH,
                  // A floor, not a fixed height — §7's line-clamp used to cut
                  // a long name off at two lines to stay inside NODE_HEIGHT;
                  // now the box grows for it instead, and the row spacing
                  // above already left it the room (`geometryOf`, measured
                  // against exactly this element).
                  minHeight: NODE_HEIGHT,
                  transform: `translate3d(${x}px, ${y}px, 0)`,
                }}
              >
                <TaskDetails task={node.task} className="block h-full" touchLongPress>
                  <BlockerNodeCard
                    node={node}
                    lookup={lookup}
                    now={now}
                    onOpen={onOpen}
                  />
                </TaskDetails>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The plus, and the region that reveals it.
 *
 * Nothing here moves the tree: the region is a transparent box sitting in the
 * gap between two node columns, and only `opacity` and `transform` are ever
 * animated on what it contains (§8.5). The reveal is gated behind
 * `@media (hover: hover) and (pointer: fine)` in `index.css` — a touch device
 * has no hover to give, so there the plus is simply present, quietly.
 */
function AddAfter({ point, onAdd }: { point: AddPoint; onAdd(prerequisiteId: string): void }) {
  return (
    <div
      className="blocker-add-hotspot absolute"
      style={{
        left: point.left,
        top: point.top,
        width: point.width,
        height: point.height,
      }}
    >
      {point.connectorTop !== null && (
        <span
          aria-hidden="true"
          className="blocker-add absolute"
          style={{
            left: point.width / 2 - 0.5,
            top: point.connectorTop,
            width: 1,
            height: point.connectorHeight,
            backgroundColor: 'var(--accent)',
          }}
        />
      )}

      {/* The reveal's transform lives on this wrapper and the press feedback's
          on the button inside it — one transform per element, so the two never
          have to be composed into a single declaration that both want to own. */}
      <div
        className="blocker-add absolute"
        style={{
          left: point.buttonLeft,
          top: point.buttonTop,
          width: ADD_BUTTON,
          height: ADD_BUTTON,
        }}
      >
        <button
          type="button"
          onClick={() => onAdd(point.prerequisiteId)}
          aria-label={`Add a task waiting on "${point.prerequisiteName}"`}
          className="pressable flex h-full w-full items-center justify-center"
        >
          <span
            aria-hidden="true"
            className="flex items-center justify-center rounded-pill"
            style={{
              width: ADD_CIRCLE,
              height: ADD_CIRCLE,
              backgroundColor: 'var(--surface)',
              border: '1.5px solid var(--accent)',
              boxShadow: 'var(--shadow-sm)',
              color: 'var(--accent)',
            }}
          >
            <Plus size={16} />
          </span>
        </button>
      </div>
    </div>
  );
}

function BlockerNodeCard({
  node,
  lookup,
  now,
  onOpen,
}: {
  node: BlockerNode;
  lookup: TaskLookup;
  now: number;
  onOpen(task: Task): void;
}) {
  const task = node.task;
  const done = task.completedAt !== null;
  const waiting = done ? null : blockedBy(task, lookup);
  const gated = waiting !== null;
  const overdue = formatOverdue(task, now);
  const due = overdue ?? formatDue(task, now);

  return (
    <div
      className="blocker-node theme-eased flex h-full items-stretch rounded-control bg-surface"
      data-state={done ? 'completed' : gated ? 'gated' : 'open'}
      style={{
        border: done
          ? '1.5px solid transparent'
          : gated
            ? '1px solid var(--hairline)'
            : '1.5px solid var(--accent)',
        boxShadow: done || gated ? 'none' : 'var(--shadow-sm)',
        transition:
          'background-color 200ms var(--ease-out), border-color 200ms var(--ease-out), color 200ms var(--ease-out), box-shadow 200ms var(--ease-out)',
      }}
    >
      <TaskCheckbox task={task} waitingOn={waiting?.name ?? null} />
      <button
        type="button"
        onClick={() => onOpen(task)}
        className="blocker-node-open pressable min-w-0 flex-1 rounded-control py-3 pr-3 text-left"
        aria-label={`Edit ${task.name}`}
      >
        <span
          className="text-row"
          style={{
            color: done
              ? 'var(--text-tertiary)'
              : gated
                ? 'var(--text-secondary)'
                : 'var(--text)',
            textDecoration: done ? 'line-through' : undefined,
            overflowWrap: 'anywhere',
            transition: 'color 200ms var(--ease-out)',
          }}
        >
          {task.name}
        </span>

        {(due || task.priority) && (
          <span className="mt-2 flex min-w-0 items-center gap-3 overflow-hidden">
            {due && (
              <Chip
                icon={<Clock size={16} />}
                tone={overdue ? 'negative' : gated || done ? 'tertiary' : 'secondary'}
                title={due}
              >
                <span className="max-w-24 truncate">{due}</span>
              </Chip>
            )}
            {task.priority && (
              <Chip
                icon={<Flag size={16} weight="fill" />}
                tone={gated || done ? 'tertiary' : 'accent'}
                aria-label="Priority"
              />
            )}
          </span>
        )}
      </button>
    </div>
  );
}

function StandaloneBoard({ model, onOpen }: { model: BoardModel; onOpen(task: Task): void }) {
  const [expanded, setExpanded] = useState(false);
  const regionId = `standalone-board-${model.board.id}`;
  const count = model.tasks.length;

  return (
    <section className="blockers-bleed border-y border-hairline">
      <button
        type="button"
        className="pressable hoverable flex w-full items-center gap-3 px-gutter text-left"
        style={{ minHeight: 'var(--row-height)' }}
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded((was) => !was)}
      >
        {/* No `truncate` — a board name is not fixed-length vocabulary like
            the count beside it, and this row is the only place this board's
            name appears at all when it has no dependency tree of its own.
            `py-2` is what a wrapped name needs from a row that otherwise only
            promises `min-height`: without it, two lines butt against the
            row's edges instead of sitting inside the same breathing room a
            single line already gets from centring. */}
        <span className="min-w-0 flex-1 py-2 text-row text-text" style={{ overflowWrap: 'anywhere' }}>
          {model.board.name}
        </span>
        <span className="shrink-0 text-meta text-text-secondary">
          {count} {count === 1 ? 'task' : 'tasks'} · no dependencies
        </span>
        <CaretDown
          size={16}
          className="shrink-0 text-text-tertiary"
          style={{
            transform: expanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 160ms var(--ease-out)',
          }}
        />
      </button>

      {expanded && (
        <div id={regionId} className="px-gutter pb-3">
          <div
            className="overflow-y-auto rounded-control bg-surface-2 p-1"
            style={{ maxHeight: '240px', overscrollBehavior: 'contain' }}
          >
            {model.tasks.length === 0 ? (
              <p className="px-3 py-3 text-meta text-text-secondary">No tasks on this board.</p>
            ) : (
              model.tasks.map((task) => (
                <CompactTask key={task.id} task={task} onOpen={onOpen} />
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function CompactTask({ task, onOpen }: { task: Task; onOpen(task: Task): void }) {
  const done = task.completedAt !== null;
  return (
    <div className="flex min-w-0 items-stretch rounded-control">
      <TaskCheckbox task={task} waitingOn={null} compact />
      <button
        type="button"
        onClick={() => onOpen(task)}
        className="pressable hoverable min-w-0 flex-1 rounded-control pr-2 text-left text-meta"
        style={{
          color: done
            ? 'var(--text-tertiary)'
            : task.blocked
              ? 'var(--text-secondary)'
              : 'var(--text)',
          textDecoration: done ? 'line-through' : undefined,
          overflowWrap: 'anywhere',
        }}
      >
        {task.name}
      </button>
    </div>
  );
}

function TaskCheckbox({
  task,
  waitingOn,
  compact = false,
}: {
  task: Task;
  waitingOn: string | null;
  compact?: boolean;
}) {
  const done = task.completedAt !== null;
  const gated = !done && waitingOn !== null;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-disabled={gated || undefined}
      aria-label={
        gated
          ? `"${task.name}" is waiting on "${waitingOn}"`
          : done
            ? `Mark "${task.name}" incomplete`
            : `Complete "${task.name}"`
      }
      data-no-details=""
      onClick={() => toggleComplete(task)}
      className="pressable flex shrink-0 items-center justify-center rounded-control"
      style={{ width: 'var(--tap-target)', minHeight: compact ? 'var(--tap-target)' : undefined }}
    >
      <span
        aria-hidden="true"
        className="flex items-center justify-center rounded-chip"
        style={{
          width: '20px',
          height: '20px',
          color: 'var(--on-accent)',
          backgroundColor: done ? 'var(--accent)' : 'transparent',
          border: done
            ? '1px solid var(--accent)'
            : gated
              ? '1px dashed var(--text-tertiary)'
              : '1px solid color-mix(in srgb, var(--text-tertiary) 60%, transparent)',
          transition:
            'background-color 180ms var(--ease-out), border-color 180ms var(--ease-out)',
        }}
      >
        {done && <Check size={14} weight="bold" />}
      </span>
    </button>
  );
}

/**
 * `heights`, when present, is a real measurement of every node currently in
 * the DOM (`DependencyBoard`'s `useLayoutEffect`) — null on the first render
 * of a tree that has never been measured yet, before which every node is
 * assumed to be `NODE_HEIGHT`, same as when this had no such thing as a tall
 * node at all.
 *
 * The row math changes from "every row is `NODE_HEIGHT + ROW_GAP` tall" to a
 * per-node placement that mirrors `layoutTree`'s own tidy-tree recursion
 * (`shared/blockers.ts`) one level down, in pixels instead of abstract row
 * units: a leaf stacks under the one before it using its *own* height, and a
 * parent centres over the vertical midpoint of its first and last dependant,
 * exactly as `y` already did. Fed uniform heights, this reduces to the same
 * numbers the old `y * rowStride` arithmetic produced — the generalisation is
 * exact, not an approximation, so nothing shifts for a tree with no wrapped
 * names in it.
 */
function geometryOf(layout: BlockerLayout, heights: Map<string, number> | null): Geometry {
  const columnStride = NODE_WIDTH + COLUMN_GAP;
  const maxDepth = layout.trees.reduce((max, tree) => Math.max(max, tree.maxDepth), 0);
  // `ADD_TRAIL` is the room the deepest column's stubs and their plus buttons
  // need to the right of the last node; every shallower column already has a
  // `COLUMN_GAP` of it, and the two are equal by construction.
  const width =
    TREE_PADDING_X * 2 + NODE_WIDTH * (maxDepth + 1) + COLUMN_GAP * maxDepth + ADD_TRAIL;
  const nodes: PositionedNode[] = [];
  const edges: PositionedEdge[] = [];
  const stubs: PositionedStub[] = [];
  const addPoints: AddPoint[] = [];
  let treeTop = TREE_PADDING_Y;

  const heightOf = (taskId: string): number => Math.max(NODE_HEIGHT, heights?.get(taskId) ?? NODE_HEIGHT);

  for (const tree of layout.trees) {
    const byTaskId = new Map(tree.nodes.map((node) => [node.task.id, node]));
    // Relative to this tree's own top starting at 0 — the running `treeTop`
    // is added back in once the whole tree is placed, after the shift below
    // is known. Computing it that way, rather than seeding leaves straight
    // from `treeTop`, is what makes the shift a single subtraction instead of
    // a second walk over every node.
    const relativeTop = new Map<string, number>();

    // Leaves stack in the tidy-tree's own top-to-bottom order. `node.y` from
    // `shared/blockers.ts` already carries it — each leaf's sequential index
    // in that walk — so sorting by it and then stacking by real height keeps
    // the visual order `layoutTree` intended instead of whatever order this
    // file's own flat `tree.nodes` array happens to list them in.
    const leaves = tree.nodes
      .filter((node) => node.dependentIds.length === 0)
      .sort((a, b) => a.y - b.y);
    let cursor = 0;
    for (const leaf of leaves) {
      relativeTop.set(leaf.task.id, cursor);
      cursor += heightOf(leaf.task.id) + ROW_GAP;
    }

    // Every parent centres over the vertical midpoint of its first and last
    // dependant, same as the row-index math already did — post-order, since
    // the formula reads its children's placed positions, which the leaf pass
    // above already seeded.
    function place(taskId: string): number {
      const existing = relativeTop.get(taskId);
      if (existing !== undefined) return existing;
      const children = byTaskId.get(taskId)?.dependentIds ?? [];
      const firstMid = place(children[0]) + heightOf(children[0]) / 2;
      const lastMid = place(children[children.length - 1]) + heightOf(children[children.length - 1]) / 2;
      const placed = (firstMid + lastMid) / 2 - heightOf(taskId) / 2;
      relativeTop.set(taskId, placed);
      return placed;
    }
    for (const node of tree.nodes) place(node.task.id);

    // A short chain topped by a node several wrapped lines tall centres that
    // tall node over its one short child and can come out above where the
    // tree is meant to start — there is no leaf above it to have claimed that
    // space in the first place. Shifting every node in the tree down by
    // however far negative the least of them went keeps the centring intact
    // (nothing here is clamped independently) while guaranteeing the whole
    // tree lands inside its own bounds.
    const minRelativeTop = Math.min(
      ...tree.nodes.map((node) => relativeTop.get(node.task.id) as number),
    );
    const shift = treeTop - minRelativeTop;
    const pixelTop = (taskId: string): number => (relativeTop.get(taskId) as number) + shift;

    for (const node of tree.nodes) {
      nodes.push({
        node,
        x: TREE_PADDING_X + node.depth * columnStride,
        y: pixelTop(node.task.id),
      });
    }

    for (const child of tree.nodes) {
      if (child.parentId === null) continue;
      const parent = byTaskId.get(child.parentId);
      if (!parent) continue;

      const startX = TREE_PADDING_X + parent.depth * columnStride + NODE_WIDTH;
      const startY = pixelTop(child.parentId) + heightOf(child.parentId) / 2;
      const endX = TREE_PADDING_X + child.depth * columnStride;
      const endY = pixelTop(child.task.id) + heightOf(child.task.id) / 2;
      const controlX = startX + (endX - startX) / 2;
      edges.push({
        id: `${child.parentId}:${child.task.id}`,
        parentId: child.parentId,
        childId: child.task.id,
        path: `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`,
      });

      // The curve's own midpoint, not the midpoint of its endpoints — which
      // for this particular cubic are the same thing: both control points sit
      // on the vertical halfway line, so the t=0.5 term
      // (P0 + 3P1 + 3P2 + P3) / 8 collapses to the average of the ends.
      addPoints.push(
        addPointAt(
          `edge:${child.parentId}:${child.task.id}`,
          child.parentId,
          parent.task.name,
          (startX + endX) / 2,
          (startY + endY) / 2,
        ),
      );
    }

    // A node nothing waits on has no line to hover, so it gets one: a short
    // stub off its right edge, always drawn, leading to where its plus appears.
    for (const node of tree.nodes) {
      if (node.dependentIds.length > 0) continue;
      const right = TREE_PADDING_X + node.depth * columnStride + NODE_WIDTH;
      const centreY = pixelTop(node.task.id) + heightOf(node.task.id) / 2;
      stubs.push({
        id: `stub:${node.task.id}`,
        path: `M ${right} ${centreY} L ${right + ADD_STUB} ${centreY}`,
      });
      addPoints.push({
        id: `stub:${node.task.id}`,
        prerequisiteId: node.task.id,
        prerequisiteName: node.task.name,
        left: right,
        top: centreY - ADD_BUTTON / 2,
        width: ADD_TRAIL,
        height: ADD_BUTTON,
        // The stub already runs to the circle's edge; a second connector
        // would double it.
        buttonLeft: ADD_STUB - (ADD_BUTTON - ADD_CIRCLE) / 2,
        buttonTop: 0,
        connectorTop: null,
        connectorHeight: 0,
      });
    }

    // The bottommost edge any node in this tree reaches — a tall node near
    // the end can extend past where the last leaf alone would have put it,
    // and the old formula (leaf count times a fixed row height) had no way to
    // know that because every row was the same height by definition.
    const treeBottom = tree.nodes.reduce(
      (max, node) => Math.max(max, pixelTop(node.task.id) + heightOf(node.task.id)),
      treeTop,
    );
    treeTop = treeBottom + TREE_GAP;
  }

  const height = Math.max(
    NODE_HEIGHT + TREE_PADDING_Y * 2,
    treeTop - TREE_GAP + TREE_PADDING_Y,
  );
  const leftmost = nodes
    .filter(({ node }) => node.task.completedAt === null)
    .sort((a, b) => a.x - b.x || a.y - b.y)[0];

  return {
    nodes,
    edges,
    stubs,
    addPoints,
    width,
    height,
    leftmostIncompleteX: leftmost?.x ?? null,
  };
}

/**
 * One hover region centred on a point of a dependency line, with its plus
 * raised above it.
 *
 * The region reaches from the top of the button down past the line, so the
 * pointer never crosses dead space on its way up from the line to the circle —
 * the reveal is a single `:hover` on this box, not two hovers with a gap
 * between them.
 */
function addPointAt(
  id: string,
  prerequisiteId: string,
  prerequisiteName: string,
  x: number,
  y: number,
): AddPoint {
  const rise = ADD_RISE + ADD_BUTTON / 2;
  const circleBottom = ADD_BUTTON / 2 + ADD_CIRCLE / 2;
  return {
    id,
    prerequisiteId,
    prerequisiteName,
    left: x - ADD_HOTSPOT_WIDTH / 2,
    top: y - rise,
    width: ADD_HOTSPOT_WIDTH,
    height: rise + ADD_TAIL,
    buttonLeft: (ADD_HOTSPOT_WIDTH - ADD_BUTTON) / 2,
    buttonTop: 0,
    connectorTop: circleBottom,
    connectorHeight: rise - circleBottom,
  };
}

function useAutoScrollOnMount(
  scroll: RefObject<HTMLDivElement | null>,
  targetX: number | null,
) {
  const initialTarget = useRef(targetX);
  const fired = useRef(false);

  useLayoutEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const element = scroll.current;
    const left = initialTarget.current;
    if (!element || left === null) return;

    element.scrollTo({
      left: Math.max(0, left - 12),
      behavior: prefersReducedMotion() || keyboardMotionActive() ? 'auto' : 'smooth',
    });
  }, [scroll]);
}

function BlockersSkeleton() {
  return (
    <div className="grid gap-3" aria-label="Loading blockers">
      {[0, 1].map((row) => (
        <div key={row} className="blockers-bleed border-y border-hairline">
          <div className="flex" style={{ minHeight: row === 0 ? 280 : 180 }}>
            <div className="blockers-sidebar shrink-0 p-4">
              <Skeleton width="70%" height="1rem" />
              <div className="mt-2">
                <Skeleton width="45%" height="0.75rem" />
              </div>
            </div>
            <div className="flex items-center gap-12 px-6">
              <NodeSkeleton />
              <NodeSkeleton />
              {row === 0 && <NodeSkeleton />}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function NodeSkeleton() {
  return (
    <div className="shrink-0 rounded-control bg-surface p-4" style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}>
      <Skeleton width="75%" height="1rem" />
      <div className="mt-3">
        <Skeleton width="45%" height="0.75rem" />
      </div>
    </div>
  );
}

function BlockersError() {
  const load = useStore((state) => state.load);
  const failure = useStore((state) => state.failure);
  return (
    <ErrorLine
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      }
    >
      {loadErrorMessage('your dependency trees', failure)}
    </ErrorLine>
  );
}

function byTaskPosition(a: Task, b: Task): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
