/**
 * The three places `@cloudflare/workers-types` describes WebCrypto differently
 * from the runtime, wrapped once so nothing else has to know.
 *
 * All three are typing artefacts, not behaviour differences — the Workers
 * runtime implements the standard here, and the same calls work unchanged in
 * Node and in a browser (which is what lets `encrypt.test.ts` exercise them
 * under vitest at all):
 *
 *   1. `generateKey` is typed as returning `CryptoKey | CryptoKeyPair`, because
 *      one signature covers both symmetric and asymmetric algorithms. For
 *      P-256 it is always a pair.
 *   2. `exportKey` is typed as returning `ArrayBuffer | JsonWebKey` for the
 *      same reason. With `'raw'` it is always an `ArrayBuffer`.
 *   3. The ECDH derivation parameter is spelled `$public` in the type
 *      definitions and `public` everywhere else, including in the runtime. The
 *      cast below is the one that would be a real bug if it were wrong, so it
 *      is covered by a decryption round-trip rather than by a type.
 *
 * Casting in one file with an explanation beats sprinkling `as` through code
 * whose correctness is the whole point.
 */

/** A fresh P-256 pair for one message's ECDH. */
export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
}

/** A public key as its uncompressed 65-byte point. */
export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
}

/** The ECDH parameter naming the other party's public key. */
export function ecdhWith(publicKey: CryptoKey): Parameters<SubtleCrypto['deriveBits']>[0] {
  return { name: 'ECDH', public: publicKey } as unknown as Parameters<
    SubtleCrypto['deriveBits']
  >[0];
}

/**
 * A standalone `ArrayBuffer` for a view.
 *
 * WebCrypto accepts a `Uint8Array`, but a subarray carries its parent's whole
 * buffer and some runtimes read the buffer rather than the view — which
 * silently operates on the wrong bytes. Copying costs a few hundred bytes here
 * and removes the class of bug.
 */
export function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
