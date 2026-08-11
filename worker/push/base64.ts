/**
 * base64url, in both directions.
 *
 * Web Push speaks base64url everywhere — VAPID keys, the subscription's public
 * key and auth secret, the JWT — and it is *unpadded* base64url, which `atob`
 * refuses and `btoa` will not produce. Hence the small amount of code here
 * rather than a call to a platform function that is almost right.
 */

/** Raw bytes from an unpadded (or padded) base64url string. */
export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  // `atob` requires the padding that base64url drops.
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Unpadded base64url for raw bytes. */
export function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  // Chunked because spreading a large array into `String.fromCharCode` blows
  // the argument limit. Nothing here is large today; the ciphertexts this app
  // sends are a few hundred bytes. It costs one line to not care.
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** UTF-8 bytes for a string. */
export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Several byte runs, end to end. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
