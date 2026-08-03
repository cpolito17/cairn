import { describe, expect, it } from 'vitest';
import { derivePasswordHash, newSessionId, readCookie, timingSafeEqual } from './auth';

function buf(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe('timingSafeEqual', () => {
  it('matches identical digests', () => {
    expect(timingSafeEqual(buf(1, 2, 3, 4), buf(1, 2, 3, 4))).toBe(true);
  });

  it('rejects a difference in the first byte', () => {
    expect(timingSafeEqual(buf(9, 2, 3, 4), buf(1, 2, 3, 4))).toBe(false);
  });

  it('rejects a difference in the last byte', () => {
    expect(timingSafeEqual(buf(1, 2, 3, 9), buf(1, 2, 3, 4))).toBe(false);
  });

  it('rejects a length mismatch without treating a prefix as a match', () => {
    expect(timingSafeEqual(buf(1, 2, 3), buf(1, 2, 3, 4))).toBe(false);
    expect(timingSafeEqual(buf(1, 2, 3, 4), buf(1, 2, 3))).toBe(false);
  });
});

describe('derivePasswordHash', () => {
  it('is deterministic and 256 bits wide', async () => {
    const a = await derivePasswordHash('correct horse battery staple');
    const b = await derivePasswordHash('correct horse battery staple');
    expect(a.byteLength).toBe(32);
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it('separates passwords that share a prefix', async () => {
    const a = await derivePasswordHash('hunter2');
    const b = await derivePasswordHash('hunter22');
    expect(timingSafeEqual(a, b)).toBe(false);
  });
});

describe('newSessionId', () => {
  it('is 256 bits of base64url with no padding', () => {
    const id = newSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, newSessionId));
    expect(ids.size).toBe(200);
  });
});

describe('readCookie', () => {
  const withCookie = (value: string) =>
    new Request('https://tasks.example.com/api/session', { headers: { cookie: value } });

  it('reads a lone cookie', () => {
    expect(readCookie(withCookie('cairn_session=abc'), 'cairn_session')).toBe('abc');
  });

  it('reads a cookie among others', () => {
    expect(readCookie(withCookie('a=1; cairn_session=abc; b=2'), 'cairn_session')).toBe('abc');
  });

  it('does not match on a name suffix', () => {
    expect(readCookie(withCookie('not_cairn_session=abc'), 'cairn_session')).toBeNull();
  });

  it('is null with no cookie header', () => {
    expect(
      readCookie(new Request('https://tasks.example.com/api/session'), 'cairn_session'),
    ).toBeNull();
  });
});
