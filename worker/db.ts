/**
 * D1 access and the snake_case ↔ camelCase boundary.
 *
 * Everything above this file speaks the wire types in `shared/types.ts`; the
 * column names never escape it. Query implementations arrive with the API
 * layer — this issue establishes the connection handling and the row mappers.
 */

import { parseStoredSettings, SETTINGS_KEY } from '../shared/settings';
import type { Board, BoardAccent, Context, Difficulty, PlannerEvent, Settings, Task } from '../shared/types';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * The single password, in plaintext, as a Worker secret. Optional in the type
   * only because an unset secret is a runtime state the code must handle — see
   * `worker/auth.ts` and docs/PASSWORD-SETUP.md. There is no default.
   */
  AUTH_PASSWORD?: string;
  /**
   * The VAPID key pair and contact address, as Worker secrets. All three are
   * optional in the type for the same reason `AUTH_PASSWORD` is: a deployment
   * without them is a real, working deployment that simply has notifications
   * switched off, and it must not fail to boot over that. `worker/push/vapid.ts`
   * is where their absence is turned into a decision.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
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
  accent: string | null;
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
  position: string;
  created_at: number;
  completed_at: number | null;
  updated_at: number;
}

export interface PlannerEventRow {
  id: string; context: string; name: string; weekdays: string; frequency_weeks: number;
  starts_on: string; start_minutes: number; duration_minutes: number; created_at: number; updated_at: number;
}

export function rowToBoard(row: BoardRow): Board {
  return {
    id: row.id,
    context: row.context as Context,
    name: row.name,
    description: row.description,
    accent: row.accent as BoardAccent | null,
    position: row.position,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A task row plus the prerequisite ids read from `task_dependencies`.
 *
 * The edges are a separate table, so they are a separate read and are handed in
 * rather than pulled from the row. Defaulting to empty is deliberate: a task
 * with no links is the overwhelmingly common case, and it is also the honest
 * answer for any caller that has not asked for the edges.
 */
export function rowToTask(row: TaskRow, dependsOn: string[] = []): Task {
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
    dependsOn,
    position: row.position,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export function rowToEvent(row: PlannerEventRow): PlannerEvent {
  return {
    id: row.id, context: row.context as Context, name: row.name,
    weekdays: JSON.parse(row.weekdays) as number[], frequencyWeeks: row.frequency_weeks as 1 | 2 | 4,
    startsOn: row.starts_on, startMinutes: row.start_minutes, durationMinutes: row.duration_minutes,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/* --- queries -------------------------------------------------------------- */

/**
 * Column order is fixed here rather than `SELECT *` so a future migration that
 * adds a column cannot silently change what the mappers above receive.
 */
const BOARD_COLUMNS =
  'id, context, name, description, accent, position, archived_at, created_at, updated_at';
const TASK_COLUMNS =
  'id, board_id, name, notes, due_date, due_time, duration_minutes, scheduled_at, difficulty, ' +
  'priority, blocked, position, created_at, completed_at, updated_at';
const EVENT_COLUMNS =
  'id, context, name, weekdays, frequency_weeks, starts_on, start_minutes, duration_minutes, created_at, updated_at';

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
  // Two queries rather than a join: a join would repeat every task column once
  // per edge and leave this code un-flattening it, for a table where most rows
  // have no edge at all.
  const [{ results }, edges] = await Promise.all([
    db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY position, id`).all<TaskRow>(),
    selectAllDependencies(db),
  ]);
  return results.map((row) => rowToTask(row, edges.get(row.id) ?? []));
}

/* --- task dependencies ----------------------------------------------------- */

/**
 * Prerequisite ids by task id.
 *
 * Ordered by when the link was made, then by id. Order is not decoration: it is
 * what the composer lists and what the Blockers layout uses to break ties, and
 * an unordered read would let a node's incoming edges swap places between two
 * renders of data that never changed.
 */
interface DependencyRow {
  task_id: string;
  depends_on: string;
}

function groupDependencies(rows: DependencyRow[]): Map<string, string[]> {
  const byTask = new Map<string, string[]>();
  for (const row of rows) {
    const existing = byTask.get(row.task_id);
    if (existing) existing.push(row.depends_on);
    else byTask.set(row.task_id, [row.depends_on]);
  }
  return byTask;
}

const DEPENDENCY_ORDER = 'ORDER BY created_at, depends_on';

export async function selectAllDependencies(db: D1Database): Promise<Map<string, string[]>> {
  const { results } = await db
    .prepare(`SELECT task_id, depends_on FROM task_dependencies ${DEPENDENCY_ORDER}`)
    .all<DependencyRow>();
  return groupDependencies(results);
}

export async function selectBoardDependencies(
  db: D1Database,
  boardId: string,
): Promise<Map<string, string[]>> {
  // Scoped by the *dependent's* board. A link never crosses boards, so this is
  // the whole of that board's graph.
  const { results } = await db
    .prepare(
      `SELECT d.task_id, d.depends_on
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id
       WHERE t.board_id = ?
       ${DEPENDENCY_ORDER.replace('created_at', 'd.created_at').replace('depends_on', 'd.depends_on')}`,
    )
    .bind(boardId)
    .all<DependencyRow>();
  return groupDependencies(results);
}

export async function selectDependenciesOf(db: D1Database, taskId: string): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT task_id, depends_on FROM task_dependencies WHERE task_id = ? ${DEPENDENCY_ORDER}`)
    .bind(taskId)
    .all<DependencyRow>();
  return results.map((row) => row.depends_on);
}

/**
 * Set a task's prerequisites to exactly `dependsOn`.
 *
 * Delete-then-insert rather than a diff. The set is a handful of rows for one
 * user, the whole thing is one batch, and a diff would be more code for the
 * same result — with the extra failure mode of computing the diff wrongly.
 *
 * `created_at` is therefore rewritten for links that survive the replacement.
 * That is a real cost and an accepted one: the only thing reading it is the
 * ordering above, and "the order you added them" staying stable across an
 * unrelated edit is not worth a diff to preserve.
 */
export async function replaceDependencies(
  db: D1Database,
  taskId: string,
  dependsOn: readonly string[],
  now = Date.now(),
): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').bind(taskId),
    ...dependsOn.map((prerequisiteId) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on, created_at) VALUES (?, ?, ?)',
        )
        .bind(taskId, prerequisiteId, now),
    ),
  ];
  await db.batch(statements);
}

export async function selectEvents(db: D1Database): Promise<PlannerEvent[]> {
  const { results } = await db.prepare(`SELECT ${EVENT_COLUMNS} FROM planner_events ORDER BY start_minutes, id`).all<PlannerEventRow>();
  return results.map(rowToEvent);
}

export async function selectEvent(db: D1Database, id: string): Promise<PlannerEvent | null> {
  const row = await db.prepare(`SELECT ${EVENT_COLUMNS} FROM planner_events WHERE id = ?`).bind(id).first<PlannerEventRow>();
  return row ? rowToEvent(row) : null;
}

/**
 * Every task on one board. Used to validate a dependency: deciding whether a
 * link would close a cycle means walking the chain, and the chain never leaves
 * the board.
 */
export async function selectTasksOfBoard(db: D1Database, boardId: string): Promise<Task[]> {
  const [{ results }, edges] = await Promise.all([
    db
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE board_id = ? ORDER BY position, id`)
      .bind(boardId)
      .all<TaskRow>(),
    selectBoardDependencies(db, boardId),
  ]);
  return results.map((row) => rowToTask(row, edges.get(row.id) ?? []));
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
  return row ? rowToTask(row, await selectDependenciesOf(db, id)) : null;
}

export interface NewBoard {
  context: Context;
  name: string;
  description: string | null;
  accent: BoardAccent | null;
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
      `INSERT INTO boards (id, context, name, description, accent, position, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
       RETURNING ${BOARD_COLUMNS}`,
    )
    .bind(id, board.context, board.name, board.description, board.accent, board.position, now, now)
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
  /** The prerequisites to link, written to `task_dependencies` after insert. */
  dependsOn: string[];
  position: string;
}

export async function insertTask(db: D1Database, task: NewTask, now = Date.now()): Promise<Task> {
  const id = crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO tasks (id, board_id, name, notes, due_date, due_time, duration_minutes,
                          scheduled_at, difficulty, priority, blocked, position,
                          created_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
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
      task.position,
      now,
      now,
    )
    .first<TaskRow>();
  return rowToTask(row as TaskRow);
}

export type NewPlannerEvent = Omit<PlannerEvent, 'id' | 'createdAt' | 'updatedAt'>;

export async function insertEvent(db: D1Database, event: NewPlannerEvent, now = Date.now()): Promise<PlannerEvent> {
  const id = crypto.randomUUID();
  const row = await db.prepare(
    `INSERT INTO planner_events (id, context, name, weekdays, frequency_weeks, starts_on, start_minutes, duration_minutes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${EVENT_COLUMNS}`,
  ).bind(id, event.context, event.name, JSON.stringify(event.weekdays), event.frequencyWeeks, event.startsOn,
    event.startMinutes, event.durationMinutes, now, now).first<PlannerEventRow>();
  return rowToEvent(row as PlannerEventRow);
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

export async function updateEvent(db: D1Database, id: string, patch: ColumnPatch, now = Date.now()): Promise<PlannerEvent | null> {
  const row = await update<PlannerEventRow>(db, 'planner_events', EVENT_COLUMNS, id, patch, now);
  return row ? rowToEvent(row) : null;
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

export async function deleteEvent(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM planner_events WHERE id = ?').bind(id).run();
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

/* --- push notifications ---------------------------------------------------- */

/**
 * A browser that has granted notification permission.
 *
 * Deliberately absent from `AppState`: this is not app data, it is a device's
 * relationship with a push service, and the only client that can meaningfully
 * ask about it is the one holding the subscription.
 */
export interface PushSubscriptionRecord {
  endpoint: string;
  /** base64url, exactly as the browser reported it. */
  p256dh: string;
  /** base64url. */
  auth: string;
  userAgent: string | null;
  createdAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  failureCount: number;
}

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  failure_count: number;
}

function rowToSubscription(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    failureCount: row.failure_count,
  };
}

const SUBSCRIPTION_COLUMNS =
  'endpoint, p256dh, auth, user_agent, created_at, last_success_at, last_failure_at, failure_count';

export async function selectPushSubscriptions(
  db: D1Database,
): Promise<PushSubscriptionRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM push_subscriptions ORDER BY created_at`)
    .all<PushSubscriptionRow>();
  return results.map(rowToSubscription);
}

/**
 * Record a subscription, replacing any earlier row for the same endpoint.
 *
 * The upsert resets the failure counters as well as the keys. A browser that
 * re-subscribes has produced fresh key material, so whatever went wrong with
 * the previous attempt is not evidence about this one.
 */
export async function upsertPushSubscription(
  db: D1Database,
  subscription: { endpoint: string; p256dh: string; auth: string; userAgent: string | null },
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO push_subscriptions
         (endpoint, p256dh, auth, user_agent, created_at, last_success_at, last_failure_at, failure_count)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 0)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         last_failure_at = NULL,
         failure_count = 0`,
    )
    .bind(
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
      subscription.userAgent,
      now,
    )
    .run();
}

export async function deletePushSubscription(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
}

export async function countPushSubscriptions(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM push_subscriptions')
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** A delivery succeeded: stamp it and clear the consecutive-failure run. */
export async function recordPushSuccess(
  db: D1Database,
  endpoint: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      'UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE endpoint = ?',
    )
    .bind(now, endpoint)
    .run();
}

/** A delivery failed for a reason that is not "this subscription is gone". */
export async function recordPushFailure(
  db: D1Database,
  endpoint: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      'UPDATE push_subscriptions SET last_failure_at = ?, failure_count = failure_count + 1 WHERE endpoint = ?',
    )
    .bind(now, endpoint)
    .run();
}

/* --- the sent ledger ------------------------------------------------------- */

/** How long a sent key is kept. Comfortably longer than any catch-up window. */
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The keys sent recently enough to still suppress a duplicate.
 *
 * Bounded by the retention window rather than reading the whole table, so this
 * stays a small query however long the deployment has been running.
 */
export async function selectSentKeys(db: D1Database, now = Date.now()): Promise<Set<string>> {
  const { results } = await db
    .prepare('SELECT key FROM notification_log WHERE sent_at >= ?')
    .bind(now - LOG_RETENTION_MS)
    .all<{ key: string }>();
  return new Set(results.map((row) => row.key));
}

/**
 * Mark a notification as sent.
 *
 * `OR IGNORE` rather than an upsert: if the key is already there, the earlier
 * send is the one that counts, and overwriting its timestamp would extend the
 * suppression window for no reason.
 */
export async function recordSentKey(
  db: D1Database,
  key: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO notification_log (key, sent_at) VALUES (?, ?)')
    .bind(key, now)
    .run();
}

/** Drop ledger rows past the retention window. */
export async function pruneSentKeys(db: D1Database, now = Date.now()): Promise<void> {
  await db
    .prepare('DELETE FROM notification_log WHERE sent_at < ?')
    .bind(now - LOG_RETENTION_MS)
    .run();
}
