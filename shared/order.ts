/**
 * Fractional index positions.
 *
 * A position is an opaque base-62 string over the alphabet `0-9A-Za-z`. That
 * alphabet is already in ASCII order, so plain string `<` is the correct total
 * order — no parsing, no numeric conversion, and D1 can `ORDER BY position`
 * directly.
 *
 * The point of the representation: inserting a row between two neighbors writes
 * exactly one row. Two devices inserting at the same slot concurrently produce
 * two distinct positions that still sort deterministically (ties between equal
 * positions are broken by `id` ascending at read time, which lives in the API
 * layer, not here).
 *
 * A key is an integer part followed by an optional fractional part. The first
 * character of the integer part encodes both its sign and its length: `a`-`z`
 * are non-negative and mean 2..27 characters total, `A`-`Z` are negative and
 * mean 27..2 characters total. Encoding the length in the head is what lets
 * `getIntegerPart` split a key without a delimiter, and what keeps sequential
 * appends O(1) in length: `a0`, `a1`, ... `az`, `b00`, and so on. The
 * fractional part is only reached when no integer step fits, i.e. when
 * inserting between adjacent neighbors, and it never ends in `0` (a trailing
 * zero would be a second spelling of the same value and would break the
 * one-string-one-position invariant).
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length; // 62
const SMALLEST_INTEGER = 'A' + DIGITS[0].repeat(BASE - 36); // 'A' + 26 zeroes

/** The position given to the first row in an empty list. */
export const FIRST_POSITION: string = 'a' + DIGITS[0]; // 'a0'

/** True when `a` sorts strictly before `b`. */
export function positionsAreOrdered(a: string, b: string): boolean {
  return a < b;
}

/** True when `s` is a well-formed position string. */
export function isValidPosition(s: string): boolean {
  try {
    validate(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a position that sorts strictly between `before` and `after`.
 *
 * - `midpoint(null, null)` seeds a list at mid-range, leaving room on both sides.
 * - `midpoint(a, null)` appends beyond `a`.
 * - `midpoint(null, b)` returns something less than `b`.
 * - `midpoint(a, b)` returns a value strictly between them, growing the string
 *   only when no shorter value fits.
 */
export function midpoint(before: string | null, after: string | null): string {
  if (before !== null) validate(before);
  if (after !== null) validate(after);
  if (before !== null && after !== null && before >= after) {
    throw new Error(`positions out of order: ${before} >= ${after}`);
  }

  if (before === null) {
    if (after === null) return FIRST_POSITION;

    // Step the integer part down one if we can; otherwise subdivide the
    // fractional part below `after`.
    const int = integerPart(after);
    const frac = after.slice(int.length);
    if (int === SMALLEST_INTEGER) return int + fractionBetween('', frac);
    if (int < after) return int;
    const decremented = decrementInteger(int);
    if (decremented === null) throw new Error('position space exhausted below');
    return decremented;
  }

  if (after === null) {
    const int = integerPart(before);
    const frac = before.slice(int.length);
    const incremented = incrementInteger(int);
    return incremented === null ? int + fractionBetween(frac, null) : incremented;
  }

  const intBefore = integerPart(before);
  const fracBefore = before.slice(intBefore.length);
  const intAfter = integerPart(after);
  const fracAfter = after.slice(intAfter.length);

  if (intBefore === intAfter) return intBefore + fractionBetween(fracBefore, fracAfter);

  const incremented = incrementInteger(intBefore);
  if (incremented === null) throw new Error('position space exhausted above');
  if (incremented < after) return incremented;
  return intBefore + fractionBetween(fracBefore, null);
}

/**
 * `n` evenly-ish spaced positions between `before` and `after`, in order.
 * Used when seeding a list or moving several rows at once.
 */
export function midpoints(before: string | null, after: string | null, n: number): string[] {
  if (n < 0) throw new Error('n must be >= 0');
  if (n === 0) return [];
  if (n === 1) return [midpoint(before, after)];

  if (after === null) {
    let cursor = midpoint(before, null);
    const out = [cursor];
    while (out.length < n) {
      cursor = midpoint(cursor, null);
      out.push(cursor);
    }
    return out;
  }
  if (before === null) {
    let cursor = midpoint(null, after);
    const out = [cursor];
    while (out.length < n) {
      cursor = midpoint(null, cursor);
      out.push(cursor);
    }
    return out.reverse();
  }

  // Split at the middle and recurse into both halves so the results stay short.
  const half = Math.floor(n / 2);
  const mid = midpoint(before, after);
  return [...midpoints(before, mid, half), mid, ...midpoints(mid, after, n - half - 1)];
}

// --- integer part -----------------------------------------------------------

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`invalid position head: ${head}`);
}

function integerPart(position: string): string {
  const len = integerLength(position.charAt(0));
  if (len > position.length) throw new Error(`invalid position: ${position}`);
  return position.slice(0, len);
}

function validateInteger(int: string): void {
  if (int.length !== integerLength(int.charAt(0))) {
    throw new Error(`invalid integer part: ${int}`);
  }
}

function validate(position: string): void {
  if (position === '') throw new Error('position must not be empty');
  const int = integerPart(position);
  validateInteger(int);
  const frac = position.slice(int.length);
  for (const c of int.slice(1) + frac) {
    if (DIGITS.indexOf(c) === -1) throw new Error(`invalid position digit: ${c}`);
  }
  if (frac.slice(-1) === DIGITS[0]) {
    throw new Error(`position must not end in ${DIGITS[0]}: ${position}`);
  }
}

function incrementInteger(int: string): string | null {
  validateInteger(int);
  const head = int.charAt(0);
  const digits = int.slice(1).split('');

  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1;
    if (d === BASE) {
      digits[i] = DIGITS[0];
    } else {
      digits[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');

  // Overflowed this magnitude — widen (or narrow, on the negative side).
  if (head === 'Z') return 'a' + DIGITS[0];
  if (head === 'z') return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digits.push(DIGITS[0]);
  else digits.pop();
  return next + digits.join('');
}

function decrementInteger(int: string): string | null {
  validateInteger(int);
  const head = int.charAt(0);
  const digits = int.slice(1).split('');

  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) - 1;
    if (d === -1) {
      digits[i] = DIGITS[BASE - 1];
    } else {
      digits[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');

  if (head === 'a') return 'Z' + DIGITS[BASE - 1];
  if (head === 'A') return null;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < 'Z') digits.push(DIGITS[BASE - 1]);
  else digits.pop();
  return next + digits.join('');
}

// --- fractional part --------------------------------------------------------

/**
 * A fractional-digit string strictly between `a` and `b`, where both are
 * fractional parts under the same integer part and `a < b` (with `b === null`
 * meaning "one"). Never returns a value ending in `0`.
 */
function fractionBetween(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`fractions out of order: ${a} >= ${b}`);

  if (b !== null) {
    // Copy the shared prefix through and subdivide what's left.
    let n = 0;
    while ((a.charAt(n) || DIGITS[0]) === b.charAt(n)) n++;
    if (n > 0) return b.slice(0, n) + fractionBetween(a.slice(n), b.slice(n));
  }

  const digitA = a === '' ? 0 : DIGITS.indexOf(a.charAt(0));
  const digitB = b !== null && b !== '' ? DIGITS.indexOf(b.charAt(0)) : BASE;

  if (digitB - digitA > 1) {
    // Room for a shorter answer at this depth.
    return DIGITS[Math.round(0.5 * (digitA + digitB))];
  }
  if (b !== null && b.length > 1) {
    // The neighbors are adjacent here but `b` continues, so `b`'s own leading
    // digit already sits strictly between them.
    return b.slice(0, 1);
  }
  // Adjacent with nothing to borrow — descend one digit and try again.
  return DIGITS[digitA] + fractionBetween(a.slice(1), null);
}
