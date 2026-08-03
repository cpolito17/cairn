# Cairn — Password Setup

How the single password gets into the deployment, start to finish. Follow this
once before the first deploy, and again whenever you rotate the password.

Cairn has no registration flow, no password reset, and no default password. The
password exists in exactly one place: a Cloudflare Worker secret named
`AUTH_PASSWORD`. The Worker reads it at cold start, derives a PBKDF2-SHA256 hash
in memory, and compares every login attempt against that hash with a
constant-time comparison. The raw password is never written to D1, never logged,
and never sent anywhere except from your browser to the login endpoint over TLS.

> **Where the plaintext does live:** the Cloudflare dashboard, as an encrypted
> secret. Anyone with access to that Cloudflare account can reveal it. This was a
> deliberate choice for operational simplicity over the hash-only alternative.

---

## Prerequisites

- Node 20+ and npm.
- A Cloudflare account with the `charliepolito.com` zone already added.
- Wrangler authenticated: `npx wrangler login`.
- The D1 database created and bound (see `wrangler.toml`; created once with
  `npx wrangler d1 create cairn`).

---

## Step 1 — Choose the password

Pick something long. There is no username to guess, so the password is the entire
security boundary. A passphrase of four or more random words, or 20+ random
characters, is appropriate. Store it in your password manager **before** you set
it — there is no recovery path.

To generate one:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

---

## Step 2 — Set the secret in production

```bash
npx wrangler secret put AUTH_PASSWORD
```

Wrangler prompts for the value and does not echo it. Paste the password and press
Enter. Do **not** pass it as a command-line argument — it would land in your shell
history.

Confirm it registered (this lists secret *names* only, never values):

```bash
npx wrangler secret list
```

You should see `AUTH_PASSWORD` in the output.

---

## Step 3 — Set the same secret for local development

Local `wrangler dev` does not read production secrets. Create a `.dev.vars` file
in the repository root:

```
AUTH_PASSWORD=your-local-dev-password
```

`.dev.vars` is listed in `.gitignore` and must never be committed. It can hold a
different, weaker password than production — it only guards your local machine.

---

## Step 4 — Verify

Deploy, then check that all three cases behave correctly:

```bash
npx wrangler deploy
```

1. **Wrong password** — visit `https://tasks.charliepolito.com`, enter something
   incorrect. You get an inline error and stay on the login screen.
2. **Correct password** — enter the real password. You land on the context home,
   and a `cairn_session` cookie is set (DevTools → Application → Cookies) with
   `HttpOnly`, `Secure`, `SameSite=Lax`, and an expiry roughly 90 days out.
3. **Rate limiting** — enter a wrong password six times in a row. The sixth
   response refuses further attempts and states a cooling-off period rather than
   telling you whether the password was wrong.

If the Worker starts but every login fails with a server error, `AUTH_PASSWORD`
is almost certainly unset — the Worker treats a missing secret as a hard
configuration failure rather than falling back to any default.

---

## Step 5 — Rotating the password

```bash
npx wrangler secret put AUTH_PASSWORD   # enter the new value
```

The change takes effect on the next cold start, within seconds.

**Rotation does not sign out existing sessions.** Sessions are rows in D1 and are
independent of the password. If you are rotating because you believe the password
was exposed, also destroy every active session:

```bash
npx wrangler d1 execute cairn --remote --command "DELETE FROM sessions"
```

Every device is then sent back to the login screen on its next request.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every login returns a 500 | `AUTH_PASSWORD` not set on the deployed Worker | Step 2, then redeploy |
| Login works locally but not in production | Secret set in `.dev.vars` only | Step 2 |
| Logged out on every reload | Cookie rejected — usually a non-HTTPS origin | Use the real hostname, not an IP or `http://` |
| Locked out after testing | Rate limiter still cooling off | Wait it out, or `DELETE FROM login_attempts` via the D1 command above |
