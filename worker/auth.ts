/**
 * The security boundary. PROJECT-SPEC.md §6.1.
 *
 * One password, no username. The plaintext lives only in the `AUTH_PASSWORD`
 * Worker secret (see docs/PASSWORD-SETUP.md); this module never compares it
 * directly. It derives a PBKDF2-SHA256 digest once per isolate, derives a
 * digest of each submitted password with identical parameters, and compares
 * the two over their full length in constant time.
 *
 * Sessions are opaque 256-bit ids stored as rows in D1, so logout can destroy
 * them server-side rather than merely asking the browser to forget a cookie.
 */

import type { Env } from './db';
import { apiError } from './http';

/** Cookie name. Fixed — the client never reads it (HttpOnly). */
export const SESSION_COOKIE = 'cairn_session';

/** ~90 days, in milliseconds. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Consecutive failures from one IP before the cooling-off period starts. */
export const MAX_FAILURES = 5;

/** Cooling-off period once the limiter engages, in milliseconds. */
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Fixed application salt. A per-user random salt would be the norm where there
 * are users; here there is exactly one credential and the digest is never
 * persisted — it exists only in isolate memory to keep the comparison off the
 * plaintext. The salt's job is domain separation, not per-record uniqueness.
 */
const PBKDF2_SALT = new TextEncoder().encode('cairn.auth.v1');
/**
 * 100,000 exactly, and it cannot be raised. The Workers runtime refuses PBKDF2
 * above 100,000 iterations — `deriveBits` throws
 * `Pbkdf2 failed: iteration counts above 100000 are not supported` — and that
 * throw is not a `MissingPasswordError`, so it escapes `login()` and every
 * attempt becomes an opaque 500. Local `workerd` does not enforce the cap, so
 * this only ever shows up against a deployed Worker.
 *
 * It is also the floor the security work was specified against, so 100,000 is
 * the one value that satisfies both the requirement and the platform.
 */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_BITS = 256;

/**
 * Memoized digest of `AUTH_PASSWORD` for the lifetime of this isolate. Keyed on
 * the secret's value so a rotation picked up by a warm isolate cannot be
 * answered from a stale digest.
 */
let cachedSecret: string | null = null;
let cachedDigest: Promise<ArrayBuffer> | null = null;

/** Thrown when `AUTH_PASSWORD` is missing or empty — a hard config failure. */
export class MissingPasswordError extends Error {
  constructor() {
    super('AUTH_PASSWORD is not set');
    this.name = 'MissingPasswordError';
  }
}

let missingPasswordLogged = false;

/** Log the misconfiguration once per isolate rather than once per attempt. */
export function logMissingPasswordOnce(): void {
  if (missingPasswordLogged) return;
  missingPasswordLogged = true;
  console.error(
    'AUTH_PASSWORD is unset or empty. Every login will fail with 500 until it is ' +
      'set (`wrangler secret put AUTH_PASSWORD`, or .dev.vars locally). There is ' +
      'no default password.',
  );
}

export async function derivePasswordHash(password: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: PBKDF2_SALT, iterations: PBKDF2_ITERATIONS },
    key,
    PBKDF2_BITS,
  );
}

function expectedDigest(env: Env): Promise<ArrayBuffer> {
  const secret = env.AUTH_PASSWORD;
  if (typeof secret !== 'string' || secret.length === 0) throw new MissingPasswordError();

  if (cachedSecret !== secret || cachedDigest === null) {
    cachedSecret = secret;
    cachedDigest = derivePasswordHash(secret);
  }
  return cachedDigest;
}

/**
 * Constant-time comparison over the full length of both digests.
 *
 * Every byte of both inputs is read on every call and the result is folded into
 * an accumulator; there is no early return and no data-dependent branch, so the
 * running time reveals nothing about where — or whether — the inputs differ.
 * A length mismatch is folded in the same way rather than short-circuiting.
 */
export function timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  const len = Math.max(x.length, y.length);

  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) {
    // Out-of-range reads are 0 rather than a branch out of the loop.
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Whether `password` is the configured one.
 *
 * Throws `MissingPasswordError` when `AUTH_PASSWORD` is unset — the caller
 * turns that into a 500. It never resolves `true` by falling back to anything.
 */
export async function verifyPassword(password: string, env: Env): Promise<boolean> {
  const [expected, submitted] = await Promise.all([
    expectedDigest(env),
    derivePasswordHash(password),
  ]);
  return timingSafeEqual(expected, submitted);
}

/** Reset the memoized digest. Tests only. */
export function resetPasswordCache(): void {
  cachedSecret = null;
  cachedDigest = null;
}

/* --- sessions ------------------------------------------------------------ */

/** An opaque 256-bit session id, base64url with no padding. */
export function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createSession(env: Env, now = Date.now()): Promise<string> {
  const id = newSessionId();
  await env.DB.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)')
    .bind(id, now, now + SESSION_TTL_MS)
    .run();
  return id;
}

export async function deleteSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

/**
 * Whether the id names a live session. An expired row is treated as absent and
 * deleted on the way out, so the table self-cleans under normal traffic.
 */
export async function isSessionValid(env: Env, id: string, now = Date.now()): Promise<boolean> {
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ expires_at: number }>();

  if (!row) return false;
  if (row.expires_at <= now) {
    await deleteSession(env, id);
    return false;
  }
  return true;
}

/* --- cookies ------------------------------------------------------------- */

/** Read one cookie out of a request's Cookie header. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The Set-Cookie value for a fresh session.
 *
 * `SameSite=Lax` blocks cross-site POSTs, which is the entire CSRF surface for
 * this app — that is why there is no CSRF token (§6.1, and the issue's bounds).
 * `Secure` is unconditional: `wrangler dev` serves http://localhost, and
 * browsers make an explicit exception for localhost so the cookie still sticks
 * in development.
 */
export function sessionCookie(id: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** The Set-Cookie value that expires the session cookie immediately. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/* --- rate limiting ------------------------------------------------------- */

export interface RateLimitState {
  /** True while the cooling-off period is in force. */
  locked: boolean;
  /** Seconds remaining, when locked. */
  retryAfter: number;
}

/** The client IP, as Cloudflare sees it. Absent only outside Cloudflare. */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

export async function checkRateLimit(
  env: Env,
  ip: string,
  now = Date.now(),
): Promise<RateLimitState> {
  const row = await env.DB.prepare('SELECT locked_until FROM login_attempts WHERE ip = ?')
    .bind(ip)
    .first<{ locked_until: number | null }>();

  if (!row?.locked_until || row.locked_until <= now) return { locked: false, retryAfter: 0 };
  return { locked: true, retryAfter: Math.ceil((row.locked_until - now) / 1000) };
}

/**
 * Record a failure and return the resulting limiter state.
 *
 * The counter is consecutive: it only ever resets on a successful login (or
 * when a lockout elapses and the next failure starts a fresh window), so
 * spacing attempts out does not launder them.
 */
export async function recordFailure(
  env: Env,
  ip: string,
  now = Date.now(),
): Promise<RateLimitState> {
  const row = await env.DB.prepare(
    'SELECT fails, first_fail_at, locked_until FROM login_attempts WHERE ip = ?',
  )
    .bind(ip)
    .first<{ fails: number; first_fail_at: number; locked_until: number | null }>();

  // An elapsed lockout starts a fresh window rather than resuming the old count.
  const expired = row?.locked_until != null && row.locked_until <= now;
  const fails = row && !expired ? row.fails + 1 : 1;
  const firstFailAt = row && !expired ? row.first_fail_at : now;
  const lockedUntil = fails >= MAX_FAILURES ? now + LOCKOUT_MS : null;

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, fails, first_fail_at, locked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET fails = ?, first_fail_at = ?, locked_until = ?`,
  )
    .bind(ip, fails, firstFailAt, lockedUntil, fails, firstFailAt, lockedUntil)
    .run();

  if (lockedUntil === null) return { locked: false, retryAfter: 0 };
  return { locked: true, retryAfter: Math.ceil(LOCKOUT_MS / 1000) };
}

/** Clear the failure record for an IP. Called on every successful login. */
export async function clearFailures(env: Env, ip: string): Promise<void> {
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
}

/* --- middleware ---------------------------------------------------------- */

/**
 * Gate for every `/api/*` route except the auth endpoints.
 *
 * Resolves `null` when the request carries a live session, or the 401 the
 * caller should return otherwise. A 401 from anywhere is the client's signal to
 * drop to the login screen.
 */
export async function requireSession(request: Request, env: Env): Promise<Response | null> {
  const id = readCookie(request, SESSION_COOKIE);
  if (id && (await isSessionValid(env, id))) return null;

  return apiError('unauthorized', 401);
}
