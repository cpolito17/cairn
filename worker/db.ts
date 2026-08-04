/**
 * D1 access and the snake_case ↔ camelCase boundary.
 *
 * Everything above this file speaks the wire types in `shared/types.ts`; the
 * column names never escape it. Query implementations arrive with the API
 * layer — this issue establishes the connection handling and the row mappers.
 */

import { parseStoredSettings, SETTINGS_KEY } from '../shared/settings';
import type { Board, Context, Difficulty, Settings, Task } from '../shared/types';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * The single password, in plaintext, as a Worker secret. Optional in the type
   * only because an unset secret is a runtime state the code must handle — see
   * `worker/auth.ts` and docs/PASSWORD-SETUP.md. There is no default.
   */
  AUTH_PASSWORD?: string;
}

/**
 * D1 does not persist `PRAGMA foreign_keys` across connections, so the ON
 * DELETE CASCADE from tasks to boards only fires if it is enabled for the
 * connection doing the work. Call this once per request before any write.
 */
export async function enableForeignKeys(db: D1Database): Promise<void> {
  await db.exec('PRAGMA foreign_keys = ON');
}

/** A row of `boards` as D1 returns it. */
export interface BoardRow {
  id: string;
  context: string;
  name: string;
  description: string | null;
  position: string;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A row of `tasks` as D1 returns it. */
export interface TaskRow {
  id: string;
  board_id: string;
  name: string;
  notes: string | null;
  due_date: string | null;
  due_time: string | null;
  duration_minutes: number | null;
  scheduled_at: number | null;
  difficulty: number | null;
  priority: number;
  blocked: number;
  depends_on: string | null;
  position: string;
  created_at: number;
  completed_at: number | null;
  updated_at: number;
}

export function rowToBoard(row: BoardRow): Board {
  return {
    id: row.id,
    context: row.context as Context,
    name: row.name,
    description: row.description,
    position: row.position,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    boardId: row.board_id,
    name: row.name,
    notes: row.notes,
    dueDate: row.due_date,
    dueTime: row.due_time,
    durationMinutes: row.duration_minutes,
    scheduledAt: row.scheduled_at,
    difficulty: row.difficulty as Difficulty | null,
    priority: row.priority !== 0,
    blocked: row.blocked !== 0,
    dependsOn: row.depends_on,
    position: row.position,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

/* --- queries -------------------------------------------------------------- */

/**
 * Column order is fixed here rather than `SELECT *` so a future migration that
 * adds a column cannot silently change what the mappers above receive.
 */
const BOARD_COLUMNS =
  'id, context, name, description, position, archived_at, created_at, updated_at';
const TASK_COLUMNS =
  'id, board_id, name, notes, due_date, due_time, duration_minutes, scheduled_at, difficulty, ' +
  'priority, blocked, depends_on, position, created_at, completed_at, updated_at';

/**
 * Rows sort by position, then by id.
 *
 * The id tie-break is the read-time half of the fractional-index contract in
 * `shared/order.ts`: two devices can mint the same position concurrently, and
 * when they do, both clients must still agree on which comes first.
 */
export async function selectBoards(db: D1Database): Promise<Board[]> {
  const { results } = await db
    .prepare(`SELECT ${BOARD_COLUMNS} FROM boards ORDER BY position, id`)
    .all<BoardRow>();
  return results.map(rowToBoard);
}

export async function selectTasks(db: D1Database): Promise<Task[]> {
  const { results } = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY position, id`)
    .all<TaskRow>();
  return results.map(rowToTask);
}

/**
 * Every task on one board. Used to validate a dependency: deciding whether a
 * link would close a cycle means walking the chain, and the chain never leaves
 * the board.
 */
export async function selectTasksOfBoard(db: D1Database, boardId: string): Promise<Task[]> {
  const { results } = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE board_id = ? ORDER BY position, id`)
    .bind(boardId)
    .all<TaskRow>();
  return results.map(rowToTask);
}

export async function selectBoard(db: D1Database, id: string): Promise<Board | null> {
  const row = await db
    .prepare(`SELECT ${BOARD_COLUMNS} FROM boards WHERE id = ?`)
    .bind(id)
    .first<BoardRow>();
  return row ? rowToBoard(row) : null;
}

export async function selectTask(db: D1Database, id: string): Promise<Task | null> {
  const row = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
    .bind(id)
    .first<TaskRow>();
  return row ? rowToTask(row) : null;
}

export interface NewBoard {
  context: Context;
  name: string;
  description: string | null;
  position: string;
}

export async function insertBoard(
  db: D1Database,
  board: NewBoard,
  now = Date.now(),
): Promise<Board> {
  const id = crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO boards (id, context, name, description, position, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
       RETURNING ${BOARD_COLUMNS}`,
    )
    .bind(id, board.context, board.name, board.description, board.position, now, now)
    .first<BoardRow>();
  return rowToBoard(row as BoardRow);
}

export interface NewTask {
  boardId: string;
  name: string;
  notes: string | null;
  dueDate: string | null;
  dueTime: string | null;
  durationMinutes: number | null;
  scheduledAt: number | null;
  difficulty: Difficulty | null;
  priority: boolean;
  blocked: boolean;
  dependsOn: string | null;
  position: string;
}

export async function insertTask(db: D1Database, task: NewTask, now = Date.now()): Promise<Task> {
  const id = crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO tasks (id, board_id, name, notes, due_date, due_time, duration_minutes,
                          scheduled_at, difficulty, priority, blocked, depends_on, position,
                          created_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       RETURNING ${TASK_COLUMNS}`,
    )
    .bind(
      id,
      task.boardId,
      task.name,
      task.notes,
      task.dueDate,
      task.dueTime,
      task.durationMinutes,
      task.scheduledAt,
      task.difficulty,
      task.priority ? 1 : 0,
      task.blocked ? 1 : 0,
      task.dependsOn,
      task.position,
      now,
      now,
    )
    .first<TaskRow>();
  return rowToTask(row as TaskRow);
}

/** A column name mapped to the value to write. Empty means "nothing changed". */
export type ColumnPatch = Record<string, string | number | null>;

async function update<Row>(
  db: D1Database,
  table: string,
  columns: string,
  id: string,
  patch: ColumnPatch,
  now: number,
): Promise<Row | null> {
  const assignments = Object.keys(patch).map((column) => `${column} = ?`);
  assignments.push('updated_at = ?');

  return db
    .prepare(
      `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ? RETURNING ${columns}`,
    )
    .bind(...Object.values(patch), now, id)
    .first<Row>();
}

/** Returns null when no row has that id, which the route turns into a 404. */
export async function updateBoard(
  db: D1Database,
  id: string,
  patch: ColumnPatch,
  now = Date.now(),
): Promise<Board | null> {
  const row = await update<BoardRow>(db, 'boards', BOARD_COLUMNS, id, patch, now);
  return row ? rowToBoard(row) : null;
}

export async function updateTask(
  db: D1Database,
  id: string,
  patch: ColumnPatch,
  now = Date.now(),
): Promise<Task | null> {
  const row = await update<TaskRow>(db, 'tasks', TASK_COLUMNS, id, patch, now);
  return row ? rowToTask(row) : null;
}

/**
 * Deleting a board takes its tasks with it through the foreign key, which is
 * why every mutating request calls `enableForeignKeys` first. Returns false
 * when nothing matched.
 */
export async function deleteBoard(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM boards WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteTask(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

/* --- settings ------------------------------------------------------------- */

/**
 * The stored settings document, or the defaults when there is none.
 *
 * A missing row is the normal state of a database nobody has written settings
 * to, and a malformed one is a state the app must survive rather than fail on
 * (§3.2) — `parseStoredSettings` handles both, and this function cannot fail
 * for either reason.
 */
export async function selectSettings(db: D1Database): Promise<Settings> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(SETTINGS_KEY)
    .first<{ value: string }>();
  return parseStoredSettings(row ? row.value : null);
}

/**
 * Write the whole document. An upsert rather than an insert-or-update pair:
 * there is one row, it may or may not exist yet, and both cases are the same
 * statement.
 */
export async function upsertSettings(
  db: D1Database,
  settings: Settings,
  now = Date.now(),
): Promise<Settings> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(SETTINGS_KEY, JSON.stringify(settings), now)
    .run();
  return settings;
}
