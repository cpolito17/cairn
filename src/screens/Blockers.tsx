/**
 * Blockers. PROJECT-SPEC-V2.md §7.
 *
 * Each active board is one independently scrolling horizontal row. Dependency
 * trees are the pure result of `shared/blockers.ts`; this screen only turns its
 * depth and tidy-tree rows into pixels, draws one SVG edge layer, and wires the
 * existing composer and completion action to the nodes.
 */

import { CaretDown, Check, Clock, Flag } from '@phosphor-icons/react';
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

interface Geometry {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
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
              <DependencyBoard key={model.board.id} model={model} onOpen={setEditing} />
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
    </>
  );
}

function DependencyBoard({ model, onOpen }: { model: BoardModel; onOpen(task: Task): void }) {
  const geometry = useMemo(() => geometryOf(model.layout), [model.layout]);
  const lookup = useMemo(() => lookupOf(model.tasks), [model.tasks]);
  const byId = useMemo(
    () => new Map(model.tasks.map((task) => [task.id, task])),
    [model.tasks],
  );
  const scroll = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());

  useAutoScrollOnMount(scroll, geometry.leftmostIncompleteX);

  return (
    <section
      className="blockers-bleed overflow-hidden border-y border-hairline"
      aria-labelledby={`blocker-board-${model.board.id}`}
    >
      <div ref={scroll} className="blockers-board-scroll">
        <div className="flex min-w-max items-stretch" style={{ minHeight: geometry.height }}>
          <aside className="blockers-sidebar z-20 shrink-0 p-4">
            <h2
              id={`blocker-board-${model.board.id}`}
              className="truncate text-row text-text"
              style={{ fontWeight: 600 }}
            >
              {model.board.name}
            </h2>
            <p className="mt-1 text-meta text-text-secondary">{model.progress.percent}% complete</p>

            {model.layout.standalone.length > 0 && (
              <div
                className="mt-5 overflow-y-auto rounded-control bg-surface-2 p-1"
                style={{ maxHeight: '240px', overscrollBehavior: 'contain' }}
              >
                <p className="px-2 pb-1 pt-2 text-meta text-text-tertiary">Standalone</p>
                {model.layout.standalone.map((task) => (
                  <CompactTask key={task.id} task={task} onOpen={onOpen} />
                ))}
              </div>
            )}
          </aside>

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
            </svg>

            {geometry.nodes.map(({ node, x, y }) => (
              <div
                key={node.task.id}
                data-blocker-node={node.task.id}
                className="absolute left-0 top-0"
                style={{
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
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
      className="blocker-node theme-eased flex h-full items-stretch overflow-hidden rounded-control bg-surface"
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
          className="line-clamp-2 text-row"
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
        <span className="min-w-0 flex-1 truncate text-row text-text">{model.board.name}</span>
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
        className="pressable hoverable min-w-0 flex-1 truncate rounded-control pr-2 text-left text-meta"
        style={{
          color: done
            ? 'var(--text-tertiary)'
            : task.blocked
              ? 'var(--text-secondary)'
              : 'var(--text)',
          textDecoration: done ? 'line-through' : undefined,
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

function geometryOf(layout: BlockerLayout): Geometry {
  const rowStride = NODE_HEIGHT + ROW_GAP;
  const columnStride = NODE_WIDTH + COLUMN_GAP;
  const maxDepth = layout.trees.reduce((max, tree) => Math.max(max, tree.maxDepth), 0);
  const width =
    TREE_PADDING_X * 2 + NODE_WIDTH * (maxDepth + 1) + COLUMN_GAP * maxDepth;
  const nodes: PositionedNode[] = [];
  const edges: PositionedEdge[] = [];
  let treeTop = TREE_PADDING_Y;

  for (const tree of layout.trees) {
    const positioned = new Map<string, PositionedNode>();
    for (const node of tree.nodes) {
      const entry = {
        node,
        x: TREE_PADDING_X + node.depth * columnStride,
        y: treeTop + node.y * rowStride,
      };
      nodes.push(entry);
      positioned.set(node.task.id, entry);
    }

    for (const child of tree.nodes) {
      if (child.parentId === null) continue;
      const parent = positioned.get(child.parentId);
      const dependent = positioned.get(child.task.id);
      if (!parent || !dependent) continue;

      const startX = parent.x + NODE_WIDTH;
      const startY = parent.y + NODE_HEIGHT / 2;
      const endX = dependent.x;
      const endY = dependent.y + NODE_HEIGHT / 2;
      const controlX = startX + (endX - startX) / 2;
      edges.push({
        id: `${child.parentId}:${child.task.id}`,
        parentId: child.parentId,
        childId: child.task.id,
        path: `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`,
      });
    }

    const treeHeight = NODE_HEIGHT + (tree.leafRows - 1) * rowStride;
    treeTop += treeHeight + TREE_GAP;
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
    width,
    height,
    leftmostIncompleteX: leftmost?.x ?? null,
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
