/**
 * The scheduled job, and the fan-out to every subscribed device.
 *
 * This file is deliberately thin. *What* to send and *when* is
 * `shared/notifications.ts`, which is pure and heavily tested; *how* to send it
 * is `worker/push/`. What is left here is the database work between them, and
 * the error posture — which is the part that needs stating.
 *
 * **Nothing in here may throw into the cron.** A scheduled handler that
 * rejects is retried by the platform, and a retry that re-sends the same
 * notification would be worse than the failure it was retrying. The sent
 * ledger makes a re-send impossible anyway, but the belt-and-braces is that
 * every failure is logged and swallowed.
 *
 * **The ledger is written before the push, not after.** A key recorded for a
 * message that then failed to send means one missed notification. A key
 * recorded only on success means a Worker that dies mid-flight sends the same
 * push again on the next tick — and a phone that buzzes twice about the same
 * task is the failure the user actually notices. Missing beats duplicating.
 */

import { planNotifications, type PushMessage } from '../shared/notifications';
import type { Env } from './db';
import {
  deletePushSubscription,
  pruneSentKeys,
  recordPushFailure,
  recordPushSuccess,
  recordSentKey,
  selectBoards,
  selectPushSubscriptions,
  selectSentKeys,
  selectSettings,
  selectTasks,
  type PushSubscriptionRecord,
} from './db';
import { fromBase64Url } from './push/base64';
import { sendPush } from './push/send';
import { vapidKeysFrom, type VapidKeys } from './push/vapid';

/** What one tick did, for the log line and for the test endpoint. */
export interface NotifyOutcome {
  planned: number;
  sent: number;
  failed: number;
  /** Subscriptions the push service reported as gone, and which were deleted. */
  pruned: number;
}

const NOTHING: NotifyOutcome = { planned: 0, sent: 0, failed: 0, pruned: 0 };

/**
 * One tick of the cron. Runs every minute; almost every run does nothing.
 *
 * The order matters: settings first, because `notificationsEnabled` short-
 * circuits everything and there is no reason to read every board and task 1,440
 * times a day for a feature that is turned off.
 */
export async function runScheduledNotifications(env: Env): Promise<NotifyOutcome> {
  const now = Date.now();

  const settings = await selectSettings(env.DB);
  if (!settings.notificationsEnabled) return NOTHING;

  const vapid = vapidKeysFrom(env);
  if (!vapid) {
    // Enabled in settings but never configured on the server. Worth a log line
    // — it is the difference between "no notifications arrived" and "no
    // notifications were attempted", and only one of those is fixable by
    // tapping something in the app.
    console.warn('notifications enabled but VAPID secrets are not configured');
    return NOTHING;
  }

  const [boards, tasks, sentKeys] = await Promise.all([
    selectBoards(env.DB),
    selectTasks(env.DB),
    selectSentKeys(env.DB, now),
  ]);

  const messages = planNotifications({ now, settings, boards, tasks, sentKeys });
  if (messages.length === 0) {
    // Housekeeping rides on an otherwise idle tick rather than getting a cron
    // of its own. Once an hour is plenty for a table this small.
    if (new Date(now).getUTCMinutes() === 7) await swallow(pruneSentKeys(env.DB, now));
    return NOTHING;
  }

  const subscriptions = await selectPushSubscriptions(env.DB);
  if (subscriptions.length === 0) {
    // Nothing to send to. The keys are deliberately *not* recorded: the user
    // has notifications on and simply has not granted permission on a device
    // yet, and burning today's digest key would mean that when they do grant
    // it, tomorrow is the earliest they could hear anything.
    return { ...NOTHING, planned: messages.length };
  }

  let sent = 0;
  let failed = 0;
  let pruned = 0;

  for (const message of messages) {
    await swallow(recordSentKey(env.DB, message.key, now));
    const result = await deliver(env, subscriptions, message, vapid);
    sent += result.sent;
    failed += result.failed;
    pruned += result.pruned;
  }

  console.log('notifications sent', {
    planned: messages.length,
    sent,
    failed,
    pruned,
    kinds: messages.map((message) => message.kind),
  });

  return { planned: messages.length, sent, failed, pruned };
}

/**
 * One message to every device.
 *
 * Sequential rather than `Promise.all`: this is at most a handful of
 * subscriptions for one user, the ordering makes the log readable, and a burst
 * of parallel requests to a push service is the shape that gets rate limited.
 */
async function deliver(
  env: Env,
  subscriptions: readonly PushSubscriptionRecord[],
  message: PushMessage,
  vapid: VapidKeys,
): Promise<{ sent: number; failed: number; pruned: number }> {
  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    url: message.url,
    tag: message.tag,
  });

  let sent = 0;
  let failed = 0;
  let pruned = 0;

  for (const subscription of subscriptions) {
    const result = await sendPush(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: fromBase64Url(subscription.p256dh),
          auth: fromBase64Url(subscription.auth),
        },
      },
      payload,
      vapid,
    );

    if (result.status === 'sent') {
      sent += 1;
      await swallow(recordPushSuccess(env.DB, subscription.endpoint));
      continue;
    }

    if (result.status === 'expired') {
      // 404/410 is the push service saying this device is never coming back.
      // Keeping the row would mean failing against it on every tick forever.
      pruned += 1;
      console.log('pruned an expired push subscription', {
        code: result.code,
        endpoint: origin(subscription.endpoint),
      });
      await swallow(deletePushSubscription(env.DB, subscription.endpoint));
      continue;
    }

    failed += 1;
    console.error('push delivery failed', {
      code: result.code,
      detail: result.detail,
      endpoint: origin(subscription.endpoint),
    });
    await swallow(recordPushFailure(env.DB, subscription.endpoint));
  }

  return { sent, failed, pruned };
}

/**
 * Send one message right now, to every device, bypassing the plan.
 *
 * Only the settings sheet's "Send a test notification" uses this. It exists
 * because every part of this feature is invisible until it works — permission,
 * subscription, VAPID secrets, the service worker, the phone's own notification
 * settings — and a button that either buzzes the phone or says exactly which
 * layer refused is worth more than all of the documentation.
 */
export async function sendTestNotification(env: Env): Promise<
  { ok: true; outcome: NotifyOutcome } | { ok: false; reason: 'unconfigured' | 'no-subscriptions' }
> {
  const vapid = vapidKeysFrom(env);
  if (!vapid) return { ok: false, reason: 'unconfigured' };

  const subscriptions = await selectPushSubscriptions(env.DB);
  if (subscriptions.length === 0) return { ok: false, reason: 'no-subscriptions' };

  const message: PushMessage = {
    kind: 'digest',
    key: `test:${Date.now()}`,
    title: 'Cairn notifications are working',
    body: 'This is a test. Your morning digest and due reminders will arrive here.',
    url: '/',
    // Its own tag, so a test never replaces a real digest sitting unread.
    tag: 'cairn-test',
  };

  const result = await deliver(env, subscriptions, message, vapid);
  // Not written to the ledger: a test is not a notification about anything, and
  // a key for it would only ever suppress another test.
  return { ok: true, outcome: { planned: 1, ...result } };
}

/** The endpoint's origin. The path is a bearer credential and is never logged. */
function origin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'unknown';
  }
}

/** Run a write, and let a failed one be a log line rather than a thrown tick. */
async function swallow(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch (error) {
    console.error('notification bookkeeping write failed', {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}
