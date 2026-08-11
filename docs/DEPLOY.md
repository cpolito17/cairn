# Deploy

## State

| Thing | Status |
|---|---|
| D1 database `cairn` | Created — `a05a3c87-c16b-458e-87f8-9c117a28312e`, primary region ENAM |
| `0001_init.sql` on the remote DB | Applied, and recorded in `d1_migrations` |
| `0002_task_dependencies.sql` on the remote DB | **Verify before trusting** — see "Later migrations". Shipping the code without it takes the app down. |
| `0003_planner.sql` on the remote DB | **Not yet.** One-way and destructive — see below. Must be applied *before* the V2 Worker is deployed |
| `database_id` in `wrangler.toml` | Wired to the real ID |
| Worker deployed | **Not yet** — needs an authenticated `wrangler` |
| `tasks.charliepolito.com` attached | **Not yet** — happens on the first deploy |
| Password secret | **Not yet** — see `PASSWORD-SETUP.md`, needed before issue 2 |
| `0006_push_notifications.sql` on the remote DB | **Not yet.** Additive and safe — two new tables, nothing altered. Deploying without it makes every notification path fail on `no such table`, and nothing else |
| VAPID secrets | **Not yet** — see `NOTIFICATIONS.md`. Their absence is handled: the app runs with notifications simply unavailable |
| `0007_multiple_dependencies.sql` on the remote DB | **Not yet.** One-way and destructive — it drops `tasks.depends_on`. Back up first, and migrate *before* deploying, exactly as `0003` requires |

The remote schema was applied through the Cloudflare API rather than
`wrangler d1 migrations apply --remote`, so the `d1_migrations` bookkeeping row
was written by hand to match what Wrangler would have recorded. Wrangler now
treats `0001_init.sql` as applied and will only run migrations added later —
verify with `npx wrangler d1 migrations list cairn --remote` once you are
authenticated.

## First deploy

Requires Cloudflare credentials, which this repo does not carry.

```sh
npx wrangler login          # OAuth in a browser; or export CLOUDFLARE_API_TOKEN
npx wrangler whoami         # confirm the right account
npm run deploy              # builds the SPA, then wrangler deploy
```

`npm run deploy` is `npm run build && npm run migrate:remote && wrangler deploy`.
The order is load-bearing in both places: the build must run before the deploy,
because `[assets] directory = "./dist"` uploads whatever is on disk; and the
migration must run before the deploy, because new code cannot run against an
old schema. See "Later migrations".

On that first deploy Wrangler attaches `tasks.charliepolito.com` from the
`[[routes]]` block and provisions the DNS record for it itself. That is the
intended mechanism; do not add or edit the record by hand.

If the account has more than one Cloudflare account attached, set
`CLOUDFLARE_ACCOUNT_ID` or add `account_id` to `wrangler.toml`, or Wrangler
will stop and ask which one to use.

### If you use an API token instead of `wrangler login`

Scopes needed:

- Account · Workers Scripts · Edit
- Account · D1 · Edit
- Account · Account Settings · Read
- Zone · Workers Routes · Edit — on the `charliepolito.com` zone
- Zone · DNS · Edit — on the `charliepolito.com` zone, for the custom domain record

The "Edit Cloudflare Workers" template covers all but D1, which you add manually.

## Later migrations

> **This is the step that has already broken production once.** Read the whole
> section before adding a migration.

Add `migrations/000N_*.sql` and apply it to both databases:

```sh
npx wrangler d1 migrations apply cairn --local
npx wrangler d1 migrations apply cairn --remote   # ← the one that gets forgotten
```

### Why it broke, and what protects against it now

**Deploying code does not migrate the database.** Cloudflare Workers Builds
deploys on a push to `main` — it runs a build and `wrangler deploy`, and it
never runs `wrangler d1 migrations apply`. So merging a migration ships code
that expects a column the live database does not have.

That is exactly what happened with `0002_task_dependencies.sql`. The Worker
started selecting `depends_on`, D1 answered `no such column: depends_on`, and
every request to `GET /api/state` failed. Login still worked (its tables were
untouched), so the app signed you in and then refused to load anything, on
every device at once.

Three things now stand between that and a repeat:

1. **`npm run deploy` migrates first.** It is `build → migrate:remote →
   deploy`, in that order. Migrating before deploying is the safe direction:
   the old code tolerates a new column it does not select, while new code
   cannot tolerate a missing one. A failed migration aborts the deploy.
2. **Unhandled API errors are logged and returned as JSON.** `handleApi` wraps
   the whole request, so a schema mismatch produces a searchable
   `unhandled API error` line in observability and a `500 {"error":"internal
   error"}` the client can parse — instead of an uncaught throw, Cloudflare's
   HTML 500 page, and silence in the logs.
3. **The client stops blaming the network.** A load that fails with a server
   response now says so, rather than "the connection may have dropped."

**If you deploy through Workers Builds rather than `npm run deploy`**, point
its deploy command at the same sequence, or apply the migration by hand
*before* merging the PR that needs it:

```
npx wrangler d1 migrations apply cairn --remote && npx wrangler deploy
```

### Applying a migration from the Cloudflare dashboard

Sometimes there is no authenticated `wrangler` to hand. A migration can be
applied from **D1 → `cairn` → Console** instead, but it has to do *both* halves
of what `wrangler d1 migrations apply` does: run the SQL, **and** record the
migration in the `d1_migrations` table. Skipping the bookkeeping leaves the
database correct and Wrangler's view of it wrong — the next
`migrations apply --remote` will try to run the same file again and fail on
`duplicate column name`.

Check what is actually there first:

```sql
SELECT name FROM d1_migrations ORDER BY id;
PRAGMA table_info(tasks);
```

Then run the migration's SQL followed by its bookkeeping row, using the
migration's **exact filename**:

```sql
ALTER TABLE tasks ADD COLUMN depends_on TEXT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_depends_on ON tasks(depends_on);
INSERT INTO d1_migrations (name) VALUES ('0002_task_dependencies.sql');
```

`id` and `applied_at` are defaulted by the table, so the name is the only value
to supply. This sequence has been verified against a local database to leave it
in the same state the CLI produces: `wrangler d1 migrations list` then reports
nothing pending, and a later `apply` is a no-op.

If the column already exists but the `d1_migrations` row is missing — someone
ran the ALTER by hand before — run the `INSERT` alone.

### `0003_planner.sql` is one-way

The V2 migration converts `tasks.duration` from a string enum to
`duration_minutes` and then **drops the column**. There is no down migration and
the old strings are not recoverable from the new integers: `4h` and `half-day`
both become 240, deliberately (V2 §2), so the mapping is not reversible even in
principle.

Two consequences for the deploy:

- **Take a backup first** — `npx wrangler d1 export cairn --remote --output
  cairn-pre-0003.sql` — because "revert the deploy" is not a way back from this
  one.
- **Migrate before deploying, not after.** The rule the rest of this document
  argues for is load-bearing here in both directions: the V2 Worker selects
  `duration_minutes`, which the unmigrated database does not have, and the v1
  Worker selects `duration`, which the migrated one no longer has. The window
  where one of them is broken is however long the two steps are apart, so run
  them as one command (`npm run deploy` already does).

The conversion has been verified against a local database seeded with a row of
every old value — `15m`, `30m`, `1h`, `2h`, `4h`, `half-day`, and NULL — which
migrated to `15, 30, 60, 120, 240, 240, NULL` respectively.

### `0006_push_notifications.sql` and the cron trigger

Additive: two new tables (`push_subscriptions`, `notification_log`) and no
change to an existing one. Unlike `0003`, the old Worker tolerates it
completely, so the usual "migrate first" ordering is a formality rather than a
cliff — but `npm run deploy` does it anyway.

The same deploy also registers the `[triggers] crons` entry from
`wrangler.toml`, which is what runs the notification tick. Confirm it after the
first deploy:

```sh
npx wrangler deployments list          # the cron appears in the deployment
npx wrangler tail                      # ticks log only when something is sent
```

A quiet tail is the expected state: the tick returns immediately whenever
notifications are off or nothing is due, and logs only on an actual send.

Setup for the notification feature itself — VAPID keys, permissions, the
iOS home-screen requirement — is in `NOTIFICATIONS.md`.

### `0007_multiple_dependencies.sql` is one-way

It moves task dependencies into a `task_dependencies` join table and then
**drops `tasks.depends_on`**. There is no down migration and there cannot be a
general one: a task with three prerequisites has no single value to put back.

- **Take a backup first** — `npx wrangler d1 export cairn --remote --output
  cairn-pre-0007.sql`.
- **Migrate before deploying.** The new Worker reads `task_dependencies`, which
  the unmigrated database does not have, and the old Worker selects
  `depends_on`, which the migrated one no longer has. `npm run deploy` already
  runs them as one command, in the right order.

Two details verified against a database built from 0001–0006:

- The `DROP INDEX idx_tasks_depends_on` before the `ALTER TABLE ... DROP COLUMN`
  is **not optional**. SQLite refuses to drop a column an index still names, with
  `error in index idx_tasks_depends_on after drop column`.
- The backfill skips self-links and links to tasks that no longer exist, so a
  bad row cannot be carried into a schema whose whole point is that the graph is
  acyclic.

Cascade behaviour was checked in both directions: deleting a prerequisite drops
the links pointing at it and leaves its dependents alive and released, and
deleting a dependent removes the links it owned.

### Checking what the live database actually has

```sh
npx wrangler d1 migrations list cairn --remote            # unapplied migrations
npx wrangler d1 execute cairn --remote \
  --command "PRAGMA table_info(tasks)"                    # the live columns
```

## Verifying the remote database

```sh
npx wrangler d1 execute cairn --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Expect `boards`, `tasks`, `sessions`, `login_attempts`, `d1_migrations`, and
D1's internal `_cf_KV`.
