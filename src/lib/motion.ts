/**
 * The motion constants the drag and the completion transition share.
 * PROJECT-SPEC.md §8.5.
 *
 * The two springs are the two the spec names by number. They are expressed in
 * Motion's `visualDuration` / `bounce` form rather than stiffness and damping
 * because that is the same pair of dials §8.5 uses — response and damping ratio
 * — and translating them by hand is how the numbers drift: `bounce: 0` is
 * damping 1.0, critically damped, no overshoot, which is what "this product's
 * personality is crisp and precise" means in arithmetic.
 */

/** §8.5 standard out curve, as a CSS value and as a Motion easing array. */
export const OUT_CURVE = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const OUT = [0.23, 1, 0.32, 1] as const;

/** Displaced rows moving out of the way of a drag: damping 1.0, response 0.35. */
export const REPOSITION = { type: 'spring', visualDuration: 0.35, bounce: 0 } as const;

/**
 * Settling after a release, and the completion travel: damping 1.0, response
 * 0.4. Given a release velocity this is where the seam between the gesture and
 * the animation would otherwise be — the spring is handed the pointer's own
 * velocity so there is nothing to see.
 */
export const SETTLE = { type: 'spring', visualDuration: 0.4, bounce: 0 } as const;

/**
 * Read at the moment of the gesture rather than subscribed to, because every
 * caller here is imperative — a pointer handler or a layout effect — and a
 * React state value would be one render stale exactly when it mattered.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
