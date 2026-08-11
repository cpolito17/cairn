/**
 * Web Push payload encryption — RFC 8291 over the `aes128gcm` content coding
 * of RFC 8188.
 *
 * The push service is an untrusted relay. Apple, Google and Mozilla all run one
 * for their browsers, and the whole point of this scheme is that none of them
 * can read what is being pushed. Only the browser that generated the
 * subscription's key pair can decrypt the body, which is why a payload has to
 * be encrypted to *that subscription* rather than merely sent over TLS.
 *
 * The shape of it:
 *
 *   1. Generate a fresh P-256 key pair for this one message.
 *   2. ECDH against the subscription's public key (`p256dh`) for a shared
 *      secret, then mix in the subscription's `auth` secret — the step that
 *      binds the key material to this subscription and not just to this curve
 *      point.
 *   3. HKDF that into a 16-byte content-encryption key and a 12-byte nonce.
 *   4. AES-128-GCM the payload, with a single 0x02 delimiter byte appended
 *      marking it as the last record.
 *   5. Prefix the salt, the record size, and the ephemeral public key, because
 *      the receiver needs all three to reverse the above.
 *
 * Every constant string here is load-bearing and byte-exact, `\0` terminators
 * included. There is no partial credit: a wrong info string produces a body the
 * browser silently fails to decrypt, and the push service reports success.
 * `encrypt.test.ts` therefore decrypts what this produces rather than
 * asserting on its bytes.
 */

import { concat, toBase64Url, utf8 } from './base64';
import { buffer, ecdhWith, exportRawKey, generateEcdhKeyPair } from './webcrypto';

/** The key material a browser hands over when it subscribes. */
export interface SubscriptionKeys {
  /** The subscription's public key: 65 uncompressed P-256 bytes, base64url. */
  p256dh: Uint8Array;
  /** The subscription's 16-byte auth secret, base64url on the wire. */
  auth: Uint8Array;
}

/**
 * The record size advertised in the header. One record is all this app ever
 * sends — a notification is a few hundred bytes — so this only has to exceed
 * the payload plus GCM's 16-byte tag and the delimiter.
 */
const RECORD_SIZE = 4096;

/** RFC 8188 §2: the last (here, only) record ends with 0x02, not 0x01. */
const LAST_RECORD_DELIMITER = 0x02;

const KEY_INFO_PREFIX = utf8('WebPush: info\0');
const CEK_INFO = utf8('Content-Encoding: aes128gcm\0');
const NONCE_INFO = utf8('Content-Encoding: nonce\0');

/**
 * `plaintext`, encrypted to `keys`. The result is the HTTP body, verbatim.
 *
 * A fresh key pair and a fresh salt per call, both required: reusing either
 * across two messages to the same subscription would reuse the nonce, which is
 * the one thing AES-GCM must never do.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
): Promise<Uint8Array> {
  const ephemeral = await generateEcdhKeyPair();
  const ephemeralPublic = await exportRawKey(ephemeral.publicKey);

  const receiverPublic = await crypto.subtle.importKey(
    'raw',
    buffer(keys.p256dh),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhWith(receiverPublic), ephemeral.privateKey, 256),
  );

  // RFC 8291 §3.4. The key info commits to *both* public keys, so a shared
  // secret cannot be replayed against a different pair of parties.
  const keyInfo = concat(KEY_INFO_PREFIX, keys.p256dh, ephemeralPublic);
  const ikm = await hkdf(keys.auth, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);

  const aesKey = await crypto.subtle.importKey('raw', buffer(contentKey), 'AES-GCM', false, [
    'encrypt',
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buffer(nonce), tagLength: 128 },
      aesKey,
      buffer(concat(plaintext, new Uint8Array([LAST_RECORD_DELIMITER]))),
    ),
  );

  // RFC 8188 §2.1: salt(16) ‖ rs(4, big-endian) ‖ idlen(1) ‖ keyid ‖ ciphertext.
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0, RECORD_SIZE);
  header[4] = ephemeralPublic.length;

  return concat(salt, header, ephemeralPublic, ciphertext);
}

/** HKDF-SHA256, extract and expand, as one call. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buffer(ikm), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: buffer(salt),
      info: buffer(info),
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** The `Crypto-Key`-era helper kept for tests and diagnostics. */
export function publicKeyToBase64Url(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}
