/**
 * The encryptor is verified by *decrypting* it.
 *
 * Asserting on the bytes of an aes128gcm body would only prove this file still
 * does what it did yesterday. The property that matters is the one the browser
 * exercises: a subscription's private key, and nothing else, recovers the
 * plaintext. So the test plays the browser — generates a subscription key pair,
 * encrypts to it, and runs RFC 8291 backwards using an independent
 * implementation of the derivation written from the RFC rather than shared with
 * the code under test. A wrong info string or a swapped key order fails here.
 */

import { describe, expect, it } from 'vitest';
import { concat, fromBase64Url, toBase64Url, utf8 } from './base64';
import { buffer, ecdhWith, exportRawKey, generateEcdhKeyPair } from './webcrypto';
import { encryptPayload, type SubscriptionKeys } from './encrypt';

/** A browser subscription: a P-256 key pair plus a 16-byte auth secret. */
async function subscription() {
  const pair = await generateEcdhKeyPair();
  const p256dh = await exportRawKey(pair.publicKey);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, keys: { p256dh, auth } satisfies SubscriptionKeys };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', buffer(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: buffer(salt), info: buffer(info) },
      key,
      length * 8,
    ),
  );
}

/** RFC 8188 §2.1 header, then RFC 8291 §3.4 derivation, then AES-GCM open. */
async function decrypt(
  body: Uint8Array,
  privateKey: CryptoKey,
  keys: SubscriptionKeys,
): Promise<string> {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const senderPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);

  const sender = await crypto.subtle.importKey(
    'raw',
    buffer(senderPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhWith(sender), privateKey, 256),
  );

  const ikm = await hkdf(
    keys.auth,
    shared,
    concat(utf8('WebPush: info\0'), keys.p256dh, senderPublic),
    32,
  );
  const contentKey = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', buffer(contentKey), 'AES-GCM', false, [
    'decrypt',
  ]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buffer(nonce), tagLength: 128 },
      aesKey,
      buffer(ciphertext),
    ),
  );

  expect(padded.at(-1)).toBe(0x02); // the last-record delimiter
  return new TextDecoder().decode(padded.subarray(0, -1));
}

describe('encryptPayload', () => {
  it('produces a body the subscription can decrypt', async () => {
    const { pair, keys } = await subscription();
    const payload = JSON.stringify({ title: 'Call Sam', body: 'Roof · Due 1:30 PM' });

    const body = await encryptPayload(utf8(payload), keys);

    expect(await decrypt(body, pair.privateKey, keys)).toBe(payload);
  });

  it('carries the RFC 8188 header: salt, record size, and the sender key', () => {
    // Header geometry is asserted directly because the decrypt path above
    // depends on reading it correctly, and a test that parsed it wrongly in
    // both places would pass while sending an unreadable body.
    return (async () => {
      const { keys } = await subscription();
      const body = await encryptPayload(utf8('hi'), keys);

      expect(body.subarray(0, 16)).toHaveLength(16);
      expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
      expect(body[20]).toBe(65); // an uncompressed P-256 point
      expect(body[21]).toBe(0x04); // ...which always starts with 0x04
    })();
  });

  it('never reuses a salt or an ephemeral key between messages', async () => {
    const { keys } = await subscription();
    const first = await encryptPayload(utf8('hi'), keys);
    const second = await encryptPayload(utf8('hi'), keys);

    // Same plaintext, same subscription, and the bodies must still differ:
    // a repeated salt would mean a repeated nonce, which is the one thing
    // AES-GCM cannot survive.
    expect(toBase64Url(first.subarray(0, 16))).not.toBe(toBase64Url(second.subarray(0, 16)));
    expect(toBase64Url(first.subarray(21, 86))).not.toBe(toBase64Url(second.subarray(21, 86)));
  });

  it('cannot be decrypted with a different subscription’s auth secret', async () => {
    const { pair, keys } = await subscription();
    const body = await encryptPayload(utf8('secret'), keys);
    const wrong = { ...keys, auth: crypto.getRandomValues(new Uint8Array(16)) };

    await expect(decrypt(body, pair.privateKey, wrong)).rejects.toThrow();
  });
});

describe('base64url', () => {
  it('round-trips bytes without padding', () => {
    for (const length of [0, 1, 2, 3, 16, 65, 200]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toContain('=');
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(fromBase64Url(encoded)).toEqual(bytes);
    }
  });

  it('accepts padded input, which is what some browsers send', () => {
    expect(fromBase64Url('YQ==')).toEqual(utf8('a'));
    expect(fromBase64Url('YQ')).toEqual(utf8('a'));
  });
});
