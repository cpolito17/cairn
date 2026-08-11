/**
 * Push subscription endpoints.
 *
 *   GET    /api/push          what this deployment can do, and how many devices
 *   POST   /api/push          register (or refresh) this browser's subscription
 *   DELETE /api/push          drop one endpoint
 *   POST   /api/push/test     send a test notification to every device
 *
 * Unlike settings, none of this rides on `GET /api/state`. A subscription
 * belongs to a *browser*, not to the user's data: the phone and the laptop hold
 * different ones, and a client learns about its own by asking its service
 * worker, not by reading a snapshot that describes some other device. What the
 * server can usefully answer is the pair of facts the client cannot know —
 * whether VAPID is configured at all, and what the public key is — which is
 * what `GET` is for.
 */

import type { Env } from '../db';
import {
  countPushSubscriptions,
  deletePushSubscription,
  upsertPushSubscription,
} from '../db';
import { apiError, json, noContent } from '../http';
import { sendTestNotification } from '../notify';
import { fromBase64Url } from '../push/base64';
import { vapidKeysFrom } from '../push/vapid';
import { BadRequest, jsonBody } from '../validate';

/** Longest user-agent string kept. It is a label, not a record. */
const MAX_USER_AGENT = 200;

interface PushStatus {
  /** False when the deployment has no VAPID secrets — nothing can be sent. */
  configured: boolean;
  /** The application server key a browser must subscribe with, or null. */
  publicKey: string | null;
  /** How many devices are currently subscribed, across all browsers. */
  devices: number;
}

async function status(env: Env): Promise<Response> {
  const vapid = vapidKeysFrom(env);
  const body: PushStatus = {
    configured: vapid !== null,
    publicKey: vapid?.publicKey ?? null,
    devices: await countPushSubscriptions(env.DB),
  };
  return json(body);
}

async function subscribe(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);

  const endpoint = requiredEndpoint(body.endpoint);
  const keys = body.keys;
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new BadRequest('keys must be an object with p256dh and auth');
  }
  const { p256dh, auth } = keys as Record<string, unknown>;

  await upsertPushSubscription(env.DB, {
    endpoint,
    p256dh: requiredKeyMaterial(p256dh, 'p256dh', 65),
    auth: requiredKeyMaterial(auth, 'auth', 16),
    userAgent: optionalUserAgent(body.userAgent),
  });

  return noContent();
}

async function unsubscribe(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  // Idempotent: dropping an endpoint that is already gone is the state the
  // caller wanted, and a 404 here would make the client handle a non-problem.
  await deletePushSubscription(env.DB, requiredEndpoint(body.endpoint));
  return noContent();
}

async function test(env: Env): Promise<Response> {
  const result = await sendTestNotification(env);
  if (!result.ok) {
    // 409 rather than 500: nothing is broken, the deployment is simply not in a
    // state where a test can be sent, and the client can say which.
    return apiError(
      result.reason === 'unconfigured'
        ? 'This deployment has no VAPID keys configured.'
        : 'No device is subscribed to notifications yet.',
      409,
    );
  }
  return json(result.outcome);
}

/**
 * The push service's URL for one device.
 *
 * Only the scheme is checked, and only for `https:`. Which hosts are legitimate
 * push services is not something this app can enumerate — Apple, Google,
 * Mozilla and every fork of Chromium have their own — and a hostname allowlist
 * would break the first time one of them added a region. What matters is that
 * the value is a URL the Worker will later `fetch`, so a `file:` or `http:`
 * endpoint is refused here rather than attempted.
 */
function requiredEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest('endpoint is required');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequest('endpoint must be a URL');
  }
  if (url.protocol !== 'https:') throw new BadRequest('endpoint must be an https URL');
  return value;
}

/**
 * A base64url key of an exact byte length.
 *
 * Checked here rather than at send time on purpose. Key material of the wrong
 * length fails inside WebCrypto with a message about neither the field nor the
 * device, at 8:00 AM, in a cron log — whereas a 400 at subscribe time names the
 * field while the browser that produced it is still on screen.
 */
function requiredKeyMaterial(value: unknown, label: string, bytes: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`keys.${label} is required`);
  }
  let decoded: Uint8Array;
  try {
    decoded = fromBase64Url(value);
  } catch {
    throw new BadRequest(`keys.${label} must be base64url`);
  }
  if (decoded.length !== bytes) {
    throw new BadRequest(`keys.${label} must decode to ${bytes} bytes`);
  }
  return value;
}

function optionalUserAgent(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value.trim().slice(0, MAX_USER_AGENT);
}

/** Returns null when the path is not a push path, so the router falls through. */
export function handlePush(request: Request, env: Env, pathname: string): Promise<Response> | null {
  if (pathname === '/api/push') {
    switch (request.method) {
      case 'GET':
        return status(env);
      case 'POST':
        return subscribe(request, env);
      case 'DELETE':
        return unsubscribe(request, env);
      default:
        return Promise.resolve(apiError('Method not allowed', 405));
    }
  }

  if (pathname === '/api/push/test') {
    if (request.method !== 'POST') return Promise.resolve(apiError('Method not allowed', 405));
    return test(env);
  }

  return null;
}
