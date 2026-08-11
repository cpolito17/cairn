#!/usr/bin/env node
/**
 * Generate a VAPID key pair for push notifications.
 *
 *   node scripts/generate-vapid-keys.mjs
 *
 * Prints the two keys and the exact `wrangler secret put` commands to install
 * them. Nothing is written to disk and nothing is uploaded — the private key is
 * printed once, and if it is lost the answer is to generate a new pair and
 * re-subscribe every device.
 *
 * No dependency: this is `web-push --gen-vapid-keys` in twenty lines of
 * WebCrypto, and adding a package to a project whose whole stated bar is bundle
 * size and speed would be a poor trade for a command run approximately once.
 *
 * The format matches what every Web Push implementation expects — the public
 * key is the uncompressed P-256 point (65 bytes, base64url) that a browser
 * passes as `applicationServerKey`, and the private key is the raw 32-byte
 * scalar.
 */

import { webcrypto as crypto } from 'node:crypto';

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);

const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
// The JWK's `d` is already the base64url private scalar.
const { d: privateKey } = await crypto.subtle.exportKey('jwk', pair.privateKey);

console.log('VAPID key pair — the private key is shown once and is not stored anywhere.\n');
console.log(`  Public key:   ${publicKey}`);
console.log(`  Private key:  ${privateKey}\n`);
console.log('Install them as Worker secrets:\n');
console.log(`  echo "${publicKey}" | npx wrangler secret put VAPID_PUBLIC_KEY`);
console.log(`  echo "${privateKey}" | npx wrangler secret put VAPID_PRIVATE_KEY`);
console.log('  echo "mailto:you@example.com" | npx wrangler secret put VAPID_SUBJECT\n');
console.log('Then: npm run deploy — and turn notifications on in Settings.');
console.log(
  '\nRotating these keys invalidates every existing subscription: each device\n' +
    'must turn notifications off and on again to re-subscribe.',
);
