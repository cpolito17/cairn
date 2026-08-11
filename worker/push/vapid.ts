/**
 * VAPID — how a push service knows who is sending.
 *
 * A push endpoint is a bearer URL: anyone holding it could otherwise push to
 * that device. VAPID (RFC 8292) closes that by having the application server
 * sign a short-lived JWT with a key pair whose public half the browser was
 * given at subscribe time. The push service checks the signature against the
 * `k` parameter, and the browser checks that `k` matches what it subscribed
 * with — so a push from a different key pair is refused before it is delivered.
 *
 * This is *not* the payload encryption (that is `encrypt.ts`, a separate key
 * pair with a separate job). The two are routinely confused; keeping them in
 * different files is deliberate.
 *
 * The key pair is generated once by the owner and lives in Worker secrets.
 * Rotating it invalidates every existing subscription, because the browser
 * pinned the old public key — see `docs/NOTIFICATIONS.md`.
 */

import { fromBase64Url, toBase64Url, utf8 } from './base64';
import { buffer } from './webcrypto';

/** How long a signed token is good for. The RFC's ceiling is 24 hours. */
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface VapidKeys {
  /** The uncompressed P-256 public point, base64url — as the browser has it. */
  publicKey: string;
  /** The 32-byte private scalar, base64url. */
  privateKey: string;
  /** A `mailto:` or `https:` the push service can complain to. */
  subject: string;
}

/**
 * The `Authorization` header value for a push to `endpoint`.
 *
 * The audience is the endpoint's *origin*, not the endpoint itself: the token
 * authorises this server to talk to that push service, and including the
 * subscription-specific path would leak it into a signed token for no benefit.
 */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys): Promise<string> {
  const audience = new URL(endpoint).origin;
  const token = await signJwt(
    {
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
      sub: keys.subject,
    },
    keys,
  );
  return `vapid t=${token}, k=${keys.publicKey}`;
}

async function signJwt(claims: Record<string, unknown>, keys: VapidKeys): Promise<string> {
  const header = toBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = toBase64Url(utf8(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;

  const key = await importPrivateKey(keys);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    buffer(utf8(signingInput)),
  );

  // WebCrypto emits the raw r‖s pair ES256 wants. Nothing to re-encode — a
  // DER-wrapped signature here would be rejected by every push service.
  return `${signingInput}.${toBase64Url(signature)}`;
}

/**
 * The signing key, as a JWK assembled from the two halves.
 *
 * `web-push`-style keys are raw scalars and raw points, not PKCS#8 and not
 * SPKI, so there is nothing to import directly. A P-256 JWK is exactly the
 * private scalar `d` plus the public coordinates `x` and `y`, and the public
 * point is `0x04 ‖ X(32) ‖ Y(32)` — so both coordinates are already sitting in
 * the public key the owner generated alongside it.
 */
async function importPrivateKey(keys: VapidKeys): Promise<CryptoKey> {
  const publicBytes = fromBase64Url(keys.publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }
  const privateBytes = fromBase64Url(keys.privateKey);
  if (privateBytes.length !== 32) {
    throw new Error('VAPID private key must be a 32-byte P-256 scalar');
  }

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: toBase64Url(privateBytes),
      x: toBase64Url(publicBytes.subarray(1, 33)),
      y: toBase64Url(publicBytes.subarray(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * The configured keys, or null when the deployment has no VAPID secrets.
 *
 * Null rather than a throw: a Worker with no notification secrets is a valid
 * deployment — it is what every deployment looks like before the owner runs the
 * key generation step — and the whole app going down over an unsent
 * notification would be a much worse outcome than notifications being off.
 */
export function vapidKeysFrom(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}): VapidKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    // The subject only has to be a contact a push service could use to reach
    // the operator. A deployment that has not set one still works.
    subject: env.VAPID_SUBJECT?.trim() || 'mailto:notifications@example.com',
  };
}
