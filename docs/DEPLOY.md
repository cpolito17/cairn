# Deploy

## State

| Thing | Status |
|---|---|
| D1 database `cairn` | Created — `a05a3c87-c16b-458e-87f8-9c117a28312e`, primary region ENAM |
| `0001_init.sql` on the remote DB | Applied, and recorded in `d1_migrations` |
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

`npm run deploy` is `npm run build && wrangler deploy` — the build must run
first, because `[assets] directory = "./dist"` uploads whatever is on disk.

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

Add `migrations/000N_*.sql` and apply to both:

```sh
npx wrangler d1 migrations apply cairn --local
npx wrangler d1 migrations apply cairn --remote
```

## Verifying the remote database

```sh
npx wrangler d1 execute cairn --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Expect `boards`, `tasks`, `sessions`, `login_attempts`, `d1_migrations`, and
D1's internal `_cf_KV`.
