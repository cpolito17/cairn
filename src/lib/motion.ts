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

/** §8.5 drawer curve — sheets and drawers. */
export const DRAWER = [0.32, 0.72, 0, 1] as const;

/**
 * Every spring below is written in **stiffness, damping and mass**, derived
 * from the two dials §8.5 actually specifies: damping ratio and response.
 *
 * The obvious spelling is Motion's own `visualDuration`/`bounce`, which reads
 * like the spec's vocabulary — and it is what this file used to say. It is
 * wrong here for one disqualifying reason: **Motion's duration-based springs
 * silently ignore `velocity`.** Handed an initial velocity of 2000px/s pointing
 * away from its target, a `visualDuration: 0.4, bounce: 0` spring produces no
 * overshoot whatsoever; the same spring written as stiffness and damping
 * carries 30% past the start before turning round. Every `{ ...SETTLE, velocity }`
 * in this codebase was therefore handing the pointer's speed to a spring that
 * dropped it on the floor, and "release-velocity handoff" — which §5 makes
 * non-negotiable and §8.5 calls the seam between dragging and animating — was
 * not happening at all. It could not be seen in a screenshot, only in a flick.
 *
 * The conversion is the textbook one, and it is also the definition SwiftUI
 * uses for exactly the two words §8.5 chose:
 *
 *     ω = 2π / response      stiffness = m·ω²      damping = 2·ζ·m·ω
 *
 * so a response of 0.4 and a damping ratio of 1.0 are still *stated* as 0.4 and
 * 1.0 below. Nothing about the spec's numbers is reinterpreted here; only the
 * units they are handed to Motion in, and whether the pointer's velocity
 * survives the trip.
 */
function spring(dampingRatio: number, response: number) {
  const omega = (2 * Math.PI) / response;
  return {
    type: 'spring',
    mass: 1,
    stiffness: omega * omega,
    damping: 2 * dampingRatio * omega,
  } as const;
}

/** Displaced rows moving out of the way of a drag: damping 1.0, response 0.35. */
export const REPOSITION = spring(1.0, 0.35);

/** The default UI spring: damping 1.0, response 0.3. Crisp, no overshoot. */
export const UI_SPRING = spring(1.0, 0.3);

/**
 * Sheets: damping 0.8, response 0.3 (§8.5). The only motion in the app with any
 * overshoot at all, and it is earned — a sheet is dragged, so its dismissal
 * carries the flick's momentum and stopping dead would be the seam §8.5 is
 * written to remove. A 0.8 damping ratio is the shallow end of the 0.1–0.3
 * bounce band.
 */
export const SHEET_SPRING = spring(0.8, 0.3);

/**
 * Settling after a release, and the completion travel: damping 1.0, response
 * 0.4. Given a release velocity this is where the seam between the gesture and
 * the animation would otherwise be — the spring is handed the pointer's own
 * velocity so there is nothing to see.
 */
export const SETTLE = spring(1.0, 0.4);

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
