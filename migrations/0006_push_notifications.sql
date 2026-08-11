-- Push notifications.
--
-- Two tables, both owned entirely by the Worker: neither is ever returned by
-- `GET /api/state`, because neither describes anything the client renders. The
-- client knows whether *this browser* is subscribed by asking its own service
-- worker, which is a more honest answer than a row on a server could give.

-- 1. Subscriptions.
--
-- One row per browser that has granted permission — a phone, a laptop, the same
-- phone again after site data was cleared. The endpoint is the push service's
-- URL for that device and is effectively a bearer credential, which is why it
-- is the natural primary key: re-subscribing the same browser produces the same
-- endpoint, and an upsert on it is what keeps a re-grant from doubling the row.
--
-- `p256dh` and `auth` are the browser's own key material (RFC 8291), stored
-- base64url exactly as the subscription reported them. They are what make the
-- payload readable by this device and no other.
CREATE TABLE push_subscriptions (
  endpoint        TEXT PRIMARY KEY,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  -- Purely so the settings sheet can say "iPhone" rather than "a device".
  user_agent      TEXT,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  -- Consecutive failures. Reset by a success; a run of them is how a
  -- subscription that is broken without ever returning 410 gets noticed.
  failure_count   INTEGER NOT NULL DEFAULT 0
);

-- 2. The sent ledger.
--
-- One row per notification actually delivered, keyed by what it was *about* —
-- `digest:2026-08-11`, `due:<taskId>:2026-08-11T13:30` — rather than by when it
-- was sent. That is what makes sending idempotent: the scheduled job runs every
-- minute and computes the same due notification for several consecutive ticks,
-- and the key is what stops the second and third from being pushed.
--
-- Keys are pruned after a fortnight. The window only has to outlive the
-- catch-up windows in `shared/notifications.ts`, which are measured in minutes;
-- two weeks is slack for an outage and still bounds the table.
CREATE TABLE notification_log (
  key     TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
);

CREATE INDEX notification_log_sent_at ON notification_log(sent_at);
