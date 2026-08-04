/**
 * The client store, and the one path every mutation takes.
 *
 * Two decisions govern the whole file.
 *
 * **Entities are normalized; order is derived.** `boards` and `tasks` are
 * id-keyed records, and every list a component renders comes from a selector
 * that sorts on `position` (ties by `id`, matching the server's read order).
 * Nothing keeps array order in state. An optimistic reorder that has to splice
 * an array is the bug this rules out: the array and the positions disagree for
 * the length of the request, and the row visibly snaps when the server answers.
 *
 * **Every write goes through `mutate()`.** Capture the affected entities →
 * apply the local change → fire the request → merge the server's row on success,
 * or restore the capture and raise a retryable toast on failure. Components do
 * not call `fetch`, do not `set()` entity state, and do not hand-roll rollback.
 * The sequence is written once, here, because a rollback path that only exists
 * in the mutation someone remembered to write it for is not a rollback path.
 *
 * PROJECT-SPEC.md §6.2, §6.8, §7.1, §7.2, §7.3.
 */

import { create } from 'zustand';
import { boardProgress, type BoardProgress } from '../../shared/progress';
import { midpoint } from '../../shared/order';
import type { Board, Context, Task } from '../../shared/types';
import { upNext } from '../../shared/upnext';
import * as api from './api';
import { ApiError } from './api';
import {
  applyTheme,
  initialTheme,
  nextTheme,
  readStoredTheme,
  storeTheme,
  type Theme,
} from './theme';
import { toast } from './toasts';

/* --- shape ----------------------------------------------------------------- */

/** The entity slice. Selectors and mutation specs read and return this. */
export interface Data {
  boards: Record<string, Board>;
  tasks: Record<string, Task>;
}

export type Status = 'loading' | 'ready' | 'error';

export interface EntityRef {
  kind: 'board' | 'task';
  id: string;
}

/**
 * The pre-apply state of everything a mutation touches. `undefined` for an
 * entity that did not exist yet — restoring that means deleting it again,
 * which is exactly what rolling back a failed create has to do.
 */
export interface Captured {
  boards: Record<string, Board | undefined>;
  tasks: Record<string, Task | undefined>;
}

/**
 * One mutation, described so `mutate()` can run it and re-run it.
 *
 * A spec is a value, not a closure over a moment: `mutate()` captures state
 * before calling `apply`, so replaying the same spec after a rollback — which
 * is what the toast's Retry does — starts from the same place it did the first
 * time.
 */
export interface MutationSpec<R = unknown> {
  /** Toast copy when the write fails. One line, names what did not save. */
  onError: string;
  /** Everything the mutation reads or writes, captured before `apply` runs. */
  touches: EntityRef[];
  /** The local change, applied on the spot. */
  apply(data: Data): Data;
  /** Undo. Every spec uses `restoreCaptured`; the field is here so the call
   *  site shows that a rollback exists at all. */
  revert(data: Data, captured: Captured): Data;
  /** The server call. */
  request(): Promise<R>;
  /** Merge what the server returned. It is authoritative for `completedAt`,
   *  `updatedAt`, and anything else it normalized. */
  reconcile(data: Data, result: R): Data;
}

/** The standard rollback: put the captured entities back exactly as they were. */
export function restoreCaptured(data: Data, captured: Captured): Data {
  const boards = { ...data.boards };
  const tasks = { ...data.tasks };

  for (const [id, board] of Object.entries(captured.boards)) {
    if (board === undefined) delete boards[id];
    else boards[id] = board;
  }
  for (const [id, task] of Object.entries(captured.tasks)) {
    if (task === undefined) delete tasks[id];
    else tasks[id] = task;
  }

  return { boards, tasks };
}

/** The entity slice of the store, so a spec never sees the rest of it. */
function dataOf(state: Data): Data {
  return { boards: state.boards, tasks: state.tasks };
}

function capture(data: Data, refs: EntityRef[]): Captured {
  const captured: Captured = { boards: {}, tasks: {} };
  for (const ref of refs) {
    if (ref.kind === 'board') captured.boards[ref.id] = data.boards[ref.id];
    else captured.tasks[ref.id] = data.tasks[ref.id];
  }
  return captured;
}

/* --- store ----------------------------------------------------------------- */

const CONTEXT_KEY = 'cairn:context';

function readStoredContext(): Context {
  try {
    const stored = localStorage.getItem(CONTEXT_KEY);
    return stored === 'work' || stored === 'personal' ? stored : 'personal';
  } catch {
    return 'personal';
  }
}

function storeContext(context: Context): void {
  try {
    localStorage.setItem(CONTEXT_KEY, context);
  } catch {
    // Storage denial costs persistence, not the switch itself.
  }
}

export interface AppStore extends Data {
  status: Status;
  context: Context;
  /** The active context's theme. Each context keeps its own (§8.2). */
  theme: Theme;
  online: boolean;

  /** The app's only read. Idempotent — a second call while one is in flight,
   *  or after a successful load, does not hit the network again. */
  load(): Promise<void>;
  /** Resolves true when the write committed, false when it rolled back. */
  mutate<R>(spec: MutationSpec<R>): Promise<boolean>;

  setContext(context: Context): void;
  /** Set the *active context's* theme. The other context is untouched. */
  setTheme(theme: Theme): void;
  /** Advance to the next theme in `THEMES`. The menu's only theme control. */
  cycleTheme(): void;
  /** Follow the system preference — ignored once this context has an override. */
  followSystemTheme(theme: Theme): void;
  setOnline(online: boolean): void;
  /** Drop every entity. Called when the session is lost. */
  reset(): void;
}

// Applied from module scope rather than an effect: an effect lands after the
// first paint, and one frame of the wrong theme is exactly what this avoids.
// Outside a browser — the unit tests — there is nothing to apply it to.
//
// The theme is the *booting context's*, so the context has to be resolved
// first. That ordering is the whole of what makes a per-context theme land
// without a flash on a reload into the Work tab.
const bootContext: Context = typeof localStorage === 'undefined' ? 'personal' : readStoredContext();
const bootTheme: Theme = typeof window === 'undefined' ? 'dark' : initialTheme(bootContext);
if (typeof document !== 'undefined') applyTheme(bootTheme);

let inFlightLoad: Promise<void> | null = null;

export const useStore = create<AppStore>((set, get) => ({
  status: 'loading',
  boards: {},
  tasks: {},
  context: bootContext,
  theme: bootTheme,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,

  load() {
    if (get().status === 'ready') return Promise.resolve();
    if (inFlightLoad) return inFlightLoad;

    set({ status: 'loading' });
    inFlightLoad = api
      .getState()
      .then(({ boards, tasks }) => {
        set({
          status: 'ready',
          boards: Object.fromEntries(boards.map((board) => [board.id, board])),
          tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
        });
      })
      .catch((err: unknown) => {
        // A 401 is not a load error the user can retry — the session-lost
        // signal has already fired and the app is on its way to the login
        // screen. Anything else is an error state with a retry.
        if (!(err instanceof ApiError && err.status === 401)) set({ status: 'error' });
      })
      .finally(() => {
        inFlightLoad = null;
      });

    return inFlightLoad;
  },

  async mutate<R>(spec: MutationSpec<R>): Promise<boolean> {
    const captured = capture(dataOf(get()), spec.touches);

    set(spec.apply(dataOf(get())));

    try {
      const result = await spec.request();
      set(spec.reconcile(dataOf(get()), result));
      return true;
    } catch (err) {
      // The optimistic change is rolled back either way, but a lost session is
      // not a retryable write: the store is about to be cleared and the login
      // screen is the message. Never retry a 401.
      set(spec.revert(dataOf(get()), captured));
      if (err instanceof ApiError && err.status === 401) return false;

      toast.error(spec.onError, {
        label: 'Retry',
        run: () => {
          void get().mutate(spec);
        },
      });
      return false;
    }
  },

  setContext(context) {
    if (get().context === context) return;
    storeContext(context);
    // The theme belongs to the context, so switching tabs re-applies that
    // tab's — its own override if it has one, the system preference if not.
    // Both go through `set` together so the two never disagree for a render.
    const theme = initialTheme(context);
    applyTheme(theme);
    set({ context, theme });
  },

  setTheme(theme) {
    storeTheme(get().context, theme);
    applyTheme(theme);
    set({ theme });
  },

  cycleTheme() {
    get().setTheme(nextTheme(get().theme));
  },

  followSystemTheme(theme) {
    // The OS flipping is not an instruction in a context the user has already
    // made a choice in — and it says nothing at all about the other context,
    // which keeps whatever it had.
    if (readStoredTheme(get().context) !== null) return;
    applyTheme(theme);
    set({ theme });
  },

  setOnline(online) {
    if (get().online === online) return;
    set({ online });
  },

  reset() {
    inFlightLoad = null;
    set({ status: 'loading', boards: {}, tasks: {} });
  },
}));

/**
 * Connectivity tracking. `navigator.onLine` is the initial value and the two
 * events are the updates; nothing here queues or replays writes, per §6.8.
 */
export function subscribeToConnectivity(): () => void {
  const goOnline = () => useStore.getState().setOnline(true);
  const goOffline = () => useStore.getState().setOnline(false);

  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
  // The flag can have changed between module load and this subscription.
  useStore.getState().setOnline(navigator.onLine);

  return () => {
    window.removeEventListener('online', goOnline);
    window.removeEventListener('offline', goOffline);
  };
}

/* --- selectors ------------------------------------------------------------- */

/**
 * Memoize a selector on the identity of the two entity maps plus its argument.
 *
 * Not a nicety: a selector that builds a fresh array every call makes
 * `useStore(selector)` re-render forever, because the snapshot never compares
 * equal to the last one. The cache is cleared wholesale whenever either map
 * changes, which is the only time any derived list can change.
 */
function memoized<Arg, R>(compute: (data: Data, arg: Arg) => R): (data: Data, arg: Arg) => R {
  let lastBoards: Data['boards'] | null = null;
  let lastTasks: Data['tasks'] | null = null;
  let cache = new Map<Arg, R>();

  return (data, arg) => {
    if (data.boards !== lastBoards || data.tasks !== lastTasks) {
      lastBoards = data.boards;
      lastTasks = data.tasks;
      cache = new Map();
    }
    if (cache.has(arg)) return cache.get(arg) as R;
    const value = compute(data, arg);
    cache.set(arg, value);
    return value;
  };
}

/**
 * Position ascending, id ascending on ties — the same total order
 * `worker/db.ts` uses, so the client and the server never disagree about which
 * of two concurrently-minted positions comes first.
 */
function byPosition<T extends { position: string; id: string }>(a: T, b: T): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Active (non-archived) boards of a context, in order. */
export const selectBoardsFor = memoized((data: Data, context: Context) =>
  Object.values(data.boards)
    .filter((board) => board.context === context && board.archivedAt === null)
    .sort(byPosition),
);

/** Archived boards of a context, most recently archived first (§9.8). */
export const selectArchivedBoardsFor = memoized((data: Data, context: Context) =>
  Object.values(data.boards)
    .filter((board) => board.context === context && board.archivedAt !== null)
    .sort((a, b) => (b.archivedAt as number) - (a.archivedAt as number)),
);

/** The board's active list, in order. This is the list `position` describes. */
export const selectActiveTasks = memoized((data: Data, boardId: string) =>
  Object.values(data.tasks)
    .filter((task) => task.boardId === boardId && task.completedAt === null)
    .sort(byPosition),
);

/**
 * The board's completed tasks, most recently completed first. Completed tasks
 * retain no meaningful position (§7.3), so they are not sorted by one.
 */
export const selectCompletedTasks = memoized((data: Data, boardId: string) =>
  Object.values(data.tasks)
    .filter((task) => task.boardId === boardId && task.completedAt !== null)
    .sort((a, b) => (b.completedAt as number) - (a.completedAt as number)),
);

/**
 * Up Next for a context, from `shared/upnext.ts`.
 *
 * `now` is read here rather than passed in, and the memo key ignores it: the
 * ranking is a pure sort by due moment that does not consult the clock (see
 * that module), so a later `now` cannot reorder the result — only the "Overdue
 * by" copy the caller renders, which reads the clock itself.
 */
export const selectUpNext = memoized((data: Data, context: Context) =>
  upNext(Object.values(data.boards), Object.values(data.tasks), context, Date.now()),
);

/** Difficulty-weighted progress for a board, from `shared/progress.ts`. */
export const selectBoardProgress = memoized((data: Data, boardId: string): BoardProgress =>
  boardProgress(Object.values(data.tasks).filter((task) => task.boardId === boardId)),
);

/* --- hooks ----------------------------------------------------------------- */

export const useBoards = (context: Context): Board[] =>
  useStore((state) => selectBoardsFor(state, context));

export const useArchivedBoards = (context: Context): Board[] =>
  useStore((state) => selectArchivedBoardsFor(state, context));

export const useBoard = (id: string): Board | undefined => useStore((state) => state.boards[id]);

export const useTask = (id: string): Task | undefined => useStore((state) => state.tasks[id]);

export const useActiveTasks = (boardId: string): Task[] =>
  useStore((state) => selectActiveTasks(state, boardId));

export const useCompletedTasks = (boardId: string): Task[] =>
  useStore((state) => selectCompletedTasks(state, boardId));

export const useUpNext = (context: Context): Task[] =>
  useStore((state) => selectUpNext(state, context));

export const useBoardProgress = (boardId: string): BoardProgress =>
  useStore((state) => selectBoardProgress(state, boardId));

/* --- positions ------------------------------------------------------------- */

/** A position at the end of a board's active list (§7.3: new tasks go last). */
export function endOfBoard(data: Data, boardId: string): string {
  const active = selectActiveTasks(data, boardId);
  return midpoint(active.length === 0 ? null : active[active.length - 1].position, null);
}

/** A position at the end of a context's board list. */
export function endOfContext(data: Data, context: Context): string {
  const boards = selectBoardsFor(data, context);
  return midpoint(boards.length === 0 ? null : boards[boards.length - 1].position, null);
}

/** The position for a row dropped between two neighbours; null means an edge. */
export function positionBetween(before: string | null, after: string | null): string {
  return midpoint(before, after);
}

/* --- entity helpers -------------------------------------------------------- */

function withBoard(data: Data, board: Board): Data {
  return { boards: { ...data.boards, [board.id]: board }, tasks: data.tasks };
}

function withTask(data: Data, task: Task): Data {
  return { boards: data.boards, tasks: { ...data.tasks, [task.id]: task } };
}

function withoutBoard(data: Data, id: string): Data {
  const boards = { ...data.boards };
  delete boards[id];
  // The server cascades tasks with the board; the local state has to match, or
  // an orphaned task briefly counts toward another board's progress.
  const tasks = Object.fromEntries(
    Object.entries(data.tasks).filter(([, task]) => task.boardId !== id),
  );
  return { boards, tasks };
}

function withoutTask(data: Data, id: string): Data {
  const tasks = { ...data.tasks };
  delete tasks[id];
  return { boards: data.boards, tasks };
}

/**
 * Swap an optimistic row for the server's.
 *
 * The optimistic id is minted client-side so the row is real the instant it
 * appears, and the intent was that the server would keep it. It does not — the
 * create endpoints from issue 3 mint their own id and ignore any the client
 * sends, and this issue may not change the Worker. So the swap happens here,
 * inside `reconcile`, in the one moment the store already has both ids. No
 * component ever observes it: the optimistic row and the server row are the
 * same row to every selector, one render apart.
 */
function replaceBoardId(data: Data, optimisticId: string, board: Board): Data {
  if (board.id === optimisticId) return withBoard(data, board);

  const boards = { ...data.boards };
  delete boards[optimisticId];
  boards[board.id] = board;

  // Any task created against the optimistic board follows it.
  const tasks = Object.fromEntries(
    Object.entries(data.tasks).map(([id, task]) =>
      task.boardId === optimisticId ? [id, { ...task, boardId: board.id }] : [id, task],
    ),
  );
  return { boards, tasks };
}

function replaceTaskId(data: Data, optimisticId: string, task: Task): Data {
  if (task.id === optimisticId) return withTask(data, task);
  const tasks = { ...data.tasks };
  delete tasks[optimisticId];
  tasks[task.id] = task;
  return { boards: data.boards, tasks };
}

/* --- mutation specs -------------------------------------------------------- */
/*
 * Each builder returns a plain value. Nothing here touches the store: the
 * caller passes the spec to `mutate()`, which owns the capture, the apply, the
 * request, and the rollback. Reorder, completion, and move are defined here and
 * called from the drag and completion work in issue 6.
 */

export interface NewBoard {
  context: Context;
  name: string;
  description?: string | null;
  position: string;
}

export function createBoardSpec(draft: NewBoard): MutationSpec<Board> {
  const now = Date.now();
  const optimistic: Board = {
    id: crypto.randomUUID(),
    context: draft.context,
    name: draft.name,
    description: draft.description ?? null,
    position: draft.position,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  return {
    onError: `Couldn't create "${draft.name}".`,
    touches: [{ kind: 'board', id: optimistic.id }],
    apply: (data) => withBoard(data, optimistic),
    revert: restoreCaptured,
    request: () =>
      api.createBoard({
        context: optimistic.context,
        name: optimistic.name,
        description: optimistic.description,
        position: optimistic.position,
      }),
    reconcile: (data, board) => replaceBoardId(data, optimistic.id, board),
  };
}

export function updateBoardSpec(board: Board, patch: api.BoardPatch): MutationSpec<Board> {
  const optimistic: Board = {
    ...board,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.position === undefined ? {} : { position: patch.position }),
    ...(patch.archived === undefined
      ? {}
      : { archivedAt: patch.archived ? Date.now() : null }),
  };

  return {
    onError:
      patch.archived === true
        ? `Couldn't archive "${board.name}".`
        : patch.archived === false
          ? `Couldn't restore "${board.name}".`
          : `Couldn't save "${board.name}".`,
    touches: [{ kind: 'board', id: board.id }],
    apply: (data) => withBoard(data, optimistic),
    revert: restoreCaptured,
    request: () => api.updateBoard(board.id, patch),
    reconcile: (data, saved) => withBoard(data, saved),
  };
}

/** Reordering a board within its context. Persisted on release (§7.3). */
export function reorderBoardSpec(board: Board, position: string): MutationSpec<Board> {
  return updateBoardSpec(board, { position });
}

export function deleteBoardSpec(board: Board, tasks: Task[]): MutationSpec<void> {
  return {
    onError: `Couldn't delete "${board.name}".`,
    // The board's tasks go with it through the foreign key, so they are part of
    // what has to come back if the delete fails.
    touches: [
      { kind: 'board', id: board.id },
      ...tasks.map((task): EntityRef => ({ kind: 'task', id: task.id })),
    ],
    apply: (data) => withoutBoard(data, board.id),
    revert: restoreCaptured,
    request: () => api.deleteBoard(board.id),
    reconcile: (data) => data,
  };
}

export interface NewTask {
  boardId: string;
  name: string;
  notes?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  duration?: Task['duration'];
  difficulty?: Task['difficulty'];
  priority?: boolean;
  blocked?: boolean;
  position: string;
}

export function createTaskSpec(draft: NewTask): MutationSpec<Task> {
  const now = Date.now();
  const optimistic: Task = {
    id: crypto.randomUUID(),
    boardId: draft.boardId,
    name: draft.name,
    notes: draft.notes ?? null,
    dueDate: draft.dueDate ?? null,
    dueTime: draft.dueTime ?? null,
    duration: draft.duration ?? null,
    difficulty: draft.difficulty ?? null,
    priority: draft.priority ?? false,
    blocked: draft.blocked ?? false,
    position: draft.position,
    createdAt: now,
    completedAt: null,
    updatedAt: now,
  };

  return {
    onError: `Couldn't add "${draft.name}".`,
    touches: [{ kind: 'task', id: optimistic.id }],
    apply: (data) => withTask(data, optimistic),
    revert: restoreCaptured,
    request: () =>
      api.createTask({
        boardId: optimistic.boardId,
        name: optimistic.name,
        notes: optimistic.notes,
        dueDate: optimistic.dueDate,
        dueTime: optimistic.dueTime,
        duration: optimistic.duration,
        difficulty: optimistic.difficulty,
        priority: optimistic.priority,
        blocked: optimistic.blocked,
        position: optimistic.position,
      }),
    reconcile: (data, task) => replaceTaskId(data, optimistic.id, task),
  };
}

export function updateTaskSpec(task: Task, patch: api.TaskPatch): MutationSpec<Task> {
  const optimistic: Task = {
    ...task,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.notes === undefined ? {} : { notes: patch.notes }),
    ...(patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
    ...(patch.dueTime === undefined ? {} : { dueTime: patch.dueTime }),
    ...(patch.duration === undefined ? {} : { duration: patch.duration }),
    ...(patch.difficulty === undefined ? {} : { difficulty: patch.difficulty }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.blocked === undefined ? {} : { blocked: patch.blocked }),
    ...(patch.position === undefined ? {} : { position: patch.position }),
    ...(patch.boardId === undefined ? {} : { boardId: patch.boardId }),
    // Optimistic only. The server clocks completion and its value wins in
    // `reconcile` — the client's timestamp exists so the row moves now.
    ...(patch.completed === undefined
      ? {}
      : { completedAt: patch.completed ? Date.now() : null }),
  };

  return {
    onError: `Couldn't save "${task.name}".`,
    touches: [{ kind: 'task', id: task.id }],
    apply: (data) => withTask(data, optimistic),
    revert: restoreCaptured,
    request: () => api.updateTask(task.id, patch),
    reconcile: (data, saved) => withTask(data, saved),
  };
}

/**
 * Complete or un-complete. Un-completing carries a fresh position at the end of
 * the active list, because a restored task does not go back where it was
 * (§7.3) — the caller computes it with `endOfBoard`.
 */
export function completeTaskSpec(
  task: Task,
  completed: boolean,
  position?: string,
): MutationSpec<Task> {
  const spec = updateTaskSpec(task, {
    completed,
    ...(completed || position === undefined ? {} : { position }),
  });
  return {
    ...spec,
    onError: completed
      ? `Couldn't complete "${task.name}".`
      : `Couldn't restore "${task.name}".`,
  };
}

/** Reordering within a board's active list. Persisted on release (§7.3). */
export function reorderTaskSpec(task: Task, position: string): MutationSpec<Task> {
  const spec = updateTaskSpec(task, { position });
  return { ...spec, onError: `Couldn't move "${task.name}".` };
}

/** Moving to another board. The task lands at the end of that list (§7.3). */
export function moveTaskSpec(task: Task, boardId: string, position: string): MutationSpec<Task> {
  const spec = updateTaskSpec(task, { boardId, position });
  return { ...spec, onError: `Couldn't move "${task.name}".` };
}

export function deleteTaskSpec(task: Task): MutationSpec<void> {
  return {
    onError: `Couldn't delete "${task.name}".`,
    touches: [{ kind: 'task', id: task.id }],
    apply: (data) => withoutTask(data, task.id),
    revert: restoreCaptured,
    request: () => api.deleteTask(task.id),
    reconcile: (data) => data,
  };
}
