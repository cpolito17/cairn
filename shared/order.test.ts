import { describe, expect, it } from 'vitest';
import { FIRST_POSITION, isValidPosition, midpoint, midpoints, positionsAreOrdered } from './order';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

describe('positionsAreOrdered', () => {
  it('is plain string comparison', () => {
    expect(positionsAreOrdered('a0', 'a1')).toBe(true);
    expect(positionsAreOrdered('a1', 'a0')).toBe(false);
    expect(positionsAreOrdered('a0', 'a0')).toBe(false);
  });

  it('agrees with sorting a shuffled list of generated positions', () => {
    const positions: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      cursor = midpoint(cursor, null);
      positions.push(cursor);
    }
    const shuffled = [...positions].sort(() => Math.random() - 0.5);
    expect([...shuffled].sort()).toEqual(positions);
  });
});

describe('midpoint seeds', () => {
  it('midpoint(null, null) returns FIRST_POSITION', () => {
    expect(midpoint(null, null)).toBe(FIRST_POSITION);
  });

  it('leaves room on both sides of the seed', () => {
    expect(midpoint(null, FIRST_POSITION) < FIRST_POSITION).toBe(true);
    expect(FIRST_POSITION < midpoint(FIRST_POSITION, null)).toBe(true);
  });
});

describe('midpoint(a, null) — append', () => {
  it('a < midpoint(a, null)', () => {
    for (const a of ['a0', 'a1', 'azz', 'b00', 'Zz', 'a0V']) {
      expect(positionsAreOrdered(a, midpoint(a, null))).toBe(true);
    }
  });

  it('1,000 sequential appends stay strictly ascending', () => {
    const positions: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 1000; i++) {
      cursor = midpoint(cursor, null);
      positions.push(cursor);
    }
    expect(positions).toHaveLength(1000);
    expect(new Set(positions).size).toBe(1000);
    for (let i = 1; i < positions.length; i++) {
      expect(positionsAreOrdered(positions[i - 1], positions[i])).toBe(true);
    }
    // Appends must not grow without bound — the integer part absorbs them.
    expect(Math.max(...positions.map((p) => p.length))).toBeLessThanOrEqual(4);
  });
});

describe('midpoint(null, b) — prepend', () => {
  it('midpoint(null, b) < b', () => {
    for (const b of ['a0', 'a1', 'b00', 'Zz', 'a0V']) {
      expect(positionsAreOrdered(midpoint(null, b), b)).toBe(true);
    }
  });

  it('1,000 sequential prepends stay strictly descending', () => {
    const positions: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 1000; i++) {
      cursor = midpoint(null, cursor);
      positions.push(cursor);
    }
    expect(new Set(positions).size).toBe(1000);
    for (let i = 1; i < positions.length; i++) {
      expect(positionsAreOrdered(positions[i], positions[i - 1])).toBe(true);
    }
    expect(Math.max(...positions.map((p) => p.length))).toBeLessThanOrEqual(4);
  });
});

describe('midpoint(a, b) — insert between', () => {
  it('lands strictly between adjacent neighbors', () => {
    const a = 'a0';
    const b = midpoint(a, null);
    const mid = midpoint(a, b);
    expect(positionsAreOrdered(a, mid)).toBe(true);
    expect(positionsAreOrdered(mid, b)).toBe(true);
  });

  it('1,000 repeated insertions between the same two neighbors never collide', () => {
    const a = 'a0';
    const b = 'a1'; // deliberately adjacent, the worst case
    const seen = new Set<string>();
    let lower = a;
    for (let i = 0; i < 1000; i++) {
      const mid = midpoint(lower, b);
      expect(positionsAreOrdered(a, mid)).toBe(true);
      expect(positionsAreOrdered(mid, b)).toBe(true);
      expect(seen.has(mid)).toBe(false);
      seen.add(mid);
      lower = mid; // each insert goes just after the previous one
    }
    expect(seen.size).toBe(1000);
    const ordered = [...seen];
    expect([...ordered].sort()).toEqual(ordered);
  });

  it('1,000 insertions immediately before the same neighbor never collide', () => {
    const a = 'a0';
    const b = 'a1';
    const seen = new Set<string>();
    let upper = b;
    for (let i = 0; i < 1000; i++) {
      const mid = midpoint(a, upper);
      expect(positionsAreOrdered(a, mid)).toBe(true);
      expect(positionsAreOrdered(mid, b)).toBe(true);
      expect(seen.has(mid)).toBe(false);
      seen.add(mid);
      upper = mid;
    }
    expect(seen.size).toBe(1000);
  });

  it('always bisects rather than extending when a shorter value fits', () => {
    // Wide gap: the answer should be a single extra digit, not a long tail.
    expect(midpoint('a0', 'a2')).toBe('a1');
    expect(midpoint('a0', 'a1').length).toBe(3);
  });

  it('rejects out-of-order and equal inputs', () => {
    expect(() => midpoint('a1', 'a0')).toThrow();
    expect(() => midpoint('a0', 'a0')).toThrow();
  });

  it('rejects malformed positions', () => {
    expect(() => midpoint('', null)).toThrow();
    expect(() => midpoint('0', null)).toThrow(); // no valid head
    expect(() => midpoint('a', null)).toThrow(); // integer part too short
    expect(() => midpoint('a0V0', null)).toThrow(); // trailing zero
    expect(() => midpoint('a0!', null)).toThrow(); // digit outside the alphabet
  });
});

describe('generated positions', () => {
  it('only ever use the base-62 alphabet and validate', () => {
    let cursor: string | null = null;
    for (let i = 0; i < 500; i++) {
      cursor = midpoint(cursor, null);
      expect(isValidPosition(cursor)).toBe(true);
      for (const c of cursor) expect(ALPHABET.includes(c)).toBe(true);
    }
  });

  it('never end in 0, so one position has exactly one spelling', () => {
    let a = 'a0';
    const b = 'a1';
    for (let i = 0; i < 200; i++) {
      a = midpoint(a, b);
      expect(a.endsWith('0')).toBe(false);
    }
  });
});

describe('randomized ordering fuzz', () => {
  it('a list stays consistently ordered under 2,000 random insertions', () => {
    const list: string[] = [midpoint(null, null)];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(Math.random() * (list.length + 1));
      const before = at === 0 ? null : list[at - 1];
      const after = at === list.length ? null : list[at];
      const position = midpoint(before, after);
      list.splice(at, 0, position);
    }
    expect(list).toHaveLength(2001);
    expect(new Set(list).size).toBe(2001);
    for (let i = 1; i < list.length; i++) {
      expect(positionsAreOrdered(list[i - 1], list[i])).toBe(true);
    }
    // Sorting the positions independently must reproduce the list order.
    expect([...list].sort()).toEqual(list);
  });

  it('two concurrent writers at the same slot produce a stable total order', () => {
    // Both devices read the same neighbors and insert without seeing each other.
    const before = 'a0';
    const after = 'a1';
    const deviceA = midpoint(before, after);
    const deviceB = midpoint(before, after);
    // Same input gives the same position; ties are broken by id at read time.
    expect(deviceA).toBe(deviceB);
    // Either way both sit strictly between the neighbors, so merging is total.
    const merged = [before, deviceA, deviceB, after].sort();
    expect(merged[0]).toBe(before);
    expect(merged[3]).toBe(after);
  });
});

describe('midpoints', () => {
  it('returns n ascending positions between the neighbors', () => {
    for (const [before, after] of [
      [null, null],
      ['a0', null],
      [null, 'a5'],
      ['a0', 'a1'],
      ['a0', 'aZ'],
    ] as [string | null, string | null][]) {
      const out = midpoints(before, after, 12);
      expect(out).toHaveLength(12);
      expect([...out].sort()).toEqual(out);
      if (before !== null) expect(positionsAreOrdered(before, out[0])).toBe(true);
      if (after !== null) expect(positionsAreOrdered(out[out.length - 1], after)).toBe(true);
    }
  });

  it('handles the degenerate counts', () => {
    expect(midpoints(null, null, 0)).toEqual([]);
    expect(midpoints(null, null, 1)).toEqual([FIRST_POSITION]);
    expect(() => midpoints(null, null, -1)).toThrow();
  });
});
