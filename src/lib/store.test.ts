/**
 * The optimistic contract, exercised against a mocked API.
 *
 * These cover the paths that are hard to see by hand — the capture, the exact
 * rollback, the retry replaying the same spec — but they are not the ticket's
 * verification. The failure cases were exercised in a browser with the network
 * blocked, because a mocked rejection cannot tell you whether the row actually
 * disappeared on screen.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Board, Task } from '../../shared/types';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    getState: vi.fn(),
    createBoard: vi.fn(),
    updateBoard: vi.fn(),
    deleteBoard: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
  };
});

import * as api from './api';
import { ApiError } from './api';
import {
  createBoardSpec,
  createTaskSpec,
  deleteBoardSpec,
  reorderTaskSpec,
  selectActiveTasks,
  selectBoardsFor,
  useStore,
} from './store';
import { useToasts } from './toasts';

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function board(over: Partial<Board> = {}): Board {
  return {
    id: 'b1',
    context: 'personal',
    name: 'Board',
    description: null,
    position: 'a1',
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    boardId: 'b1',
    name: 'Task',
    notes: null,
    dueDate: null,
    dueTime: null,
    durationMinutes: null,
    scheduledAt: null,
    difficulty: null,
    priority: false,
    blocked: false,
    dependsOn: null,
    position: 'a1',
    createdAt: 1,
    completedAt: null,
    updatedAt: 1,
    ...over,
  };
}

/** A promise plus the handles to settle it, so a test can inspect mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ status: 'ready', boards: {}, tasks: {} });
  useToasts.getState().clear();
});

describe('load', () => {
  it('fetches once even when called concurrently', async () => {
    useStore.setState({ status: 'loading' });
    mocked.getState.mockResolvedValue({ boards: [board()], tasks: [task()] });

    await Promise.all([useStore.getState().load(), useStore.getState().load()]);

    expect(mocked.getState).toHaveBeenCalledTimes(1);
    expect(useStore.getState().status).toBe('ready');
    expect(Object.keys(useStore.getState().boards)).toEqual(['b1']);
  });

  it('does not re-fetch once ready', async () => {
    await useStore.getState().load();
    expect(mocked.getState).not.toHaveBeenCalled();
  });

  it('lands in the error state and can be retried', async () => {
    useStore.setState({ status: 'loading' });
    mocked.getState.mockRejectedValueOnce(new ApiError('Network unavailable', 0));

    await useStore.getState().load();
    expect(useStore.getState().status).toBe('error');

    mocked.getState.mockResolvedValueOnce({ boards: [], tasks: [] });
    await useStore.getState().load();
    expect(useStore.getState().status).toBe('ready');
  });
});

describe('mutate — success', () => {
  it('applies before the request settles and merges the server row after', async () => {
    const pending = deferred<Board>();
    mocked.createBoard.mockReturnValue(pending.promise);

    const spec = createBoardSpec({ context: 'personal', name: 'Kitchen', position: 'a1' });
    const running = useStore.getState().mutate(spec);

    // Optimistic: the row is on screen while the request is still in flight.
    const optimistic = selectBoardsFor(useStore.getState(), 'personal');
    expect(optimistic).toHaveLength(1);
    expect(optimistic[0].name).toBe('Kitchen');

    // The server is authoritative — including for the id, which it mints itself.
    pending.resolve(board({ id: 'server-id', name: 'Kitchen', updatedAt: 99 }));
    await running;

    const settled = selectBoardsFor(useStore.getState(), 'personal');
    expect(settled).toHaveLength(1);
    expect(settled[0].id).toBe('server-id');
    expect(settled[0].updatedAt).toBe(99);
  });

  it('re-points a board’s tasks when the server’s id differs', async () => {
    mocked.createBoard.mockImplementation(() =>
      Promise.resolve(board({ id: 'server-id', name: 'Kitchen' })),
    );
    const spec = createBoardSpec({ context: 'personal', name: 'Kitchen', position: 'a1' });
    const optimisticId = spec.touches[0].id;

    useStore.setState({ tasks: { t1: task({ boardId: optimisticId }) } });
    await useStore.getState().mutate(spec);

    expect(useStore.getState().tasks.t1.boardId).toBe('server-id');
  });
});

describe('mutate — failure', () => {
  it('rolls a failed create back to nothing and offers a retry that replays it', async () => {
    mocked.createBoard.mockRejectedValueOnce(new ApiError('Network unavailable', 0));

    const spec = createBoardSpec({ context: 'personal', name: 'Kitchen', position: 'a1' });
    const committed = await useStore.getState().mutate(spec);

    expect(committed).toBe(false);
    expect(selectBoardsFor(useStore.getState(), 'personal')).toHaveLength(0);

    const [raised] = useToasts.getState().toasts;
    expect(raised.message).toContain('Kitchen');
    expect(raised.action?.label).toBe('Retry');

    // Retry replays the same spec, and the entity appears exactly once.
    mocked.createBoard.mockResolvedValueOnce(board({ id: 'server-id', name: 'Kitchen' }));
    raised.action?.run();
    await vi.waitFor(() => {
      expect(selectBoardsFor(useStore.getState(), 'personal')).toHaveLength(1);
    });
    expect(mocked.createBoard).toHaveBeenCalledTimes(2);
  });

  it('restores the previous position when a reorder fails', async () => {
    const moved = task({ position: 'a1' });
    useStore.setState({ boards: { b1: board() }, tasks: { t1: moved } });
    mocked.updateTask.mockRejectedValueOnce(new ApiError('Network unavailable', 0));

    await useStore.getState().mutate(reorderTaskSpec(moved, 'a5'));

    expect(useStore.getState().tasks.t1.position).toBe('a1');
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it('brings a board’s cascaded tasks back when the delete fails', async () => {
    const doomed = board();
    const child = task();
    useStore.setState({ boards: { b1: doomed }, tasks: { t1: child } });
    mocked.deleteBoard.mockRejectedValueOnce(new ApiError('server', 500));

    await useStore.getState().mutate(deleteBoardSpec(doomed, [child]));

    expect(useStore.getState().boards.b1).toEqual(doomed);
    expect(useStore.getState().tasks.t1).toEqual(child);
  });

  it('rolls back a 401 without a toast, because the login screen is the message', async () => {
    mocked.createTask.mockRejectedValueOnce(new ApiError('Session expired', 401));
    useStore.setState({ boards: { b1: board() } });

    const committed = await useStore
      .getState()
      .mutate(createTaskSpec({ boardId: 'b1', name: 'Milk', position: 'a1' }));

    expect(committed).toBe(false);
    expect(selectActiveTasks(useStore.getState(), 'b1')).toHaveLength(0);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});

describe('selectors', () => {
  it('order by position, breaking ties by id — the server read order', () => {
    useStore.setState({
      boards: { b1: board() },
      tasks: {
        c: task({ id: 'c', position: 'a2' }),
        b: task({ id: 'b', position: 'a1' }),
        a: task({ id: 'a', position: 'a1' }),
      },
    });

    expect(selectActiveTasks(useStore.getState(), 'b1').map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('return the same array until the data changes', () => {
    useStore.setState({ boards: { b1: board() }, tasks: { t1: task() } });
    const first = selectActiveTasks(useStore.getState(), 'b1');
    expect(selectActiveTasks(useStore.getState(), 'b1')).toBe(first);

    useStore.setState({ tasks: { t1: task({ name: 'Renamed' }) } });
    expect(selectActiveTasks(useStore.getState(), 'b1')).not.toBe(first);
  });

  it('keep completed tasks out of the active list', () => {
    useStore.setState({
      boards: { b1: board() },
      tasks: { t1: task(), t2: task({ id: 't2', completedAt: 5 }) },
    });
    expect(selectActiveTasks(useStore.getState(), 'b1').map((t) => t.id)).toEqual(['t1']);
  });
});
