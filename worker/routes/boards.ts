/**
 * Board endpoints. PROJECT-SPEC.md §6.3.
 *
 *   POST   /api/boards       create
 *   PATCH  /api/boards/:id   rename, re-describe, reposition, archive/unarchive
 *   DELETE /api/boards/:id   permanent, taking the board's tasks with it
 *
 * Reads live in `GET /api/state` — there is no per-board GET, deliberately.
 * Positions arrive from the client; this module stores what it is given.
 */

import type { ColumnPatch, Env } from '../db';
import { deleteBoard, insertBoard, selectBoard, updateBoard } from '../db';
import { apiError, json, noContent } from '../http';
import {
  MAX_BOARD_NAME,
  absent,
  boolean,
  jsonBody,
  nullableText,
  requiredContext,
  requiredName,
  requiredPosition,
} from '../validate';

async function create(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);

  const board = await insertBoard(env.DB, {
    context: requiredContext(body.context),
    name: requiredName(body.name, MAX_BOARD_NAME, 'name'),
    description: absent(body, 'description') ? null : nullableText(body.description, 'description'),
    position: requiredPosition(body.position),
  });

  return json(board, { status: 201 });
}

async function patch(request: Request, env: Env, id: string): Promise<Response> {
  const body = await jsonBody(request);
  const columns: ColumnPatch = {};

  if (!absent(body, 'name')) columns.name = requiredName(body.name, MAX_BOARD_NAME, 'name');
  if (!absent(body, 'description')) {
    columns.description = nullableText(body.description, 'description');
  }
  if (!absent(body, 'position')) columns.position = requiredPosition(body.position);
  // Archive is a timestamp, not a flag: the wire says `archived: true`, the
  // column records when. Un-archiving discards the timestamp rather than
  // keeping it, because nothing in v1 reads "archived once, then restored".
  if (!absent(body, 'archived')) {
    columns.archived_at = boolean(body.archived, 'archived') ? Date.now() : null;
  }

  // A patch that names no fields is not an error and is not a write either.
  if (Object.keys(columns).length === 0) {
    const existing = await selectBoard(env.DB, id);
    return existing ? json(existing) : apiError('board not found', 404);
  }

  const board = await updateBoard(env.DB, id, columns);
  return board ? json(board) : apiError('board not found', 404);
}

async function destroy(env: Env, id: string): Promise<Response> {
  const deleted = await deleteBoard(env.DB, id);
  return deleted ? noContent() : apiError('board not found', 404);
}

/** Returns null when the path is not a board path, so the router falls through. */
export function handleBoards(request: Request, env: Env, pathname: string): Promise<Response> | null {
  if (pathname === '/api/boards') {
    if (request.method !== 'POST') return Promise.resolve(apiError('Method not allowed', 405));
    return create(request, env);
  }

  const match = /^\/api\/boards\/([^/]+)$/.exec(pathname);
  if (!match) return null;

  const id = decodeURIComponent(match[1]);
  if (request.method === 'PATCH') return patch(request, env, id);
  if (request.method === 'DELETE') return destroy(env, id);
  return Promise.resolve(apiError('Method not allowed', 405));
}
