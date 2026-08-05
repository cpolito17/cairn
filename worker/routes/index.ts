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
import { enableForeignKeys, selectBoards, selectEvents, selectSettings, selectTasks } from '../db';
import { apiError, json } from '../http';
import { BadRequest } from '../validate';
import { handleAuth } from './auth';
import { handleBoards } from './boards';
import { handleSettings } from './settings';
import { handleTasks } from './tasks';
import { handleEvents } from './events';

export { apiError, json } from '../http';

async function state(env: Env): Promise<Response> {
  // Everything, including archived boards and completed tasks — the client
  // decides what to show, and it cannot decide from data it does not have.
  //
  // Settings ride along rather than getting an endpoint of their own: the cold
  // load stays one round trip (§2), and `selectSettings` answers with the
  // defaults when there is no row or the stored document is malformed, so this
  // read has no failure mode the client has to handle.
  const [boards, tasks, events, settings] = await Promise.all([
    selectBoards(env.DB),
    selectTasks(env.DB),
    selectEvents(env.DB),
    selectSettings(env.DB),
  ]);
  const body: AppState = { boards, tasks, events, settings };
  return json(body);
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  // The whole request is inside the guard, auth included: the login endpoint
  // reads `login_attempts`, so a database that is missing or behind fails
  // there too, and that failure has exactly as much right to a log line and a
  // parseable body as one from a data route.
  try {
    const auth = handleAuth(request, env, pathname);
    if (auth) return await auth;

    const unauthorized = await requireSession(request, env);
    if (unauthorized) return unauthorized;

    if (pathname === '/api/state') {
      if (request.method !== 'GET') return apiError('Method not allowed', 405);
      return await state(env);
    }

    // D1 does not persist `PRAGMA foreign_keys` across connections, so the
    // cascade from boards to tasks only fires if it is turned on for the
    // connection doing the deleting.
    if (request.method !== 'GET') await enableForeignKeys(env.DB);

    const response =
      handleBoards(request, env, pathname) ??
      handleTasks(request, env, pathname) ??
      handleEvents(request, env, pathname) ??
      handleSettings(request, env, pathname);
    if (response) return await response;

    return apiError('Not found', 404);
  } catch (err) {
    // A rejected body never reaches a write: the parsers throw before any
    // statement runs.
    if (err instanceof BadRequest) return apiError(err.message, 400);

    // Anything else is a bug or a broken environment, and it used to leave the
    // Worker by throwing — which produces Cloudflare's own 500 page, an HTML
    // body the client cannot parse, and nothing in the logs the owner can
    // search for. A schema/code mismatch (a migration applied to the repo but
    // not to the database) lands here, and it took a local reproduction to
    // find because of exactly that silence.
    //
    // So: log it, and answer with the app's own error shape. The message is
    // deliberately generic to the caller and specific in the log.
    console.error('unhandled API error', {
      pathname,
      method: request.method,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return apiError('internal error', 500);
  }
}
