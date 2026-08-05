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
import { blockedBy, lookupOf } from '../../shared/dependencies';
import { boardProgress, type BoardProgress } from '../../shared/progress';
import { midpoint } from '../../shared/order';
import {
  addDays,
  groupByBoard,
  heatByDay,
  layoutDays,
  layoutMonth,
  sortUnscheduled,
  type DayLayout,
  type HeatDay,
  type MonthDay,
  type TaskGroup,
} from '../../shared/planner';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import type { Board, Context, PlannerSort, Settings, Task } from '../../shared/types';
import { upNext } from '../../shared/upnext';
import * as api from './api';
import { ApiError } from './api';
import { applyTheme, DEFAULT_THEME, initialTheme, storeTheme, type Theme } from './theme';
import { toast } from './toasts';

/* --- shape ----------------------------------------------------------------- */

/** The entity slice. Selectors and mutation specs read and return this. */
export interface Data {
  boards: Record<string, Board>;
  tasks: Record<string, Task>;
  /**
   * The one settings document (V2 §3.2). Not id-keyed like the other two
   * because there is exactly one of it — but it lives in `Data` all the same,
   * so a settings write is captured, applied, and rolled back by the same
   * `mutate()` path as everything else rather than by a second mechanism.
   */
  settings: Settings;
}

export type Status = 'loading' | 'ready' | 'error';

/**
 * Why the load failed, when it did.
 *
 * The distinction is not cosmetic. "The connection may have dropped" sent the
 * owner looking at their network while every device was online and the server
 * was answering 500s — the copy was confidently wrong, and it cost real time.
 * A request that never left the device is `offline`; a server that answered
 * with a failure is `server`, and those are different problems with different
 * next steps.
 */
export type LoadFailure = 'offline' | 'server';

export interface EntityRef {
  kind: 'board' | 'task' | 'settings';
  /** Ignored for `settings`, which is a single document. */
  id: string;
}

/** The ref a settings mutation touches. There is only ever one. */
export const SETTINGS_REF: EntityRef = { kind: 'settings', id: 'settings' };

/**
 * The pre-apply state of everything a mutation touches. `undefined` for an
 * entity that did not exist yet — restoring that means deleting it again,
 * which is exactly what rolling back a failed create has to do.
 */
export interface Captured {
  boards: Record<string, Board | undefined>;
  tasks: Record<string, Task | undefined>;
  /** Present only when the mutation touched settings. */
  settings?: Settings;
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
  const settings = captured.settings ?? data.settings;

  for (const [id, board] of Object.entries(captured.boards)) {
    if (board === undefined) delete boards[id];
    else boards[id] = board;
  }
  for (const [id, task] of Object.entries(captured.tasks)) {
    if (task === undefined) delete tasks[id];
    else tasks[id] = task;
  }

  return { boards, tasks, settings };
}

/** The entity slice of the store, so a spec never sees the rest of it. */
function dataOf(state: Data): Data {
  return { boards: state.boards, tasks: state.tasks, settings: state.settings };
}

function capture(data: Data, refs: EntityRef[]): Captured {
  const captured: Captured = { boards: {}, tasks: {} };
  for (const ref of refs) {
    if (ref.kind === 'board') captured.boards[ref.id] = data.boards[ref.id];
    else if (ref.kind === 'task') captured.tasks[ref.id] = data.tasks[ref.id];
    else captured.settings = data.settings;
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
  /** Set alongside `status: 'error'`, null otherwise. */
  failure: LoadFailure | null;
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
  /**
   * Set the *active context's* theme. The other context is untouched.
   *
   * The only theme mutation there is. The cycle it replaced could not survive
   * eight themes (V2 §5.1), and leaving it alongside the dropdown would have
   * meant two ways to reach the same state with different persistence paths.
   */
  setTheme(theme: Theme): void;
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
const bootTheme: Theme =
  typeof window === 'undefined' ? DEFAULT_THEME : initialTheme(bootContext);
if (typeof document !== 'undefined') applyTheme(bootTheme);

let inFlightLoad: Promise<void> | null = null;

export const useStore = create<AppStore>((set, get) => ({
  status: 'loading',
  failure: null,
  boards: {},
  tasks: {},
  // The defaults until the bootstrap read answers. The Worker sends the same
  // constant for a database with no settings row, so this is not a placeholder
  // that gets corrected — for a fresh install it is the value.
  settings: DEFAULT_SETTINGS,
  context: bootContext,
  theme: bootTheme,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,

  load() {
    if (get().status === 'ready') return Promise.resolve();
    if (inFlightLoad) return inFlightLoad;

    set({ status: 'loading', failure: null });
    inFlightLoad = api
      .getState()
      .then(({ boards, tasks, settings }) => {
        set({
          status: 'ready',
          failure: null,
          boards: Object.fromEntries(boards.map((board) => [board.id, board])),
          tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
          settings,
        });
      })
      .catch((err: unknown) => {
        // A 401 is not a load error the user can retry — the session-lost
        // signal has already fired and the app is on its way to the login
        // screen. Anything else is an error state with a retry.
        if (err instanceof ApiError && err.status === 401) return;
        // `status: 0` is the transport never reaching the server (§6.8);
        // anything else is a reply, and a reply that failed is the server's.
        const failure: LoadFailure =
          err instanceof ApiError && err.unreachable ? 'offline' : 'server';
        set({ status: 'error', failure });
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


  setOnline(online) {
    if (get().online === online) return;
    set({ online });
  },

  reset() {
    inFlightLoad = null;
    set({ status: 'loading', failure: null, boards: {}, tasks: {}, settings: DEFAULT_SETTINGS });
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

/**
 * A lookup over every task, for the dependency rules in
 * `shared/dependencies.ts`. Memoized on the task map so the walk a gated row
 * does on every render is over a Map built once per change, not per row.
 */
export const selectTaskLookup = memoized((data: Data, _key: null) => lookupOf(data.tasks));

/**
 * The incomplete task this one is waiting on, or null when it is free.
 *
 * It goes through `selectTaskLookup` rather than building its own Map: this is
 * called once per visible row, and a Map per row per render is the difference
 * between one pass over the tasks and one per row.
 */
export const selectBlockedBy = memoized((data: Data, taskId: string): Task | null => {
  const task = data.tasks[taskId];
  return task ? blockedBy(task, selectTaskLookup(data, null)) : null;
});

/** Difficulty-weighted progress for a board, from `shared/progress.ts`. */
export const selectBoardProgress = memoized((data: Data, boardId: string): BoardProgress =>
  boardProgress(Object.values(data.tasks).filter((task) => task.boardId === boardId)),
);

/* --- the planner ----------------------------------------------------------- */
/*
 * The Planner's derived lists, all of them here rather than in a component.
 * The sorts, the grouping and the lane packing are `shared/planner.ts`; these
 * selectors are what choose the tasks and hold the memo, so the list and the
 * grid cannot disagree about which tasks belong to a context.
 *
 * The memo key is a string because `memoized` caches on one argument by
 * identity, and every one of these takes more than one. Building it at the hook
 * rather than passing an object is what keeps the cache hitting: a fresh object
 * every render is a fresh cache miss every render, and the array it recomputes
 * would re-render the subscriber forever.
 */

/** Tasks belonging to a context's **active** boards. Archived boards are put
 *  away, and a schedule that keeps drawing their blocks has not put them away. */
function tasksInContext(data: Data, context: Context): Task[] {
  const boardIds = new Set(
    Object.values(data.boards)
      .filter((board) => board.context === context && board.archivedAt === null)
      .map((board) => board.id),
  );
  return Object.values(data.tasks).filter((task) => boardIds.has(task.boardId));
}

/** `context|sort`, the key both unscheduled selectors take. */
export function unscheduledKey(context: Context, sort: PlannerSort): string {
  return `${context}|${sort}`;
}

/**
 * The unscheduled task list (§6.2): incomplete and unscheduled, from every
 * non-archived board in the context, in the chosen order.
 *
 * Blocked and dependency-gated tasks are **in** this list — the row recesses
 * them, it does not drop them. Planning to do something after its prerequisite
 * clears is legitimate; the gate that matters is on completion, and it lives in
 * `shared/dependencies.ts`.
 */
export const selectUnscheduled = memoized((data: Data, key: string): Task[] => {
  const [context, sort] = key.split('|') as [Context, PlannerSort];
  return sortUnscheduled(
    tasksInContext(data, context).filter(
      (task) => task.completedAt === null && task.scheduledAt === null,
    ),
    sort,
  );
});

/** The same list under board headings, in board order (§6.2). */
export const selectUnscheduledGroups = memoized((data: Data, key: string): TaskGroup[] => {
  const [context, sort] = key.split('|') as [Context, PlannerSort];
  return groupByBoard(selectUnscheduled(data, key), selectBoardsFor(data, context), sort);
});

/** `context|firstDayMs|dayCount`, the key the schedule selector takes. */
export function scheduleKey(context: Context, firstDay: number, dayCount: number): string {
  return `${context}|${firstDay}|${dayCount}`;
}

/**
 * The day columns of the schedule: the context's own blocks and the other
 * context's ghosts, packed together (§6.3).
 *
 * The other context is `other`, not "every task that is not mine": a task on an
 * archived board is nobody's ghost.
 */
export const selectSchedule = memoized((data: Data, key: string): DayLayout[] => {
  const [context, firstDay, dayCount] = key.split('|');
  const start = Number(firstDay);
  const days = Array.from({ length: Number(dayCount) }, (_, index) => addDays(start, index));
  const mine = context as Context;
  return layoutDays(days, tasksInContext(data, mine), tasksInContext(data, otherContext(mine)));
});

/** The context whose blocks are ghosts while `context` is on screen. */
function otherContext(context: Context): Context {
  return context === 'personal' ? 'work' : 'personal';
}

/** `context|monthStartMs`, the key the month selector takes. */
export function monthKey(context: Context, monthStart: number): string {
  return `${context}|${monthStart}`;
}

/** The 42 cells of the month grid (§6.5), each with its whole day's entries. */
export const selectMonth = memoized((data: Data, key: string): MonthDay[] => {
  const [context, monthStart] = key.split('|');
  const mine = context as Context;
  return layoutMonth(
    Number(monthStart),
    tasksInContext(data, mine),
    tasksInContext(data, otherContext(mine)),
  );
});

/**
 * The heat map's per-day totals and names (§6.6).
 *
 * Keyed on the context alone, and computed over every scheduled task rather
 * than over a window: the grid is 371 days wide, the map is sparse, and slicing
 * it to the visible year would mean recomputing it every time the year nav
 * moved. One map, memoized until a task changes.
 */
export const selectHeat = memoized((data: Data, context: Context): Record<string, HeatDay> =>
  heatByDay(tasksInContext(data, context), tasksInContext(data, otherContext(context))),
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

export const useSettings = (): Settings => useStore((state) => state.settings);

export const useUnscheduled = (context: Context, sort: PlannerSort): Task[] =>
  useStore((state) => selectUnscheduled(state, unscheduledKey(context, sort)));

export const useUnscheduledGroups = (context: Context, sort: PlannerSort): TaskGroup[] =>
  useStore((state) => selectUnscheduledGroups(state, unscheduledKey(context, sort)));

/** The day columns the grid draws, `dayCount` days from `firstDay` (§6.3). */
export const useSchedule = (
  context: Context,
  firstDay: number,
  dayCount: number,
): DayLayout[] =>
  useStore((state) => selectSchedule(state, scheduleKey(context, firstDay, dayCount)));

/** The month grid's cells, for the month containing `monthStart` (§6.5). */
export const useMonth = (context: Context, monthStart: number): MonthDay[] =>
  useStore((state) => selectMonth(state, monthKey(context, monthStart)));

/** Scheduled minutes and current-context tasks per day, keyed `YYYY-MM-DD`. */
export const useHeat = (context: Context): Record<string, HeatDay> =>
  useStore((state) => selectHeat(state, context));

export const useBoardProgress = (boardId: string): BoardProgress =>
  useStore((state) => selectBoardProgress(state, boardId));

/**
 * The incomplete task `taskId` is waiting on, or null. A row uses this to gate
 * its own completion — the rule is derived on read, so completing the
 * prerequisite releases every dependent in the same render.
 */
export const useBlockedBy = (taskId: string): Task | null =>
  useStore((state) => selectBlockedBy(state, taskId));

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
  return { ...data, boards: { ...data.boards, [board.id]: board } };
}

function withTask(data: Data, task: Task): Data {
  return { ...data, tasks: { ...data.tasks, [task.id]: task } };
}

function withoutBoard(data: Data, id: string): Data {
  const boards = { ...data.boards };
  delete boards[id];
  // The server cascades tasks with the board; the local state has to match, or
  // an orphaned task briefly counts toward another board's progress.
  const tasks = Object.fromEntries(
    Object.entries(data.tasks).filter(([, task]) => task.boardId !== id),
  );
  return { ...data, boards, tasks };
}

function withoutTask(data: Data, id: string): Data {
  const tasks = { ...data.tasks };
  delete tasks[id];
  return { ...data, tasks };
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
  return { ...data, boards, tasks };
}

function replaceTaskId(data: Data, optimisticId: string, task: Task): Data {
  if (task.id === optimisticId) return withTask(data, task);
  const tasks = { ...data.tasks };
  delete tasks[optimisticId];
  tasks[task.id] = task;
  return { ...data, tasks };
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
  durationMinutes?: Task['durationMinutes'];
  scheduledAt?: Task['scheduledAt'];
  difficulty?: Task['difficulty'];
  priority?: boolean;
  blocked?: boolean;
  dependsOn?: string | null;
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
    durationMinutes: draft.durationMinutes ?? null,
    scheduledAt: draft.scheduledAt ?? null,
    difficulty: draft.difficulty ?? null,
    priority: draft.priority ?? false,
    blocked: draft.blocked ?? false,
    dependsOn: draft.dependsOn ?? null,
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
        durationMinutes: optimistic.durationMinutes,
        scheduledAt: optimistic.scheduledAt,
        difficulty: optimistic.difficulty,
        priority: optimistic.priority,
        blocked: optimistic.blocked,
        dependsOn: optimistic.dependsOn,
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
    ...(patch.durationMinutes === undefined ? {} : { durationMinutes: patch.durationMinutes }),
    ...(patch.scheduledAt === undefined ? {} : { scheduledAt: patch.scheduledAt }),
    ...(patch.difficulty === undefined ? {} : { difficulty: patch.difficulty }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.blocked === undefined ? {} : { blocked: patch.blocked }),
    ...(patch.dependsOn === undefined ? {} : { dependsOn: patch.dependsOn }),
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

/**
 * Placing a task on the grid, or moving the block it already has (V2 §6.7).
 *
 * `scheduledAt` and nothing else: a move changes when the work is planned, not
 * what the task is or how long it takes. The value is already snapped to the
 * 15-minute grid by the caller — the Worker rejects an unsnapped one rather
 * than quietly rounding it, because a server that moves a block is a server the
 * client's optimistic state disagrees with (§3.1).
 */
export function scheduleTaskSpec(task: Task, scheduledAt: number): MutationSpec<Task> {
  const spec = updateTaskSpec(task, { scheduledAt });
  return { ...spec, onError: `Couldn't schedule "${task.name}".` };
}

/** Clearing the block — the drag back onto the list, and the composer's action. */
export function unscheduleTaskSpec(task: Task): MutationSpec<Task> {
  const spec = updateTaskSpec(task, { scheduledAt: null });
  return { ...spec, onError: `Couldn't unschedule "${task.name}".` };
}

/**
 * A resize on the grid, written to the task's **`durationMinutes`** — the same
 * field the composer's chips set (V2 §6.7). The grid is the other way of
 * setting it, not a second value that shadows it.
 */
export function resizeTaskSpec(task: Task, durationMinutes: number): MutationSpec<Task> {
  const spec = updateTaskSpec(task, { durationMinutes });
  return { ...spec, onError: `Couldn't resize "${task.name}".` };
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

/**
 * Change one or more settings. The whole document goes to the server — that is
 * what `PUT /api/settings` takes (V2 §3.2) — while the caller only names what
 * changed, and the rollback restores the document that was there before.
 */
export function updateSettingsSpec(
  settings: Settings,
  patch: Partial<Settings>,
): MutationSpec<Settings> {
  const optimistic: Settings = { ...settings, ...patch };

  return {
    onError: "Couldn't save your settings.",
    touches: [SETTINGS_REF],
    apply: (data) => ({ ...data, settings: optimistic }),
    revert: restoreCaptured,
    request: () => api.putSettings(optimistic),
    reconcile: (data, saved) => ({ ...data, settings: saved }),
  };
}
