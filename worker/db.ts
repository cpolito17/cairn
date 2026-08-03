/**
 * D1 access and the snake_case ↔ camelCase boundary.
 *
 * Everything above this file speaks the wire types in `shared/types.ts`; the
 * column names never escape it. Query implementations arrive with the API
 * layer — this issue establishes the connection handling and the row mappers.
 */

import type { Board, Context, Difficulty, Duration, Task } from '../shared/types';

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
  duration: string | null;
  difficulty: number | null;
  priority: number;
  blocked: number;
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
    duration: row.duration as Duration | null,
    difficulty: row.difficulty as Difficulty | null,
    priority: row.priority !== 0,
    blocked: row.blocked !== 0,
    position: row.position,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}
