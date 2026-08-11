/**
 * Delivering one message to one subscription.
 *
 * The two hard parts live next door — `encrypt.ts` makes the body, `vapid.ts`
 * makes the authorization — so what is left here is the HTTP call and, more
 * importantly, what its status code *means*.
 *
 * A push service returning 201 means it accepted the message for delivery. It
 * does not mean the phone got it, and there is no callback that would say so.
 * That is the model: fire-and-forget, with the only real feedback being 404 and
 * 410, which say the subscription is dead — the browser dropped it, the app was
 * removed from the home screen, or the user cleared site data. Those are the
 * codes that must prune, because a subscription that is gone stays gone, and a
 * retry loop against it runs forever.
 */

import { utf8 } from './base64';
import { encryptPayload, type SubscriptionKeys } from './encrypt';
import { vapidAuthorization, type VapidKeys } from './vapid';

export interface PushTarget {
  endpoint: string;
  keys: SubscriptionKeys;
}

export type PushResult =
  /** Accepted for delivery. */
  | { status: 'sent' }
  /** The subscription is gone. Delete it; it will never work again. */
  | { status: 'expired'; code: number }
  /** Something else went wrong — a bad gateway, a rate limit, a network drop. */
  | { status: 'failed'; code: number | null; detail: string };

/** How long the push service should hold the message for a device that is off. */
const TTL_SECONDS = 24 * 60 * 60;

export async function sendPush(
  target: PushTarget,
  payload: string,
  keys: VapidKeys,
): Promise<PushResult> {
  let body: Uint8Array;
  let authorization: string;
  try {
    body = await encryptPayload(utf8(payload), target.keys);
    authorization = await vapidAuthorization(target.endpoint, keys);
  } catch (error) {
    // Malformed key material — a corrupt stored subscription, or VAPID secrets
    // that were pasted wrong. Neither is retryable and neither should take the
    // rest of the batch down with it.
    return { status: 'failed', code: null, detail: describe(error) };
  }

  let response: Response;
  try {
    response = await fetch(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
        // Apple's push service requires a topic to be short and opaque; the
        // collapse behaviour the app actually wants is the notification `tag`,
        // handled in the service worker, so nothing is set here.
        Urgency: 'normal',
      },
      body: body.slice().buffer as ArrayBuffer,
    });
  } catch (error) {
    return { status: 'failed', code: null, detail: describe(error) };
  }

  if (response.status === 404 || response.status === 410) {
    return { status: 'expired', code: response.status };
  }
  if (!response.ok) {
    // The body is where a push service explains itself — "VAPID credentials
    // mismatch", "payload too large" — and without it a 400 here is undebuggable.
    return { status: 'failed', code: response.status, detail: await safeText(response) };
  }
  return { status: 'sent' };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
