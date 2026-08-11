# Push notifications

Cairn can push two kinds of notification to a phone or a laptop:

- **A morning summary**, once a day at a start-of-day time you choose, listing
  what is due today and what is already overdue. Two times: one for Mon–Fri, one
  for Sat–Sun.
- **A due reminder**, for any task that has both a due date and a due *time*,
  fired a configurable number of minutes ahead of it.

Both span Personal and Work — the phone in your pocket is not a context — and
both are governed by one set of settings shared across the two.

Tapping either opens the app. The summary opens the home screen; a due reminder
opens that task's board with the task highlighted.

---

## What this is built on

**Web Push (RFC 8030/8291/8292) with VAPID.** No third-party service, no
account, no API key beyond a key pair you generate yourself, and no cost. The
browser holds a subscription with Apple's, Google's or Mozilla's push service;
the Worker encrypts each message so that only your device can read it and hands
it to that service to deliver.

Three consequences worth knowing up front:

1. **On iOS, the app must be installed to the home screen.** Safari proper has
   no Push API; a home-screen web app does (iOS 16.4+). The settings sheet says
   so rather than showing a toggle that will not stay on.
2. **Permission is a one-shot prompt.** If it is denied, no amount of tapping in
   Cairn can re-ask — it has to be undone in iOS Settings or the browser's site
   settings.
3. **A subscription belongs to a device, not to your account.** Turning
   notifications on from your laptop does not subscribe your phone. Open
   Settings on the phone and it offers "Turn on for this device".

---

## Setting it up

### 1. Generate a VAPID key pair

```sh
npm run vapid
```

This prints a public key, a private key, and the three commands to install them.
The private key is shown once and is written nowhere.

### 2. Install them as Worker secrets

```sh
echo "<public key>"          | npx wrangler secret put VAPID_PUBLIC_KEY
echo "<private key>"         | npx wrangler secret put VAPID_PRIVATE_KEY
echo "mailto:you@example.com" | npx wrangler secret put VAPID_SUBJECT
```

`VAPID_SUBJECT` is a contact address push services use to reach the operator if
something goes wrong. Any `mailto:` or `https:` URL is valid.

### 3. Apply the migration and deploy

```sh
npm run deploy
```

which runs the build, applies `migrations/0006_push_notifications.sql` to the
remote database, and deploys the Worker along with its cron trigger. Per
`docs/DEPLOY.md`, the migration must reach the database before the Worker that
depends on it — `npm run deploy` already orders it that way.

### 4. Turn it on, on the device you want notified

On the phone: open the app **from the home screen** (not in Safari), open
Settings, and turn on **Push notifications**. Grant the permission prompt. Then:

- set **Start of day** for Mon–Fri and Sat–Sun;
- set the **reminder lead** for timed tasks, or Never;
- check the **time zone** — it is picked, never detected, and the sheet offers
  your device's zone in one tap;
- press **Send a test notification**. Your phone should buzz within a second or
  two.

If the test does not arrive, the toast says which layer refused.

---

## How the schedule actually runs

A Cloudflare cron trigger fires the Worker **every minute**. Almost every tick
reads one settings row, sees that nothing is due, and returns.

Every minute rather than something coarser because the due-reminder lead is an
offset from an arbitrary due time: a task due 1:33 PM with a five-minute lead
needs 1:28, which no coarser schedule lands on.

**Cron fires in UTC**, which is the entire reason a time zone is stored. Nothing
else in Cairn stores one — the Planner is local wall-clock throughout, per
`PROJECT-SPEC-V2.md` §2 — but "8:00 AM" is not an instant a UTC cron can compare
against without knowing where you are. `shared/timezone.ts` is the whole of that
reconciliation, and it uses the platform's tzdata, so daylight saving is handled
including the skipped and repeated hours.

### Not sending twice

Every notification carries a key naming what it is about — `digest:2026-08-11`,
`due:<taskId>:2026-08-11T13:30` — and sent keys are recorded in
`notification_log`. A tick that computes the same due reminder for fifteen
consecutive minutes sends it once.

The key is written **before** the push, not after. A key recorded for a message
that then failed means one missed notification; a key recorded only on success
means a Worker that dies mid-flight re-sends on the next tick. A phone that
buzzes twice about the same task is the failure you would actually notice.

### Catching up, but not haunting you

A missed tick — a deploy, a cold start — still sends: a summary is allowed up to
an hour late, a due reminder up to fifteen minutes. Past that they are dropped.
Turning notifications on at 3:00 PM does not fire the morning's summary at you,
and a reminder for a 1:30 meeting does not arrive at 2:15.

A summary with nothing due and nothing overdue is **not sent at all**.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| "Add Cairn to your home screen…" | iOS Safari has no Push API. Share sheet → Add to Home Screen, then turn it on from the installed app. |
| "Notifications are blocked for this site." | Permission was denied at some point. iOS: Settings → Notifications → Cairn. Desktop: the site settings in the address bar. |
| "This deployment has no notification keys configured yet." | The VAPID secrets are not set. Steps 1–3 above. |
| Toggle is on, nothing arrives | Check Settings on *that device* — it may say "Turn on for this device". Then press Send a test notification. |
| Test says it couldn't be delivered | The push service rejected every subscription. `npx wrangler tail` shows the status code and the service's own explanation. |

Expired subscriptions prune themselves: a push service answering 404 or 410
means that device is gone for good, and the row is deleted rather than retried
forever.

### Rotating the keys

Replacing the VAPID key pair **invalidates every existing subscription** — the
browser pinned the old public key when it subscribed. After rotating, every
device must turn notifications off and on again.

### Watching it run

```sh
npx wrangler tail
```

Successful sends log `notifications sent` with counts and kinds. Failures log
the push service's status and message. Endpoint paths are never logged: an
endpoint is a bearer credential for pushing to that device.

---

## What is deliberately not here

- **No email, SMS, or Discord fallback.** Web Push covers the stated need with
  no third party and no account; a second delivery path would be a second
  content pipeline to keep in step for no additional reach.
- **No per-context notification settings.** One phone, one set of alerts.
- **No reminder for a Planner block that is about to start.** Due dates are
  commitments; a scheduled block is a plan, and `PROJECT-SPEC-V2.md` §11 rejects
  nudging about one.
- **No offline caching.** `public/sw.js` has no `fetch` handler at all, on
  purpose — a service worker that started serving cached responses would be the
  first half of the offline-first architecture `PROJECT-SPEC.md` §3 rejects.
- **No quiet hours, no snooze, no per-board mute.** Nothing yet demands them.
