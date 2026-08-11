/**
 * `sendPush` is where the two hard halves meet the network, and a wiring
 * mistake here — a header named wrongly, a body passed as the wrong type, a
 * status code read as the wrong outcome — is invisible until a notification
 * silently fails to arrive at eight in the morning.
 *
 * So `fetch` is stubbed and the request is inspected: it is the only assertion
 * available short of a real push service, and it covers everything this file is
 * responsible for.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url } from './base64';
import type { SubscriptionKeys } from './encrypt';
import { sendPush } from './send';
import type { VapidKeys } from './vapid';
import { exportRawKey, generateEcdhKeyPair } from './webcrypto';

async function target(): Promise<{ endpoint: string; keys: SubscriptionKeys }> {
  const pair = await generateEcdhKeyPair();
  return {
    endpoint: 'https://web.push.apple.com/device-token',
    keys: {
      p256dh: await exportRawKey(pair.publicKey),
      auth: crypto.getRandomValues(new Uint8Array(16)),
    },
  };
}

async function vapid(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    publicKey: toBase64Url(
      new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    ),
    privateKey: jwk.d!,
    subject: 'mailto:owner@example.com',
  };
}

/** Stub `fetch`, returning `status`, and hand back what was sent. */
function stubFetch(status: number, body = '') {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendPush', () => {
  it('POSTs an encrypted body with the headers a push service requires', async () => {
    const calls = stubFetch(201);
    const result = await sendPush(await target(), '{"title":"hi"}', await vapid());

    expect(result).toEqual({ status: 'sent' });
    expect(calls).toHaveLength(1);

    const { url, init } = calls[0];
    expect(url).toBe('https://web.push.apple.com/device-token');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(Number(headers.TTL)).toBeGreaterThan(0);

    // A real ArrayBuffer, and longer than the 21-byte RFC 8188 header plus the
    // 65-byte key — i.e. an actual encrypted record, not an empty body.
    expect(init.body).toBeInstanceOf(ArrayBuffer);
    expect((init.body as ArrayBuffer).byteLength).toBeGreaterThan(86);
  });

  it('reports 404 and 410 as expired, which is what prunes the subscription', async () => {
    for (const status of [404, 410]) {
      stubFetch(status);
      expect(await sendPush(await target(), '{}', await vapid())).toEqual({
        status: 'expired',
        code: status,
      });
      vi.unstubAllGlobals();
    }
  });

  it('keeps the push service’s own explanation on a failure', async () => {
    stubFetch(400, 'VAPID credentials mismatch');
    const result = await sendPush(await target(), '{}', await vapid());
    // Without the body a 400 here is undebuggable: the status alone does not
    // distinguish a bad token from an over-long payload.
    expect(result).toEqual({
      status: 'failed',
      code: 400,
      detail: 'VAPID credentials mismatch',
    });
  });

  it('turns a network failure into a result rather than a throw', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')));
    const result = await sendPush(await target(), '{}', await vapid());
    expect(result).toMatchObject({ status: 'failed', code: null });
  });

  it('fails without calling fetch when the key material is malformed', async () => {
    const calls = stubFetch(201);
    const keys = await vapid();
    const result = await sendPush(await target(), '{}', { ...keys, privateKey: 'nonsense' });

    expect(result.status).toBe('failed');
    // Nothing should reach the network with credentials that cannot be signed.
    expect(calls).toHaveLength(0);
  });
});
