/**
 * Auth endpoints. PROJECT-SPEC.md §6.1.
 *
 *   POST /api/login    204 + Set-Cookie, or 401
 *   POST /api/logout   204, always — deletes the row and clears the cookie
 *   GET  /api/session  204 when the session is live, 401 otherwise
 *
 * The failure responses deliberately do not distinguish "wrong password" from
 * "rate limited": both are 401 with the body `{"error":"invalid"}`. The
 * rate-limited one additionally carries `retryAfter` so the legitimate owner
 * can be told when to try again, and that is the only difference between them.
 */

import {
  MissingPasswordError,
  SESSION_COOKIE,
  checkRateLimit,
  clearFailures,
  clearedSessionCookie,
  clientIp,
  createSession,
  deleteSession,
  isSessionValid,
  logMissingPasswordOnce,
  readCookie,
  recordFailure,
  sessionCookie,
  verifyPassword,
} from '../auth';
import type { Env } from '../db';
import { apiError, noContent } from '../http';

/** The single failure response shape. `retryAfter` is the only variation. */
function invalid(retryAfter?: number): Response {
  return retryAfter === undefined
    ? apiError('invalid', 401)
    : apiError('invalid', 401, retryAfter);
}

async function login(request: Request, env: Env): Promise<Response> {
  const ip = clientIp(request);

  // The limiter is consulted before the password is even read, so a locked-out
  // caller learns nothing from the attempt — not even by submitting the real
  // password. It also means the 15-minute window is not extended by attempts
  // made during it.
  const limit = await checkRateLimit(env, ip);
  if (limit.locked) return invalid(limit.retryAfter);

  let password: unknown;
  try {
    const body = (await request.json()) as { password?: unknown } | null;
    password = body?.password;
  } catch {
    password = undefined;
  }

  if (typeof password !== 'string' || password.length === 0) {
    // A malformed body is a failed attempt like any other: same response, and
    // it counts toward the limiter so the endpoint cannot be probed for free.
    await recordFailure(env, ip);
    return invalid();
  }

  let ok: boolean;
  try {
    ok = await verifyPassword(password, env);
  } catch (err) {
    if (err instanceof MissingPasswordError) {
      logMissingPasswordOnce();
      return apiError('server', 500);
    }
    throw err;
  }

  if (!ok) {
    // Record the failure, but answer with the plain 401 — the caller finds out
    // they are locked out on their *next* attempt, from checkRateLimit above.
    await recordFailure(env, ip);
    return invalid();
  }

  await clearFailures(env, ip);
  const id = await createSession(env);
  return noContent({ 'set-cookie': sessionCookie(id) });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const id = readCookie(request, SESSION_COOKIE);
  // Server-side destruction is the point: clearing the cookie alone would leave
  // a stolen value usable for 90 days.
  if (id) await deleteSession(env, id);
  return noContent({ 'set-cookie': clearedSessionCookie() });
}

async function session(request: Request, env: Env): Promise<Response> {
  const id = readCookie(request, SESSION_COOKIE);
  if (id && (await isSessionValid(env, id))) return noContent();
  return apiError('unauthorized', 401);
}

/**
 * Route the three auth paths. Returns null when the path is not one of them,
 * so the router can fall through to the session-gated endpoints.
 */
export function handleAuth(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response> | null {
  if (pathname === '/api/login') {
    if (request.method !== 'POST') return Promise.resolve(apiError('Method not allowed', 405));
    return login(request, env);
  }

  if (pathname === '/api/logout') {
    if (request.method !== 'POST') return Promise.resolve(apiError('Method not allowed', 405));
    return logout(request, env);
  }

  if (pathname === '/api/session') {
    if (request.method !== 'GET') return Promise.resolve(apiError('Method not allowed', 405));
    return session(request, env);
  }

  return null;
}
