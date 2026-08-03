/**
 * API router.
 *
 * A stub for now: every /api/* path 404s in the shape of `ApiError`. The seven
 * real endpoints arrive with the data layer, and auth wraps them before that.
 */

import type { ApiError } from '../../shared/types';
import type { Env } from '../db';

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

export function apiError(error: string, status: number, retryAfter?: number): Response {
  const body: ApiError = retryAfter === undefined ? { error } : { error, retryAfter };
  return json(body, { status });
}

export async function handleApi(_request: Request, _env: Env): Promise<Response> {
  return apiError('Not found', 404);
}
