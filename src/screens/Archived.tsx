/**
 * Archived boards. PROJECT-SPEC.md §9.8, §6.3.
 *
 * A simple list: each row is the board's name and the progress figure it
 * finished on, with unarchive and delete. Archiving hides a board from its tab
 * without destroying it, so this screen is the only place that board still
 * exists — which is why delete here gets the same confirmation, naming the
 * board and stating what it takes with it.
 */

import { ArrowCounterClockwise, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { DeleteConfirm } from '../components/DeleteConfirm';
import { NumberTicker, ProgressBar } from '../components/ProgressBar';
import { Button } from '../components/ui/Button';
import { EmptyLine, ErrorLine, loadErrorMessage } from '../components/ui/Section';
import { Skeleton } from '../components/ui/Skeleton';
import { tasksOfBoard } from '../lib/actions';
import {
  deleteBoardSpec,
  updateBoardSpec,
  useArchivedBoards,
  useBoardProgress,
  useStore,
} from '../lib/store';
import type { Board } from '../../shared/types';

export function Archived() {
  const context = useStore((state) => state.context);
  const status = useStore((state) => state.status);
  const boards = useArchivedBoards(context);

  if (status === 'loading') return <ArchivedSkeleton />;
  if (status === 'error') return <ArchivedError />;

  return (
    <>
      <h1 className="mb-section text-board-title text-text">Archived</h1>

      {boards.length === 0 ? (
        <EmptyLine>Nothing is archived in this context.</EmptyLine>
      ) : (
        <ul className="grid gap-3">
          {boards.map((board) => (
            <li key={board.id}>
              <ArchivedRow board={board} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ArchivedRow({ board }: { board: Board }) {
  const { percent, done, total } = useBoardProgress(board.id);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div
      className="p-4"
      style={{
        backgroundColor: 'var(--surface)',
        border: 'var(--hairline-width) solid var(--hairline)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-row text-text" style={{ fontWeight: 600 }}>
            {board.name}
          </h2>
          <p className="mt-1 text-meta text-text-secondary">
            {done} of {total} {total === 1 ? 'task' : 'tasks'}
          </p>
        </div>
        <span className="shrink-0 text-row text-text-secondary" style={{ fontWeight: 600 }}>
          <NumberTicker value={percent} />
        </span>
      </div>

      <div className="mt-4">
        <ProgressBar percent={percent} label={`${board.name} progress`} />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="secondary"
          icon={<ArrowCounterClockwise size={20} />}
          onClick={() =>
            void useStore.getState().mutate(updateBoardSpec(board, { archived: false }))
          }
        >
          Unarchive
        </Button>
        <Button
          variant="destructive"
          icon={<Trash size={20} />}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </Button>
      </div>

      <DeleteConfirm
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          void useStore.getState().mutate(deleteBoardSpec(board, tasksOfBoard(board.id)))
        }
        kind="board"
        name={board.name}
        taskCount={total}
      />
    </div>
  );
}

function ArchivedSkeleton() {
  return (
    <>
      <h1 className="mb-section text-board-title text-text">Archived</h1>
      <div className="grid gap-3">
        {[0, 1].map((index) => (
          <div
            key={index}
            className="p-4"
            style={{
              backgroundColor: 'var(--surface)',
              border: 'var(--hairline-width) solid var(--hairline)',
              borderRadius: 'var(--radius-card)',
            }}
          >
            <Skeleton width="45%" height="1.125rem" />
            <div className="mt-3">
              <Skeleton width="30%" height="0.75rem" />
            </div>
            <div className="mt-4">
              <Skeleton width="100%" height="var(--progress-height)" radius="var(--radius-pill)" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ArchivedError() {
  const load = useStore((state) => state.load);
  const failure = useStore((state) => state.failure);
  return (
    <>
      <h1 className="mb-section text-board-title text-text">Archived</h1>
      <ErrorLine
        action={
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        {loadErrorMessage('your archived boards', failure)}
      </ErrorLine>
    </>
  );
}
