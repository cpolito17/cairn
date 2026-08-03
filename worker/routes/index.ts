/**
 * API router.
 *
 * The three auth paths are open by definition; every other /api/* path goes
 * through `requireSession` before anything else can look at it. The data
 * endpoints are dispatched after that gate, never beside it.
 *
 * The whole read surface is one `GET /api/state`. This is a single-user app
 * with a small dataset: a full snapshot in one round trip beats per-board
 * fetching on both size and latency, and it is what makes Up Next — which
 * spans every board in a context — free to compute on the client.
 */

import type { AppState } from '../../shared/types';
import { requireSession } from '../auth';
import type { Env } from '../db';
import { enableForeignKeys, selectBoards, selectTasks } from '../db';
import { apiError, json } from '../http';
import { BadRequest } from '../validate';
import { handleAuth } from './auth';
import { handleBoards } from './boards';
import { handleTasks } from './tasks';

export { apiError, json } from '../http';

async function state(env: Env): Promise<Response> {
  // Everything, including archived boards and completed tasks — the client
  // decides what to show, and it cannot decide from data it does not have.
  const [boards, tasks] = await Promise.all([selectBoards(env.DB), selectTasks(env.DB)]);
  const body: AppState = { boards, tasks };
  return json(body);
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  const auth = handleAuth(request, env, pathname);
  if (auth) return auth;

  const unauthorized = await requireSession(request, env);
  if (unauthorized) return unauthorized;

  try {
    if (pathname === '/api/state') {
      if (request.method !== 'GET') return apiError('Method not allowed', 405);
      return await state(env);
    }

    // D1 does not persist `PRAGMA foreign_keys` across connections, so the
    // cascade from boards to tasks only fires if it is turned on for the
    // connection doing the deleting.
    if (request.method !== 'GET') await enableForeignKeys(env.DB);

    const response = handleBoards(request, env, pathname) ?? handleTasks(request, env, pathname);
    if (response) return await response;

    return apiError('Not found', 404);
  } catch (err) {
    // A rejected body never reaches a write: the parsers throw before any
    // statement runs.
    if (err instanceof BadRequest) return apiError(err.message, 400);
    throw err;
  }
}
