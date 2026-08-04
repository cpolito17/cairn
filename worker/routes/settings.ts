/**
 * The settings endpoint. PROJECT-SPEC-V2.md §3.2.
 *
 *   PUT /api/settings   store the whole document, return what was saved
 *
 * There is deliberately no `GET`. `GET /api/state` already carries settings
 * alongside boards and tasks, which keeps the cold load at one round trip (§2);
 * a second request for five values would be a second request for nothing.
 *
 * The body is the *whole* document, not a patch. Five values written as a unit
 * by one user is what the JSON-blob storage assumes, and a partial write would
 * need a read-modify-write that two devices could interleave — last-write-wins
 * on the whole document is both simpler and what §6.8 already promises.
 */

import type { Env } from '../db';
import { upsertSettings } from '../db';
import { apiError, json } from '../http';
import { jsonBody, requiredSettings } from '../validate';

async function put(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  const settings = requiredSettings(body);
  return json(await upsertSettings(env.DB, settings));
}

/** Returns null when the path is not the settings path, so the router falls through. */
export function handleSettings(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== '/api/settings') return null;
  if (request.method !== 'PUT') return Promise.resolve(apiError('Method not allowed', 405));
  return put(request, env);
}
