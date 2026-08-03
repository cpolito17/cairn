/**
 * API router.
 *
 * The three auth paths are open by definition; every other /api/* path goes
 * through `requireSession` before anything else can look at it. The data
 * endpoints arrive with the next issue and land behind that gate, not beside it.
 */

import { requireSession } from '../auth';
import type { Env } from '../db';
import { apiError } from '../http';
import { handleAuth } from './auth';

export { apiError, json } from '../http';

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  const auth = handleAuth(request, env, pathname);
  if (auth) return auth;

  const unauthorized = await requireSession(request, env);
  if (unauthorized) return unauthorized;

  return apiError('Not found', 404);
}
