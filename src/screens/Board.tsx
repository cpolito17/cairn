/**
 * The board screen. PROJECT-SPEC.md §9.4, §6.4, §6.5.
 *
 * Top to bottom: header (name, description, progress, overflow menu) → active
 * tasks → quick add → the Completed group. Both lists come from the store's
 * selectors; nothing here sorts.
 *
 * Two things are deliberately absent because they belong to issue 6: the rows
 * are not draggable, and completing a task re-renders it into the Completed
 * group without the travelling animation.
 *
 * The error state keeps the header and the quick add alive (§9.4) — a failed
 * read is not a reason to take away the ability to jot the thing down.
 */

import { Archive, NotePencil, PencilSimple, Trash } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { DeleteConfirm } from '../components/DeleteConfirm';
import { BoardEditor } from '../components/BoardEditor';
import { NumberTicker, ProgressBar } from '../components/ProgressBar';
import { QuickAdd } from '../components/QuickAdd';
import { TaskComposer } from '../components/TaskComposer';
import { TaskRow, useHighlight } from '../components/TaskRow';
import { Button } from '../components/ui/Button';
import { Menu, MenuItem } from '../components/ui/Menu';
import { Collapsible, EmptyLine, ErrorLine, SectionHeader } from '../components/ui/Section';
import { Skeleton, SkeletonRow } from '../components/ui/Skeleton';
import { toggleComplete, tasksOfBoard } from '../lib/actions';
import { completedKey, usePersistedCollapse } from '../lib/collapse';
import { consumeNavState, Link, navigate } from '../lib/router';
import {
  deleteBoardSpec,
  updateBoardSpec,
  useActiveTasks,
  useBoard,
  useBoardProgress,
  useCompletedTasks,
  useStore,
} from '../lib/store';
import type { Task } from '../../shared/types';

/** Which dialog, if any, the screen has open. */
type Composer =
  | { mode: 'closed' }
  | { mode: 'create'; prefill: string }
  | { mode: 'edit'; task: Task };

export function Board({ id }: { id: string }) {
  const status = useStore((state) => state.status);
  const context = useStore((state) => state.context);
  const board = useBoard(id);
  const active = useActiveTasks(id);
  const completed = useCompletedTasks(id);
  const progress = useBoardProgress(id);

  const [composer, setComposer] = useState<Composer>({ mode: 'closed' });
  const [editingBoard, setEditingBoard] = useState<'name' | 'description' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [collapsed, toggleCollapsed] = usePersistedCollapse(completedKey(id));

  // Up Next hands the target over in the history entry (§6.7). Reading it is a
  // one-shot: `consumeNavState` clears the entry so a later back-navigation
  // onto it does not re-highlight a task the user has long since dealt with.
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    setTarget(consumeNavState()?.highlightTaskId ?? null);
  }, [id]);
  const highlighted = useHighlight(target);

  if (status === 'loading') return <BoardSkeleton />;

  if (status === 'ready' && !board) {
    return (
      <EmptyLine
        action={
          <Link to="/" className="text-body text-accent">
            Back to your boards
          </Link>
        }
      >
        That board no longer exists.
      </EmptyLine>
    );
  }

  const allComplete = active.length === 0 && completed.length > 0;

  return (
    <>
      <header className="mb-section">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-board-title text-text">{board?.name ?? 'Board'}</h1>
            {board?.description && (
              <p className="mt-1 text-body text-text-secondary">{board.description}</p>
            )}
          </div>
          {board && (
            <Menu label="Board actions">
              {(close) => (
                <>
                  <MenuItem
                    icon={<PencilSimple size={20} />}
                    onClick={() => {
                      close();
                      setEditingBoard('name');
                    }}
                  >
                    Rename
                  </MenuItem>
                  <MenuItem
                    icon={<NotePencil size={20} />}
                    onClick={() => {
                      close();
                      setEditingBoard('description');
                    }}
                  >
                    Edit description
                  </MenuItem>
                  <MenuItem
                    icon={<Archive size={20} />}
                    onClick={() => {
                      close();
                      void useStore.getState().mutate(updateBoardSpec(board, { archived: true }));
                      navigate('/');
                    }}
                  >
                    Archive
                  </MenuItem>
                  <MenuItem
                    icon={<Trash size={20} />}
                    destructive
                    onClick={() => {
                      close();
                      setConfirmDelete(true);
                    }}
                  >
                    Delete
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>

        <div className="mt-5 flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <ProgressBar percent={progress.percent} />
          </span>
          <span className="shrink-0 text-hero text-text">
            <NumberTicker value={progress.percent} />
          </span>
        </div>
        <p className="mt-2 text-meta text-text-secondary">
          {progress.done} of {progress.total} {progress.total === 1 ? 'task' : 'tasks'}
        </p>
      </header>

      {status === 'error' ? (
        <BoardError />
      ) : (
        <section>
          <ul>
            {active.map((task) => (
              <li key={task.id}>
                <TaskRow
                  task={task}
                  highlighted={highlighted === task.id}
                  onOpen={(it) => setComposer({ mode: 'edit', task: it })}
                  onToggle={toggleComplete}
                />
              </li>
            ))}
          </ul>

          {active.length === 0 && (
            <p className="py-6 text-body text-text-secondary">
              {allComplete ? 'Everything here is done.' : 'No tasks yet. Add the first one.'}
            </p>
          )}
        </section>
      )}

      <QuickAdd
        boardId={id}
        autoFocus={status === 'ready' && active.length === 0 && completed.length === 0}
        onExpand={(prefill) => setComposer({ mode: 'create', prefill })}
      />

      {completed.length > 0 && (
        <section className="mt-section">
          <SectionHeader
            collapsed={collapsed}
            onToggle={toggleCollapsed}
            regionId="completed-group"
          >
            Completed · {completed.length}
          </SectionHeader>
          <Collapsible id="completed-group" collapsed={collapsed}>
            <ul>
              {completed.map((task) => (
                <li key={task.id}>
                  <TaskRow
                    task={task}
                    onOpen={(it) => setComposer({ mode: 'edit', task: it })}
                    onToggle={toggleComplete}
                  />
                </li>
              ))}
            </ul>
          </Collapsible>
        </section>
      )}

      <TaskComposer
        open={composer.mode !== 'closed'}
        onClose={() => setComposer({ mode: 'closed' })}
        boardId={id}
        context={context}
        task={composer.mode === 'edit' ? composer.task : undefined}
        prefillName={composer.mode === 'create' ? composer.prefill : ''}
      />

      {board && (
        <BoardEditor
          open={editingBoard !== null}
          onClose={() => setEditingBoard(null)}
          board={board}
          context={context}
          focusField={editingBoard ?? 'name'}
        />
      )}

      {board && (
        <DeleteConfirm
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            void useStore.getState().mutate(deleteBoardSpec(board, tasksOfBoard(board.id)));
            navigate('/');
          }}
          kind="board"
          name={board.name}
          taskCount={progress.total}
        />
      )}
    </>
  );
}

/** Skeletons matching the header and row geometry, shimmering (§8.4). */
function BoardSkeleton() {
  return (
    <>
      <header className="mb-section">
        <Skeleton width="55%" height="1.5rem" />
        <div className="mt-5 flex items-center gap-3">
          <span className="flex-1">
            <Skeleton width="100%" height="var(--progress-height)" radius="var(--radius-pill)" />
          </span>
          <Skeleton width={64} height="2rem" />
        </div>
        <div className="mt-2">
          <Skeleton width={80} height="0.75rem" />
        </div>
      </header>
      <div className="grid gap-1">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </>
  );
}

function BoardError() {
  const load = useStore((state) => state.load);
  return (
    <ErrorLine
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      }
    >
      Couldn&rsquo;t load this board&rsquo;s tasks. The connection may have dropped.
    </ErrorLine>
  );
}
