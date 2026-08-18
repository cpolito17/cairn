/**
 * Blockers. PROJECT-SPEC-V2.md §7.
 *
 * Each active board is one independently scrolling horizontal row. The
 * dependency graph — columns, rows, and the route every edge takes — is the
 * pure result of `shared/blockers.ts`; this screen turns that into pixels,
 * draws one SVG edge layer, and wires the existing composer and completion
 * action to the nodes.
 *
 * The one thing it adds on its own is a way to *extend* a chain: every
 * dependency line carries a hover point that opens the composer in create mode
 * with the link already pointing at the task that line leaves from, and a node
 * with nothing after it grows a stub so it has such a point too. Nothing about
 * it is stored — a created task goes through the same `addTask` every other
 * surface uses, and the graph redraws from the store.
 */

import { CaretDown, Check, Clock, DotsSixVertical, Flag, Plus } from '@phosphor-icons/react';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  ConnectLine,
  useConnectDrag,
  type Anchor,
  type ConnectHandlers,
  type ConnectState,
} from '../components/blockers/connect';
import {
  layoutBlockers,
  type BlockerLayout,
  type BlockerNode,
} from '../../shared/blockers';
import {
  blockedBy,
  lookupOf,
  waitingSummary,
  type TaskLookup,
} from '../../shared/dependencies';
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
 * An edge point sits in the **first** gap the edge travels through, which is
 * always free of cards — so a plus never lands on an intermediate column, and
 * a node with a distant dependent still gets one. A stub belongs only to a node
 * with no dependents at all: one that has them already has a line leaving its
 * right edge, and drawing a stub as well put a second stroke and a plus
 * straight on top of the real edge.
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

/**
 * How wide an edge is to *press*, as opposed to how wide it is to look at.
 *
 * The drawn stroke is 1.5px and nothing can be reliably grabbed at 1.5px, least
 * of all with a finger. 24 is the compromise: comfortably wider than a
 * fingertip's accuracy along a curve, and narrow enough that two edges running
 * a `ROW_GAP` apart still have their own targets.
 */
const EDGE_GRAB = 24;

/** The connect dot on a node's right edge, and its tap target around it. */
const HANDLE_DOT = 12;
const HANDLE_TARGET = 44;

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
  /** Measured, so a wrapped name still anchors its edges at its true middle. */
  height: number;
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
  /**
   * True for the stub points at the end of a chain, which stay visible without
   * a hover.
   *
   * The edge points can afford to wait for a hover: the line they sit on is
   * already drawn, so the picture is complete without them. A stub is not — it
   * is a line trailing off into nothing, drawn *for* the plus — so hiding its
   * plus at rest left a dangling stroke and no way to guess what it was for.
   */
  restingVisible?: boolean;
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
  // waiting on — which is the whole content of the gesture that opened it. The
  // Standalone well's own "+" passes null, because a task created there is
  // deliberately unlinked; that is what "standalone" means.
  const [creating, setCreating] = useState<{
    boardId: string;
    dependsOn: string | null;
  } | null>(null);

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
          hasTrees: layout.graphs.length > 0,
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
                onCreate={() => setCreating({ boardId: model.board.id, dependsOn: null })}
              />
            ) : (
              <StandaloneBoard
                key={model.board.id}
                model={model}
                onOpen={setEditing}
                onCreate={() => setCreating({ boardId: model.board.id, dependsOn: null })}
              />
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
          {...(creating.dependsOn === null ? {} : { initialDependsOn: creating.dependsOn })}
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
  onCreate,
}: {
  model: BoardModel;
  onOpen(task: Task): void;
  onAdd(prerequisiteId: string): void;
  onCreate(): void;
}) {
  const lookup = useMemo(() => lookupOf(model.tasks), [model.tasks]);
  const byId = useMemo(
    () => new Map(model.tasks.map((task) => [task.id, task])),
    [model.tasks],
  );
  const scroll = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const connect = useConnectDrag(layer, scroll);
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
    for (const graph of model.layout.graphs) {
      for (const node of graph.nodes) {
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

  // Where a live drag's line is pinned. A connect leaves the source's right
  // edge; a retarget hangs off the dependent's left edge, because that is the
  // end the gesture keeps. A splice has no anchor at all — it carries a chip
  // instead, since what is moving is a task and not a line.
  const anchor = useMemo((): Anchor | null => {
    const state = connect.state;
    if (!state || state.intent.kind === 'splice') return null;
    const id =
      state.intent.kind === 'connect' ? state.intent.sourceId : state.intent.toId;
    const placed = geometry.nodes.find(({ node }) => node.task.id === id);
    if (!placed) return null;
    return {
      x: state.intent.kind === 'connect' ? placed.x + NODE_WIDTH : placed.x,
      y: placed.y + placed.height / 2,
    };
  }, [connect.state, geometry.nodes]);

  const dragging = connect.state !== null;

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
          {/* Always present now: the well holds the board's unlinked tasks and
              its own "+", so a board with a tree and nothing loose still has
              somewhere to create one. Tasks here are drag sources — hold one
              and drop it on a line to splice it in. */}
          <aside className="blockers-sidebar z-20 shrink-0 p-4">
            <div
              className="overflow-y-auto rounded-control bg-surface-2 p-1"
              style={{ maxHeight: '240px', overscrollBehavior: 'contain' }}
            >
              <div className="flex items-center gap-1 px-2 pb-1 pt-2">
                <p className="min-w-0 flex-1 text-meta text-text-tertiary">Standalone</p>
                <AddStandalone onClick={onCreate} />
              </div>
              {model.layout.standalone.length === 0 ? (
                <p className="px-2 pb-2 text-meta text-text-tertiary">Nothing loose.</p>
              ) : (
                model.layout.standalone.map((task) => (
                  <CompactTask
                    key={task.id}
                    task={task}
                    onOpen={onOpen}
                    draggable={connect}
                  />
                ))
              )}
            </div>
          </aside>

          <div
            ref={layer}
            // `blockers-dragging` suppresses text selection and pins the cursor
            // to `grabbing` for the whole layer. Without it, dragging a line
            // across a node's name starts a text selection under the gesture —
            // the pointer is captured so the drag still works, but it leaves a
            // trail of highlighted words behind it.
            className={`relative shrink-0${dragging ? ' blockers-dragging' : ''}`}
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
                const lit = isEdgeTarget(connect.state, edge);
                return (
                  <path
                    key={edge.id}
                    d={edge.path}
                    fill="none"
                    stroke={
                      lit
                        ? 'var(--accent)'
                        : released
                          ? 'color-mix(in srgb, var(--positive) 60%, transparent)'
                          : 'var(--text-tertiary)'
                    }
                    strokeWidth={lit ? 3 : 1.5}
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

            {/* The grab layer. One fat transparent stroke per edge, carrying the
                data attributes `connect.tsx` hit-tests against — the drawn edge
                above is 1.5px and nobody can reliably press 1.5px.

                It sits *below* the add points in DOM order on purpose: where the
                plus's hover region crosses the line it belongs to, the plus
                wins, so the affordance that was already there keeps its whole
                target and this one gives up a sliver. Everywhere else along the
                edge — which is most of it — the grab is live. */}
            <svg
              aria-hidden="true"
              className="absolute inset-0 block"
              width={geometry.width}
              height={geometry.height}
              style={{ pointerEvents: 'none' }}
            >
              {geometry.edges.map((edge) => (
                <path
                  key={edge.id}
                  data-edge-from={edge.parentId}
                  data-edge-to={edge.childId}
                  d={edge.path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={EDGE_GRAB}
                  strokeLinecap="round"
                  onPointerDown={(event) =>
                    connect.begin(event, {
                      kind: 'retarget',
                      fromId: edge.parentId,
                      toId: edge.childId,
                    })
                  }
                  style={{
                    pointerEvents: 'stroke',
                    cursor: 'grab',
                    // The row scrolls horizontally underneath; this says the
                    // stroke is not part of that, so a touch on it drags the
                    // edge instead of panning the board.
                    touchAction: 'none',
                  }}
                />
              ))}
            </svg>

            {geometry.addPoints.map((point) => (
              <AddAfter key={point.id} point={point} onAdd={onAdd} />
            ))}

            {geometry.nodes.map(({ node, x, y, height }) => (
              <div
                key={node.task.id}
                ref={(el) => {
                  if (el) nodeRefs.current.set(node.task.id, el);
                  else nodeRefs.current.delete(node.task.id);
                }}
                data-blocker-node={node.task.id}
                // The hotspot class is what reveals the connect dot: the dot is
                // hidden at rest on a fine pointer and hovering *the node* is
                // how it is found. Hovering the dot itself keeps it (see
                // `.blocker-connect-handle` in index.css), so the pointer never
                // crosses dead space on its way out to the overhang.
                className="blocker-add-hotspot absolute left-0 top-0"
                style={{
                  width: NODE_WIDTH,
                  // A floor, not a fixed height — §7's line-clamp used to cut
                  // a long name off at two lines to stay inside NODE_HEIGHT;
                  // now the box grows for it instead, and the row spacing
                  // above already left it the room (`geometryOf`, measured
                  // against exactly this element).
                  minHeight: NODE_HEIGHT,
                  transform: `translate3d(${x}px, ${y}px, 0)`,
                  // **A column flex box, so the card inside actually fills it.**
                  //
                  // This is what keeps every edge on a node's true middle. The
                  // geometry draws each endpoint at `pixelTop + heightOf / 2`,
                  // where `heightOf` is what *this* element measured — so the
                  // card the reader sees has to be exactly this tall, or the
                  // line lands on the middle of a box that is not the one drawn.
                  //
                  // It used to not be. The card asked for `height: 100%`, and a
                  // percentage height resolves against the parent's *height* —
                  // which is `auto` here, since `minHeight` is only a floor. CSS
                  // says an unresolvable percentage height becomes `auto`, so
                  // the card fell back to its content and sat at the top of a
                  // taller box, leaving dead space underneath. The error was
                  // invisible on a node whose name wrapped to the full 88px and
                  // grew with every line it did not need — which is exactly the
                  // "some of them look fine" shape of the bug.
                  //
                  // Stretching a flex item does not go through percentage
                  // resolution at all, so there is nothing left to fail.
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {/* `flex-1` takes the wrapper's full height; `flex` makes this a
                    row so the card stretches to it by `align-items: stretch`
                    rather than by another percentage. */}
                <TaskDetails task={node.task} className="flex min-h-0 flex-1" touchLongPress>
                  <BlockerNodeCard
                    node={node}
                    lookup={lookup}
                    now={now}
                    onOpen={onOpen}
                    drop={dropStateFor(connect.state, node.task.id)}
                  />
                </TaskDetails>

                <ConnectHandle
                  task={node.task}
                  centreY={height / 2}
                  onBegin={(event) =>
                    connect.begin(event, { kind: 'connect', sourceId: node.task.id })
                  }
                />
              </div>
            ))}

            {/* The live drag, above everything and inert. */}
            {connect.state && (
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-30 block"
                width={geometry.width}
                height={geometry.height}
              >
                <ConnectLine anchor={anchor} state={connect.state} />
              </svg>
            )}

            {connect.state?.intent.kind === 'splice' && (
              <SpliceChip
                name={byId.get(connect.state.intent.taskId)?.name ?? ''}
                x={connect.state.x}
                y={connect.state.y}
                valid={connect.state.valid}
              />
            )}
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
      className={`blocker-add-hotspot absolute${point.restingVisible ? ' blocker-add-resting' : ''}`}
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

/**
 * The connect dot: press it and drag to another node to make that node wait on
 * this one.
 *
 * It sits on the node's right edge, which is the edge every dependency line
 * already leaves from — so the gesture starts where the result will be drawn.
 * Hidden until the node is hovered or keyboard-focused on a fine pointer, and
 * quietly present on touch, exactly as the "add after" plus is: two affordances
 * on the same page that appeared by different rules would read as two pages.
 *
 * Its 44px target overlaps the left sliver of the first add point's hover
 * region. The dot wins there — it is the smaller, more deliberate control, and
 * the plus keeps its circle and the rest of its region.
 */
function ConnectHandle({
  task,
  centreY,
  onBegin,
}: {
  task: Task;
  centreY: number;
  onBegin(event: ReactPointerEvent): void;
}) {
  return (
    <div
      className="blocker-connect-handle absolute"
      style={{
        left: NODE_WIDTH - HANDLE_TARGET / 2,
        top: centreY - HANDLE_TARGET / 2,
        width: HANDLE_TARGET,
        height: HANDLE_TARGET,
      }}
    >
      <button
        type="button"
        // Not `pressable`: a press here is the first frame of a drag, and a
        // 0.97 scale under the finger would move the thing being aimed with.
        className="blocker-add flex h-full w-full items-center justify-center"
        aria-label={`Draw a dependency from "${task.name}"`}
        onPointerDown={onBegin}
        style={{ cursor: 'grab', touchAction: 'none' }}
      >
        <span
          aria-hidden="true"
          className="block rounded-pill"
          style={{
            width: HANDLE_DOT,
            height: HANDLE_DOT,
            backgroundColor: 'var(--surface)',
            border: '2px solid var(--accent)',
          }}
        />
      </button>
    </div>
  );
}

/**
 * What a live drag means for one node: nothing, a legal landing, or a refusal.
 *
 * Refusals are drawn as well as approvals, deliberately. A node that simply
 * fails to light up is indistinguishable from one the pointer has not reached,
 * and the user would keep trying. Dimming it says "not this one" while the
 * gesture is still in the air, which is the only moment the answer is useful.
 */
type DropState = 'none' | 'valid' | 'invalid';

function dropStateFor(state: ConnectState | null, taskId: string): DropState {
  if (!state || state.intent.kind === 'splice') return 'none';
  if (state.target?.kind !== 'node' || state.target.id !== taskId) return 'none';
  return state.valid ? 'valid' : 'invalid';
}

/** True while a splice drag is hovering this particular edge and would take. */
function isEdgeTarget(state: ConnectState | null, edge: PositionedEdge): boolean {
  return (
    state !== null &&
    state.valid &&
    state.target?.kind === 'edge' &&
    state.target.fromId === edge.parentId &&
    state.target.toId === edge.childId
  );
}

/**
 * The task riding under the pointer during a splice.
 *
 * A rubber line would be the wrong picture here: nothing is being connected
 * end-to-end, a whole task is being carried onto a line. So it is a chip with
 * the name in it — the same thing the user pressed, still legible, offset from
 * the pointer so the finger is not covering the answer.
 */
function SpliceChip({
  name,
  x,
  y,
  valid,
}: {
  name: string;
  x: number;
  y: number;
  valid: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-30 max-w-48 truncate rounded-chip px-2 py-1
                 text-meta"
      style={{
        left: 0,
        top: 0,
        transform: `translate3d(${x + 14}px, ${y + 14}px, 0)`,
        backgroundColor: 'var(--surface)',
        border: `1.5px solid ${valid ? 'var(--accent)' : 'var(--hairline)'}`,
        boxShadow: 'var(--shadow-md)',
        color: valid ? 'var(--text)' : 'var(--text-secondary)',
      }}
    >
      {name}
    </div>
  );
}

/** The Standalone well's "+". Creates an unlinked task on this board. */
function AddStandalone({ onClick }: { onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="New task on this board"
      className="pressable hoverable -my-2 flex shrink-0 items-center justify-center rounded-chip
                 text-text-secondary"
      style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
    >
      <Plus size={16} />
    </button>
  );
}

function BlockerNodeCard({
  node,
  lookup,
  now,
  onOpen,
  drop = 'none',
}: {
  node: BlockerNode;
  lookup: TaskLookup;
  now: number;
  onOpen(task: Task): void;
  drop?: DropState;
}) {
  const task = node.task;
  const done = task.completedAt !== null;
  const waiting = done ? [] : blockedBy(task, lookup);
  const gated = waiting.length > 0;
  const overdue = formatOverdue(task, now);
  const due = overdue ?? formatDue(task, now);

  return (
    <div
      // `w-full`, not `h-full`. This is a flex item of the wrapper above now, so
      // its height comes from `align-items: stretch` — but a flex item sizes to
      // its *content* horizontally, which a block box did not, so the width is
      // the half that has to be asked for.
      className="blocker-node theme-eased flex w-full items-stretch rounded-control bg-surface"
      data-state={done ? 'completed' : gated ? 'gated' : 'open'}
      style={{
        // A live drop target overrides the state ring while the drag is in the
        // air, and gives it back the moment the pointer leaves. It is the same
        // 1.5px ring, recoloured — a node that changed size or weight under the
        // pointer would move the target the user is aiming at.
        border:
          drop === 'valid'
            ? '1.5px solid var(--accent)'
            : drop === 'invalid'
              ? '1.5px solid var(--hairline)'
              : done
                ? '1.5px solid transparent'
                : gated
                  ? '1px solid var(--hairline)'
                  : '1.5px solid var(--accent)',
        boxShadow:
          drop === 'valid' ? 'var(--shadow-md)' : done || gated ? 'none' : 'var(--shadow-sm)',
        opacity: drop === 'invalid' ? 0.5 : 1,
        transition:
          'background-color 200ms var(--ease-out), border-color 200ms var(--ease-out), color 200ms var(--ease-out), box-shadow 200ms var(--ease-out), opacity 160ms var(--ease-out)',
      }}
    >
      <TaskCheckbox task={task} waitingOn={waitingSummary(waiting)} />
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

function StandaloneBoard({
  model,
  onOpen,
  onCreate,
}: {
  model: BoardModel;
  onOpen(task: Task): void;
  onCreate(): void;
}) {
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
            <div className="flex items-center gap-1 px-2 pb-1 pt-2">
              <p className="min-w-0 flex-1 text-meta text-text-tertiary">Standalone</p>
              <AddStandalone onClick={onCreate} />
            </div>
            {/* No drag grips here. This board has no dependency lines at all,
                so there is nothing on screen to splice a task into — offering
                the gesture would be offering a drop with no target. */}
            {model.tasks.length === 0 ? (
              <p className="px-2 pb-2 text-meta text-text-secondary">No tasks on this board.</p>
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

/**
 * A row in the Standalone well.
 *
 * With `draggable`, it grows a grip on its right edge that is the splice drag's
 * source: hold it and drop the task onto a dependency line to land it inside
 * that line. The grip is a separate target rather than the whole row because
 * the row's own job is to open the composer, and a row that is both a button
 * and a drag handle makes every press a guess about which one it was.
 *
 * The hold is a touch rule — the well scrolls vertically, so a press that
 * became a drag immediately would make it impossible to scroll. A mouse gets
 * the ordinary 6px slop (`connect.tsx`).
 */
function CompactTask({
  task,
  onOpen,
  draggable,
}: {
  task: Task;
  onOpen(task: Task): void;
  draggable?: ConnectHandlers;
}) {
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

      {draggable && (
        <span className="blocker-add-hotspot flex shrink-0 items-center">
          <button
            type="button"
            aria-label={`Drag "${task.name}" onto a dependency line`}
            className="blocker-add flex items-center justify-center text-text-tertiary"
            style={{ width: '28px', alignSelf: 'stretch', cursor: 'grab', touchAction: 'none' }}
            onPointerDown={(event) =>
              draggable.beginOnHold(event, { kind: 'splice', taskId: task.id })
            }
            onClick={(event) => {
              // The click that follows a drag's release is that release, not a
              // tap on the grip. Swallow it, and let an ordinary press through.
              if (draggable.dragged.current) {
                event.preventDefault();
                draggable.dragged.current = false;
              }
            }}
          >
            <DotsSixVertical size={16} />
          </button>
        </span>
      )}
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
/**
 * Rows and depths from `shared/blockers.ts`, turned into pixels.
 *
 * The vertical pass is where a graph differs most from the forest this used to
 * draw. With one prerequisite per task, a parent could be centred exactly over
 * its children and that was the end of it. With several, no single position
 * satisfies every edge, so the placement is two sweeps over the columns:
 *
 *   1. **Left to right**, each vertex pulled to the average centre of the
 *      prerequisites already placed to its left, then pushed down if that would
 *      overlap the one above it in its own column.
 *   2. **Right to left**, balancing *both* sides. Pulling only towards
 *      dependents looks right on a chain and wrong on a fork: the task two
 *      branches converge into gets dragged into line with whatever follows it
 *      instead of sitting between the two things it is waiting for.
 *
 * **Both sweeps run over vertices, not nodes** — bends included. A bend has no
 * height but it does hold a row, so it competes for vertical space and shoves
 * real cards aside to make a channel for the edge passing through. That is what
 * keeps V2 §7.2's "edges never pass through a node" true now that an edge can
 * span more than one column.
 *
 * Neither sweep moves a vertex out of its layer's order, so the ordering
 * `shared/blockers.ts` computed — and its stability — survives.
 */
function geometryOf(layout: BlockerLayout, heights: Map<string, number> | null): Geometry {
  const columnStride = NODE_WIDTH + COLUMN_GAP;
  const maxDepth = layout.graphs.reduce((max, graph) => Math.max(max, graph.maxDepth), 0);
  // `ADD_TRAIL` is the room the deepest column's stubs and their plus buttons
  // need to the right of the last node; every shallower column already has a
  // `COLUMN_GAP` of it.
  const width =
    TREE_PADDING_X * 2 + NODE_WIDTH * (maxDepth + 1) + COLUMN_GAP * maxDepth + ADD_TRAIL;
  const nodes: PositionedNode[] = [];
  const edges: PositionedEdge[] = [];
  const stubs: PositionedStub[] = [];
  const addPoints: AddPoint[] = [];
  let graphTop = TREE_PADDING_Y;

  for (const graph of layout.graphs) {
    const byVertexId = new Map(graph.vertices.map((vertex) => [vertex.id, vertex]));
    const byTaskId = new Map(graph.nodes.map((node) => [node.task.id, node]));

    // A bend is a point, not a box. Zero height still leaves it a full
    // `ROW_GAP` of clearance on each side, which is the channel the line runs
    // down.
    const heightOf = (id: string): number =>
      byVertexId.get(id)?.task === null
        ? 0
        : Math.max(NODE_HEIGHT, heights?.get(id) ?? NODE_HEIGHT);

    const top = new Map<string, number>();
    const centreOf = (id: string): number => (top.get(id) as number) + heightOf(id) / 2;

    /**
     * Place one column in its given order, each vertex as near its wish as the
     * one above it allows. Only ever pushes down, so the order is preserved
     * exactly; the whole component is normalised afterwards.
     */
    const placeLayer = (ids: string[], wish: (id: string) => number | null) => {
      let floor = -Infinity;
      for (const id of ids) {
        const height = heightOf(id);
        const wanted = wish(id);
        const desired = wanted === null ? (top.get(id) ?? 0) : wanted - height / 2;
        const placed = Math.max(desired, floor);
        top.set(id, placed);
        floor = placed + height + ROW_GAP;
      }
    };

    const meanCentre = (ids: readonly string[]): number | null => {
      const placed = ids.filter((id) => top.has(id));
      if (placed.length === 0) return null;
      return placed.reduce((sum, id) => sum + centreOf(id), 0) / placed.length;
    };

    // Sweep one: left to right, pulled by prerequisites.
    for (let depth = 0; depth <= graph.maxDepth; depth += 1) {
      placeLayer(graph.layers[depth], (id) =>
        meanCentre(byVertexId.get(id)?.prerequisiteIds ?? []),
      );
    }

    // Sweep two: right to left, balancing both directions.
    for (let depth = graph.maxDepth - 1; depth >= 0; depth -= 1) {
      placeLayer(graph.layers[depth], (id) => {
        const vertex = byVertexId.get(id);
        return meanCentre([...(vertex?.prerequisiteIds ?? []), ...(vertex?.dependentIds ?? [])]);
      });
    }

    // A component whose pulls sent its topmost vertex above where it should
    // start is shifted down bodily, which keeps every relative position intact
    // while guaranteeing it lands inside its own bounds.
    const minTop = Math.min(...graph.vertices.map((vertex) => top.get(vertex.id) as number));
    const shift = graphTop - minTop;
    const pixelTop = (id: string): number => (top.get(id) as number) + shift;
    const pixelCentre = (id: string): number => pixelTop(id) + heightOf(id) / 2;
    const columnX = (depth: number): number => TREE_PADDING_X + depth * columnStride;

    for (const node of graph.nodes) {
      nodes.push({
        node,
        x: columnX(node.depth),
        y: pixelTop(node.task.id),
        height: heightOf(node.task.id),
      });
    }

    // Edges, one per prerequisite, routed through their bends. Several arriving
    // at the same task all end at the centre of its left edge, so they visibly
    // *flow into* it rather than merely stopping near it — which is the whole
    // point of drawing a fan-in.
    for (const edge of graph.edges) {
      const from = byTaskId.get(edge.fromId);
      const to = byTaskId.get(edge.toId);
      if (!from || !to) continue;

      const points = [
        { x: columnX(from.depth) + NODE_WIDTH, y: pixelCentre(edge.fromId) },
        ...edge.bends.map((bend) => ({
          // The bend sits at the middle of the column it is crossing, in a row
          // no card occupies.
          x: columnX(bend.depth) + NODE_WIDTH / 2,
          y: pixelCentre(bend.id),
        })),
        { x: columnX(to.depth), y: pixelCentre(edge.toId) },
      ];

      edges.push({
        id: `${edge.fromId}:${edge.toId}`,
        parentId: edge.fromId,
        childId: edge.toId,
        path: pathThrough(points),
      });

      // The plus goes in the **first** gap the edge travels through — the one
      // immediately right of the prerequisite, which is always free of cards.
      // For a one-column edge that is the curve's own midpoint, exactly as
      // before; for a longer one it is the first leg's, which keeps the button
      // off both the intermediate columns and the edge it belongs to.
      addPoints.push(
        addPointAt(
          `edge:${edge.fromId}:${edge.toId}`,
          edge.fromId,
          from.task.name,
          (points[0].x + points[1].x) / 2,
          (points[0].y + points[1].y) / 2,
        ),
      );
    }

    // A node nothing waits on has no edge leaving it, so it gets a stub: a
    // short line off its right edge leading to a plus. This is also the only
    // at-rest hint the affordance exists anywhere.
    //
    // Only true leaves qualify. A node that *does* have dependents already has
    // a line leaving its right edge and an add point on it, and drawing a stub
    // as well put a second stroke — and a plus — straight on top of the real
    // edge.
    for (const node of graph.nodes) {
      if (node.dependentIds.length > 0) continue;

      const right = columnX(node.depth) + NODE_WIDTH;
      const centreY = pixelCentre(node.task.id);
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
        // The at-rest affordance. Edge points appear on hover because the line
        // they belong to is already visible; this one *is* the visible thing,
        // and a stub trailing off into nothing was the whole of the hint.
        restingVisible: true,
      });
    }

    const graphBottom = graph.vertices.reduce(
      (max, vertex) => Math.max(max, pixelTop(vertex.id) + heightOf(vertex.id)),
      graphTop,
    );
    graphTop = graphBottom + TREE_GAP;
  }

  const height = Math.max(
    NODE_HEIGHT + TREE_PADDING_Y * 2,
    graphTop - TREE_GAP + TREE_PADDING_Y,
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
 * A smooth path through a run of points, left to right.
 *
 * One cubic per leg, control points on the vertical halfway line between the
 * two ends — so every leg leaves and arrives horizontally, and the joins at the
 * bends are smooth because both sides are flat there. For a single leg this is
 * byte-for-byte the curve the forest drew.
 */
function pathThrough(points: readonly { x: number; y: number }[]): string {
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const controlX = from.x + (to.x - from.x) / 2;
    path += ` C ${controlX} ${from.y}, ${controlX} ${to.y}, ${to.x} ${to.y}`;
  }
  return path;
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
