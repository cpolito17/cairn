/**
 * The service worker. Notifications only.
 *
 * This deliberately does **not** cache anything. `PROJECT-SPEC.md` §3 rejects
 * offline-first outright — a local write log and conflict resolution is the
 * single largest complexity multiplier available in this project — and a
 * service worker that started intercepting `fetch` would be the first half of
 * exactly that, delivered by accident. There is no `fetch` handler here, so the
 * network behaves precisely as it does without a service worker registered.
 *
 * It exists because Web Push has no other delivery point: a push arrives at the
 * service worker whether or not the app is open, and only a service worker may
 * call `showNotification`. On iOS the app must additionally be installed to the
 * home screen for any of this to run at all.
 *
 * Plain JavaScript, served straight from `public/`, because it must sit at the
 * origin root to claim the whole scope, and because there is nothing here worth
 * a build step.
 */

// A new worker takes over immediately rather than waiting for every tab to
// close. Notification handling is self-contained — there is no cached asset an
// old client could be mid-way through — so the usual reason to wait does not
// apply, and the alternative is a phone still running last month's handler.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * A push arrived.
 *
 * The payload is the JSON the Worker encrypted (`worker/notify.ts`). A
 * notification **must** be shown: every browser treats a push that resolves
 * without one as a violation, and repeated silent pushes get the subscription
 * revoked. So a payload that cannot be parsed still ends in a notification — a
 * vague one is survivable, a silent one is not.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'Cairn';
  const options = {
    body: payload.body || '',
    // Same tag replaces rather than stacks: a re-sent digest updates the one
    // sitting in the shade instead of adding a second copy.
    tag: payload.tag || 'cairn',
    // ...but a replacement still buzzes, because a silently-updated
    // notification for a task that is now due would be worse than none.
    renotify: true,
    icon: '/brand/tasks.png',
    badge: '/brand/tasks.png',
    // Where a tap goes. Read back in `notificationclick`, which is a separate
    // event with no access to this scope.
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * The notification was tapped.
 *
 * Focus the app if it is already open, rather than opening a second copy of a
 * single-page app — and navigate the focused window to where the notification
 * points, so tapping a due reminder lands on that task's board even when the
 * app was sitting on the Planner.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin,
  );

  event.waitUntil(
    (async () => {
      // `includeUncontrolled` matters: on iOS the home-screen window may not be
      // controlled by this worker yet after an update, and without it a tap
      // would open a second window beside the one already on screen.
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clients) {
        if (new URL(client.url).origin !== target.origin) continue;
        // Focus first. A `navigate` on a window that is not focused can be
        // refused, and a focused window on the wrong screen still beats a
        // second window.
        const focused = await client.focus();
        if ('navigate' in focused) {
          try {
            await focused.navigate(target.href);
          } catch {
            // Some browsers refuse `navigate` on a client they did not create.
            // The app is open and focused, which is most of what was wanted.
          }
        }
        return;
      }

      await self.clients.openWindow(target.href);
    })(),
  );
});
