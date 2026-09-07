# Cairn

Cairn is a visual task planner for turning complicated work into clear next steps. It combines boards, dependency mapping, calendar planning, priority signals, and an “Up Next” view in a focused web app.

**Live demo:** https://tasks.charliepolito.com/demo

**Portfolio:** [charliepolito.com](https://charliepolito.com/)

**Source:** [github.com/cpolito17/cairn](https://github.com/cpolito17/cairn)

The demo is safe to explore: its sample data stays in the current browser tab and never touches the owner's private workspace.

## Features

- Personal and work task boards with ordering, archive, and progress states
- Task dependencies and a visual blockers graph
- Day, month, and year planning views
- Due dates, duration, difficulty, priority, and scheduling metadata
- Responsive, accessible interface with light/dark themes and reduced-motion support
- Offline-aware UI and optional Web Push notifications
- Isolated, no-account public demo backed by `sessionStorage`

## Architecture

Cairn is a TypeScript monorepo-style application with a React 19/Vite client and a Cloudflare Worker API. Cloudflare D1 stores the private workspace and sessions. Shared types and dependency rules live in `shared/`; Worker routes live in `worker/routes/`; database migrations live in `migrations/`. The public demo swaps the network data layer for an in-browser implementation in `src/lib/demo/`.

## Local development

Requirements: Node.js 20+, npm, and a Cloudflare account for Worker/D1 development.

```bash
npm ci
npm run migrate:local
npm run worker:dev
```

For a client-only preview, run `npm run dev`. Worker development needs a `.dev.vars` file:

```dotenv
AUTH_PASSWORD=a-long-local-development-password
VAPID_PUBLIC_KEY=optional-public-key
VAPID_PRIVATE_KEY=optional-private-key
VAPID_SUBJECT=mailto:you@example.com
```

Never commit `.dev.vars` or production credentials. See `docs/PASSWORD-SETUP.md` for password setup and rotation.

## Scripts

- `npm run dev` — start Vite
- `npm run worker:dev` — run the Worker and static assets locally
- `npm run build` — type-check and create the production client build
- `npm test` — run the Vitest suite once
- `npm run typecheck` — check client and Worker TypeScript
- `npm run migrate:local` / `migrate:remote` — apply D1 migrations
- `npm run deploy` — build, migrate, and deploy with Wrangler

## Deployment

`wrangler.toml` defines the Worker, D1 database, static asset binding, and notification schedule. Configure the required Worker secrets, create or bind the production D1 database, then run `npm run deploy`. The public demo is served at `/demo`; all other application routes remain part of the password-protected owner experience.

## Security and privacy

- The private API is session-gated; sessions use opaque HttpOnly, Secure cookies stored server-side.
- Password verification uses PBKDF2-SHA256 and constant-time comparison, with IP-based login throttling.
- API responses are marked `no-store`; responses include clickjacking, MIME-sniffing, referrer, permissions, and HSTS protections.
- Demo data is isolated per tab in `sessionStorage`, makes no API writes, and disappears when the tab closes.
- Private workspace data and push subscriptions are stored in the configured D1 database.

Before production releases, run the test suite, TypeScript build, and `npm audit`. Rotate credentials immediately if a secret is ever exposed.

## Project status

Active personal project. The hosted demo is public; the owner workspace is private and single-user by design.

## License

No open-source license is currently granted. Unless a license file is added, all rights are reserved by the repository owner.
