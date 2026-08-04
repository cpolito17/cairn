# Deploy

## State

| Thing | Status |
|---|---|
| D1 database `cairn` | Created — `a05a3c87-c16b-458e-87f8-9c117a28312e`, primary region ENAM |
| `0001_init.sql` on the remote DB | Applied, and recorded in `d1_migrations` |
| `0002_task_dependencies.sql` on the remote DB | **Verify before trusting** — see "Later migrations". Shipping the code without it takes the app down. |
| `database_id` in `wrangler.toml` | Wired to the real ID |
| Worker deployed | **Not yet** — needs an authenticated `wrangler` |
| `tasks.charliepolito.com` attached | **Not yet** — happens on the first deploy |
| Password secret | **Not yet** — see `PASSWORD-SETUP.md`, needed before issue 2 |

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
