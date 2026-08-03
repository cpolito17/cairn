# Deploy

Deployment is driven from the Cloudflare dashboard via **Workers Builds**, not
from a terminal. Cloudflare watches the GitHub repo, runs the build itself, and
deploys on every push to `main`. Nothing here requires a local Wrangler.

## State

| Thing | Status |
|---|---|
| D1 database `cairn` | Created — `a05a3c87-c16b-458e-87f8-9c117a28312e`, primary region ENAM |
| `0001_init.sql` on the remote DB | Applied, recorded in `d1_migrations` |
| `database_id` in `wrangler.toml` | Wired to the real ID |
| Worker deployed | **Not yet** — see below |
| `tasks.charliepolito.com` attached | **Not yet** — happens on the first deploy |
| `AUTH_PASSWORD` secret | **Not yet** — see `PASSWORD-SETUP.md` |

The remote schema was applied through the Cloudflare API rather than
`wrangler d1 migrations apply --remote`, so the `d1_migrations` row was written
by hand to match what Wrangler records. Wrangler treats `0001_init.sql` as
applied and will only run migrations added after it.

## Bindings come from `wrangler.toml`, not the dashboard

`wrangler.toml` is authoritative for the D1 binding, the assets binding, and the
custom domain. Every deploy re-applies it. **Do not add the `DB` binding through
the dashboard** — it is already declared, and dashboard-added bindings that are
absent from `wrangler.toml` are dropped on the next deploy.

Secrets are the exception: they are stored separately and survive deploys, which
is why `AUTH_PASSWORD` is set through the dashboard and not in this file.

## First deploy, from the dashboard

### 0. Check DNS first

A Custom Domain cannot be created on a hostname that already has a CNAME record.
In the dashboard, go to **`charliepolito.com` → DNS → Records** and confirm
nothing exists for `tasks`. If a record is there, delete it, or the deploy will
fail when it tries to attach the domain.

### 1. Merge the code to `main`

Workers Builds deploys the production branch, which defaults to `main`. Merge
the open PR first. Builds for other branches are off by default, so pushes to
feature branches will not deploy anything.

### 2. Import the repository

**Workers & Pages → Create application → Import a repository**, then authorize
the Cloudflare GitHub app for `cpolito17/cairn` and select it.

The Worker name must be exactly `cairn` — it has to match `name` in
`wrangler.toml` or the build fails.

Build settings:

| Field | Value |
|---|---|
| Git branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | *(leave empty)* |

Do **not** set the deploy command to `npm run deploy` — that script is
`npm run build && wrangler deploy`, so it would build a second time.

Node comes from `.nvmrc` (pinned to 22). Vite 7 needs Node 20.19+, so leave that
file in place.

### 3. Deploy and verify

Save and deploy, then watch the build log in **Settings → Build**. When it
finishes:

- `https://tasks.charliepolito.com` serves the placeholder wordmark
- `https://tasks.charliepolito.com/api/anything` returns `{"error":"Not found"}` with a 404
- `https://tasks.charliepolito.com/some/unknown/route` serves the SPA shell

If the custom domain did not attach, add it manually: **the Worker → Settings →
Domains & Routes → Add → Custom Domain**, enter `tasks.charliepolito.com`.
Cloudflare creates the DNS record and certificate itself.

Note that this first deploy is publicly reachable and has no login, because auth
does not exist until issue 2. There is nothing behind it — D1 is empty and the
API answers 404 to everything.

## Subsequent deploys

Merge to `main`. Cloudflare rebuilds and redeploys. There is no manual step.

## Later migrations

New migrations need to reach the remote database. Without a terminal, use
**Workers & Pages → D1 SQL Database → cairn → Console** and paste the migration
SQL, then insert its bookkeeping row so Wrangler stays in sync:

```sql
INSERT INTO d1_migrations (name) VALUES ('000N_whatever.sql');
```

## Verifying the remote database

**Workers & Pages → D1 SQL Database → cairn → Console**:

```sql
SELECT name FROM sqlite_master WHERE type='table';
```

Expect `boards`, `tasks`, `sessions`, `login_attempts`, `d1_migrations`, and
D1's internal `_cf_KV`.
