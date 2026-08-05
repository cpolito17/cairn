/**
 * Demo mode — the whole app, with the Worker replaced by this file.
 *
 * The problem it solves: the app is single-user by design (PROJECT-SPEC.md §3),
 * so there is no second account to hand a visitor and no schema that could hold
 * one. Rather than grow one, the demo runs the same client against a backend
 * that never leaves the browser: `lib/api.ts` is the only module in the app that
 * calls `fetch`, so intercepting it there gives every screen, selector, and
 * optimistic mutation a working world without a line of the store, the router,
 * or any component knowing that demo mode exists.
 *
 * **Where the world lives.** `sessionStorage`, which gets the isolation
 * requirement for free: it is per-tab, per-visitor, and dies with the tab. Two
 * people on the site at once are two independent worlds, neither of them the
 * owner's, and neither of them stored anywhere a database would have to hold
 * them. It survives a reload — which the demo needs, because entering it
 * navigates — and nothing else.
 *
 * **What it does not do.** No latency simulation, no injected failures. The
 * quality bar in §2 is speed and feel, and a demo that fakes a slow server is
 * demonstrating the wrong thing. Every write resolves on the microtask queue,
 * so the optimistic path still runs exactly as it does against the Worker.
 */

import { canDependOn, lookupOf } from '../../../shared/dependencies';
import type {
  AppState,
  Board,
  PlannerEvent,
  Settings,
  Task,
} from '../../../shared/types';
import type { BoardDraft, BoardPatch, EventDraft, EventPatch, TaskDraft, TaskPatch } from '../api';
import { buildDemoState } from './seed';

const KEY = 'cairn:demo';

/**
 * The live world.
 *
 * `sessionStorage` is the store of record and this is the working copy: reading
 * and re-parsing a JSON document of a hundred entities on every call would be a
 * self-inflicted cost, and there is exactly one tab writing it.
 */
let current: AppState | null = null;

/* --- persistence ----------------------------------------------------------- */

function persist(): void {
  if (current === null) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage denial (private mode, quota) costs persistence across a reload,
    // not the demo itself — the in-memory copy is still the live world.
  }
}

function restore(): AppState | null {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored === null) return null;
    const parsed = JSON.parse(stored) as AppState;
    // A shape check rather than a full validation: the only way this document
    // is malformed is a version of the app that wrote a different one, and the
    // right answer to that is a fresh world, not a broken screen.
    if (!Array.isArray(parsed.boards) || !Array.isArray(parsed.tasks)) return null;
    return { ...parsed, events: parsed.events ?? [] };
  } catch {
    return null;
  }
}

/* --- session --------------------------------------------------------------- */

/**
 * True while this tab is in demo mode. Every function in `lib/api.ts` asks
 * this first, and it is the only switch there is.
 */
export function isDemo(): boolean {
  if (current !== null) return true;
  current = restore();
  return current !== null;
}

/**
 * Seed a fresh world and enter demo mode.
 *
 * Always re-seeds: the button says "demo", and a visitor who left one half
 * finished in this tab yesterday should get the tour, not their own leftovers.
 * The caller navigates afterwards, which boots the app against this world.
 */
export function startDemo(): void {
  current = buildDemoState();
  persist();
  // Land in Personal, whatever this browser was last looking at — the demo's
  // Personal boards are the ones the tour opens on.
  try {
    localStorage.setItem('cairn:context', 'personal');
  } catch {
    // Not worth failing the demo over; the context just stays where it was.
  }
}

/** Drop the world and leave demo mode. The caller is responsible for the exit. */
export function endDemo(): void {
  current = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clean up if storage was never available.
  }
}

/** The live world, seeding one if this is somehow reached before `startDemo`. */
function state(): AppState {
  current ??= restore() ?? buildDemoState();
  return current;
}

/* --- helpers --------------------------------------------------------------- */

function id(): string {
  return crypto.randomUUID();
}

/** Resolve on the microtask queue, like a `fetch` that hit a warm cache. */
function ok<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function fail(message: string): never {
  throw new Error(message);
}

/** Apply only the keys a patch actually carries — `undefined` means untouched. */
function patched<T extends object>(entity: T, patch: object): T {
  const next = { ...entity };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/* --- reads ----------------------------------------------------------------- */

export function getState(): Promise<AppState> {
  // A copy, so a caller mutating what it got cannot reach into the world.
  const { boards, tasks, events, settings } = state();
  return ok({ boards: [...boards], tasks: [...tasks], events: [...events], settings });
}

/* --- boards ---------------------------------------------------------------- */

export function createBoard(draft: BoardDraft): Promise<Board> {
  const now = Date.now();
  const board: Board = {
    id: id(),
    context: draft.context,
    name: draft.name,
    description: draft.description ?? null,
    accent: draft.accent ?? null,
    position: draft.position,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  state().boards.push(board);
  persist();
  return ok(board);
}

export function updateBoard(boardId: string, patch: BoardPatch): Promise<Board> {
  const world = state();
  const index = world.boards.findIndex((board) => board.id === boardId);
  if (index === -1) fail('board not found');

  const { archived, ...fields } = patch;
  const next: Board = {
    ...patched(world.boards[index], fields),
    ...(archived === undefined ? {} : { archivedAt: archived ? Date.now() : null }),
    updatedAt: Date.now(),
  };
  world.boards[index] = next;
  persist();
  return ok(next);
}

export function deleteBoard(boardId: string): Promise<void> {
  const world = state();
  world.boards = world.boards.filter((board) => board.id !== boardId);
  // The board's tasks go with it, exactly as the foreign key does server-side.
  const removed = new Set(
    world.tasks.filter((task) => task.boardId === boardId).map((task) => task.id),
  );
  world.tasks = world.tasks
    .filter((task) => task.boardId !== boardId)
    // `ON DELETE SET NULL`: deleting a prerequisite releases its dependents
    // rather than taking them with it (§6.4).
    .map((task) =>
      task.dependsOn !== null && removed.has(task.dependsOn) ? { ...task, dependsOn: null } : task,
    );
  persist();
  return ok(undefined);
}

/* --- tasks ----------------------------------------------------------------- */

export function createTask(draft: TaskDraft): Promise<Task> {
  const world = state();
  if (!world.boards.some((board) => board.id === draft.boardId)) fail('board not found');

  const now = Date.now();
  const task: Task = {
    id: id(),
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
  world.tasks.push(task);
  persist();
  return ok(task);
}

export function updateTask(taskId: string, patch: TaskPatch): Promise<Task> {
  const world = state();
  const index = world.tasks.findIndex((task) => task.id === taskId);
  if (index === -1) fail('task not found');

  const { completed, ...fields } = patch;
  const next: Task = {
    ...patched(world.tasks[index], fields),
    // Server-clocked, like the Worker: the client sends the flag and never a
    // timestamp (§6.5).
    ...(completed === undefined ? {} : { completedAt: completed ? Date.now() : null }),
    updatedAt: Date.now(),
  };

  // The one rule worth re-checking here, because it is the one that can make
  // the data unworkable rather than merely wrong: a link that closes a cycle
  // gates every task in it forever. The composer builds its dropdown from the
  // same function, so this refuses nothing a user could reach by hand.
  if (next.dependsOn !== null) {
    const others = world.tasks.filter((task) => task.id !== next.id);
    const prerequisite = others.find((task) => task.id === next.dependsOn);
    if (!prerequisite || !canDependOn(next, prerequisite, lookupOf([...others, next]))) {
      fail('dependsOn must be another task on the same board');
    }
  }

  world.tasks[index] = next;
  persist();
  return ok(next);
}

export function deleteTask(taskId: string): Promise<void> {
  const world = state();
  world.tasks = world.tasks
    .filter((task) => task.id !== taskId)
    .map((task) => (task.dependsOn === taskId ? { ...task, dependsOn: null } : task));
  persist();
  return ok(undefined);
}

/* --- planner events -------------------------------------------------------- */

export function createEvent(draft: EventDraft): Promise<PlannerEvent> {
  const now = Date.now();
  const event: PlannerEvent = { ...draft, id: id(), createdAt: now, updatedAt: now };
  state().events.push(event);
  persist();
  return ok(event);
}

export function updateEvent(eventId: string, patch: EventPatch): Promise<PlannerEvent> {
  const world = state();
  const index = world.events.findIndex((event) => event.id === eventId);
  if (index === -1) fail('event not found');

  const next: PlannerEvent = { ...patched(world.events[index], patch), updatedAt: Date.now() };
  world.events[index] = next;
  persist();
  return ok(next);
}

export function deleteEvent(eventId: string): Promise<void> {
  const world = state();
  world.events = world.events.filter((event) => event.id !== eventId);
  persist();
  return ok(undefined);
}

/* --- settings -------------------------------------------------------------- */

export function putSettings(settings: Settings): Promise<Settings> {
  const world = state();
  world.settings = settings;
  persist();
  return ok(settings);
}
