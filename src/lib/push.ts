/**
 * Push notifications, from the browser's side.
 *
 * Turning notifications on is four separate things that all have to succeed,
 * and any of them can refuse:
 *
 *   1. the browser supports Push at all — on iOS, only when the app has been
 *      added to the home screen;
 *   2. the user grants notification permission, which is a one-shot prompt: a
 *      denial cannot be re-asked from script, only undone in browser settings;
 *   3. the service worker registers;
 *   4. the subscription reaches the server, which needs VAPID keys configured
 *      or it has nothing to send with.
 *
 * The reason this module reports a *reason* rather than a boolean is that all
 * four failures look identical from the settings sheet — a toggle that will not
 * stay on — and only one of them is something the user can act on. Guessing
 * which is which is exactly the thing that makes a notification feature feel
 * broken.
 *
 * **The subscription belongs to this browser, not to the account.** The phone
 * and the laptop each hold their own, and asking the server "am I subscribed"
 * would answer for some other device. So state is read from the service worker
 * registration every time, and the server is only told about changes.
 */

import * as api from './api';

/** Why notifications cannot be turned on here. Null means they can. */
export type PushBlocker =
  /** No Push API — an old browser, or iOS Safari outside a home-screen app. */
  | 'unsupported'
  /** iOS specifically: supported, but only once the app is on the home screen. */
  | 'needs-install'
  /** The user said no. Only reversible in browser settings, not from here. */
  | 'denied'
  /** The deployment has no VAPID keys, so nothing could be sent anyway. */
  | 'unconfigured'
  /** The demo has no server to subscribe against. */
  | 'demo';

export interface PushState {
  /** True when this browser currently holds a subscription. */
  subscribed: boolean;
  /** The browser's permission, or 'default' where there is no Notification API. */
  permission: NotificationPermission;
  /** What stands in the way, or null when nothing does. */
  blocker: PushBlocker | null;
  /** Devices the server currently knows about, across all browsers. */
  devices: number;
}

const SERVICE_WORKER_URL = '/sw.js';

/** True when this browser has the APIs Web Push needs. */
export function supportsPush(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * True when the app is running as an installed app rather than a browser tab.
 *
 * The distinction only matters on iOS, where Web Push is unavailable in Safari
 * proper and available in a home-screen app — which is why "add it to your home
 * screen" is a real instruction here and not a suggestion.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  // The non-standard iOS flag, which predates `display-mode` and is still what
  // older iOS versions report.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** True for iOS or iPadOS, where installation is a precondition. */
function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** The current state of push on this device. Never throws. */
export async function readPushState(): Promise<PushState> {
  const idle: PushState = {
    subscribed: false,
    permission: 'default',
    blocker: null,
    devices: 0,
  };

  if (api.isDemoMode()) return { ...idle, blocker: 'demo' };

  if (!supportsPush()) {
    // On iOS the API genuinely is absent until the app is installed, so the
    // honest message is "add it to your home screen", not "your browser cannot
    // do this" — which would be false and would stop the user trying.
    return { ...idle, blocker: isApple() && !isStandalone() ? 'needs-install' : 'unsupported' };
  }

  const permission = Notification.permission;

  let status: api.PushStatus;
  try {
    status = await api.getPushStatus();
  } catch {
    // The server is unreachable or the session lapsed. Report what this device
    // knows and let the caller's own error handling speak — a blocker here
    // would claim a permanent problem for what is probably a dropped request.
    return { ...idle, permission, subscribed: await hasLocalSubscription() };
  }

  return {
    subscribed: await hasLocalSubscription(),
    permission,
    blocker: !status.configured ? 'unconfigured' : permission === 'denied' ? 'denied' : null,
    devices: status.devices,
  };
}

/**
 * The registration covering this page, or null.
 *
 * `getRegistration` takes a *client* URL, not a script URL — passing `/sw.js`
 * asks "what controls the document at /sw.js", which happens to give the right
 * answer at scope `/` and is the wrong question. The no-argument form asks
 * about the current page, which is what every caller here actually means.
 */
function currentRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration();
}

async function hasLocalSubscription(): Promise<boolean> {
  try {
    const registration = await currentRegistration();
    if (!registration) return false;
    return (await registration.pushManager.getSubscription()) !== null;
  } catch {
    return false;
  }
}

/** Thrown by `enablePush` when a step refuses, carrying which one. */
export class PushError extends Error {
  readonly blocker: PushBlocker | 'failed';

  constructor(blocker: PushBlocker | 'failed', message: string) {
    super(message);
    this.name = 'PushError';
    this.blocker = blocker;
  }
}

/**
 * Subscribe this browser, end to end.
 *
 * Ordered so the irreversible step comes as late as it can: the server is asked
 * for its key *before* the permission prompt, because a deployment with no
 * VAPID keys can be reported as a configuration problem, while a permission
 * prompt spent on a server that cannot send anything is a prompt that cannot be
 * asked again.
 */
export async function enablePush(): Promise<void> {
  if (api.isDemoMode()) throw new PushError('demo', 'Notifications are not part of the demo.');
  if (!supportsPush()) {
    throw new PushError(
      isApple() && !isStandalone() ? 'needs-install' : 'unsupported',
      'This browser cannot receive push notifications.',
    );
  }

  const status = await api.getPushStatus();
  if (!status.configured || !status.publicKey) {
    throw new PushError('unconfigured', 'This deployment has no notification keys configured.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushError('denied', 'Notification permission was not granted.');
  }

  await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
  // `register` resolves before the worker is usable, and subscribing against a
  // registration that is still installing fails intermittently — the worst way
  // for this to fail, because it works every time you test it. `ready` resolves
  // to the *active* registration for this page, so it is both the wait and the
  // thing to subscribe against.
  const registration = await navigator.serviceWorker.ready;

  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Required, and required to be true: a subscription that could push
      // silently is refused by every browser that implements the flag.
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(status.publicKey),
    }));

  await api.savePushSubscription(toWire(subscription));
}

/**
 * Unsubscribe this browser.
 *
 * Both halves run, and the server half runs even if the browser half throws:
 * leaving a stale endpoint on the server means pushing at a device that is no
 * longer listening, which is invisible until it is a mystery.
 */
export async function disablePush(): Promise<void> {
  if (!supportsPush()) return;

  const registration = await currentRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  try {
    await subscription.unsubscribe();
  } finally {
    await api.deletePushSubscription(endpoint);
  }
}

/**
 * Re-register this browser's existing subscription with the server.
 *
 * Push services rotate endpoints, and a browser can replace a subscription
 * without telling the page. Re-sending what the browser currently holds on each
 * cold load is a single cheap write that keeps the server's copy from quietly
 * going stale — the failure mode being a phone that stops receiving anything
 * and shows nothing wrong.
 */
export async function refreshSubscription(): Promise<void> {
  if (api.isDemoMode() || !supportsPush()) return;
  if (Notification.permission !== 'granted') return;

  try {
    const registration = await currentRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await api.savePushSubscription(toWire(subscription));
  } catch {
    // Best effort by design. This runs on load, and nothing about it is worth
    // a toast on a screen the user did not open for notifications.
  }
}

/** A `PushSubscription` in the shape `POST /api/push` accepts. */
function toWire(subscription: PushSubscription): api.PushSubscriptionBody {
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (!keys.p256dh || !keys.auth) {
    throw new PushError('failed', 'The browser returned a subscription with no keys.');
  }
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    userAgent: navigator.userAgent,
  };
}

/**
 * base64url to bytes, for the application server key.
 *
 * `applicationServerKey` takes raw bytes and the server states its key in
 * base64url, so somebody has to do this. It is four lines and it is the only
 * thing this file needs from the encoding.
 */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
  // The buffer is allocated explicitly so the result is a `Uint8Array<ArrayBuffer>`
  // rather than the `ArrayBufferLike` the bare constructor infers — the latter
  // could in principle be a `SharedArrayBuffer`, which `applicationServerKey`
  // will not accept.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
