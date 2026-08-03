/**
 * Response helpers shared by the router and the route modules.
 *
 * These live below the router so a route module can build a response without
 * importing the router that dispatches to it.
 */

import type { ApiError } from '../shared/types';

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

/** 204 with no body. */
export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}
