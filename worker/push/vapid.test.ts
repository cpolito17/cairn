/**
 * The VAPID header is verified by checking the signature the way a push service
 * does: import the public key from the `k` parameter, and verify `header.payload`
 * against it. A test that only asserted the token's shape would pass with a
 * signature over the wrong bytes.
 */

import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url, utf8 } from './base64';
import { vapidAuthorization, vapidKeysFrom, type VapidKeys } from './vapid';
import { buffer } from './webcrypto';

/** A key pair in the format the generation script emits. */
async function generateKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  return {
    publicKey: toBase64Url(publicKey),
    privateKey: jwk.d!,
    subject: 'mailto:owner@example.com',
  };
}

function parse(authorization: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  expect(match).not.toBeNull();
  const [, token, key] = match!;
  const [header, payload, signature] = token.split('.');
  return {
    key,
    token,
    header: JSON.parse(new TextDecoder().decode(fromBase64Url(header))),
    claims: JSON.parse(new TextDecoder().decode(fromBase64Url(payload))),
    signingInput: `${header}.${payload}`,
    signature: fromBase64Url(signature),
  };
}

describe('vapidAuthorization', () => {
  it('signs a token the advertised public key verifies', async () => {
    const keys = await generateKeys();
    const parsed = parse(
      await vapidAuthorization('https://web.push.apple.com/abc123', keys),
    );

    const publicKey = await crypto.subtle.importKey(
      'raw',
      buffer(fromBase64Url(parsed.key)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      buffer(parsed.signature),
      buffer(utf8(parsed.signingInput)),
    );

    expect(valid).toBe(true);
    expect(parsed.signature).toHaveLength(64); // raw r‖s, not DER
    expect(parsed.header).toEqual({ typ: 'JWT', alg: 'ES256' });
  });

  it('addresses the token to the push service origin, not the endpoint', async () => {
    const keys = await generateKeys();
    const parsed = parse(
      await vapidAuthorization('https://web.push.apple.com/some/secret/path?x=1', keys),
    );
    // The endpoint path is the bearer secret. It must not end up inside a
    // token that gets logged by every hop that handles it.
    expect(parsed.claims.aud).toBe('https://web.push.apple.com');
    expect(parsed.token).not.toContain('secret');
  });

  it('expires within the RFC 8292 ceiling of 24 hours', async () => {
    const keys = await generateKeys();
    const { claims } = parse(await vapidAuthorization('https://fcm.googleapis.com/x', keys));
    const seconds = claims.exp - Math.floor(Date.now() / 1000);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it('refuses key material of the wrong shape rather than signing nonsense', async () => {
    const keys = await generateKeys();
    await expect(
      vapidAuthorization('https://example.com/x', { ...keys, publicKey: toBase64Url(new Uint8Array(64)) }),
    ).rejects.toThrow(/65-byte/);
    await expect(
      vapidAuthorization('https://example.com/x', { ...keys, privateKey: toBase64Url(new Uint8Array(16)) }),
    ).rejects.toThrow(/32-byte/);
  });
});

describe('vapidKeysFrom', () => {
  it('is null when the deployment has no push secrets', () => {
    expect(vapidKeysFrom({})).toBeNull();
    expect(vapidKeysFrom({ VAPID_PUBLIC_KEY: 'abc' })).toBeNull();
    expect(vapidKeysFrom({ VAPID_PUBLIC_KEY: '  ', VAPID_PRIVATE_KEY: 'x' })).toBeNull();
  });

  it('falls back to a placeholder subject rather than refusing to send', () => {
    const keys = vapidKeysFrom({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' });
    expect(keys?.subject).toMatch(/^mailto:/);
  });
});
