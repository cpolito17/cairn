/**
 * The pointer conventions the app's two drag primitives share.
 * PROJECT-SPEC.md §5, §8.5.
 *
 * `Reorderable` (one-dimensional, one surface) and the Planner's scheduling
 * gesture (two-dimensional, across surfaces, with a resize edge) are separate
 * primitives on purpose — generalizing one into the other would produce a
 * component with a mode switch at every interesting line. What they must *not*
 * differ on is the feel: the same 6px of fine-pointer slop, the same 200ms
 * long-press, the same rubber-band, the same edge acceleration, the same window
 * over which a release velocity is measured. Two copies of those numbers is two
 * gestures that drift apart one tuning session at a time, so they live here and
 * both primitives import them.
 *
 * Everything in this file is pure or a constant. The gesture *lifecycles* stay
 * in their own primitives, because that is where they genuinely differ.
 */

/** §8.5: a 200ms long-press with ~10px of hit-slop, so a scroll stays a scroll. */
export const LONG_PRESS_MS = 200;
export const TOUCH_SLOP = 10;
/** §8.5: on a fine pointer, ~6px of movement and the drag is already running. */
export const POINTER_SLOP = 6;

/** §8.5: the grab lift — 1.02, 150ms, out-curve. */
export const LIFT_SCALE = 1.02;
export const LIFT_SECONDS = 0.15;

/** Asymptotic ceiling of a boundary rubber-band, in px. */
export const RUBBER = 72;

/** Auto-scroll: the band at each edge, and the speed at the very edge. */
export const EDGE_BAND = 84;
export const EDGE_MAX_SPEED = 1150;

/** Seconds of the release velocity projected before the landing slot is chosen. */
export const PROJECTION = 0.12;

/** Velocity is measured over the tail of the gesture, not the whole of it. */
export const VELOCITY_WINDOW_MS = 60;
/**
 * A gesture that has been still for longer than this has no velocity, whatever
 * the last few samples say. Without the check, holding steady for a beat and
 * then letting go throws the thing — the samples from before the pause are
 * still the newest ones there are.
 */
export const VELOCITY_STALE_MS = 70;
export const VELOCITY_LIMIT = 4000;

/** How long after a release a click is still that release, not a tap. */
export const CLICK_GUARD_MS = 400;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Diminishing give past a boundary: unbounded input, bounded output. */
export function rubberBand(overflow: number): number {
  const distance = Math.abs(overflow);
  return Math.sign(overflow) * RUBBER * (1 - 1 / (distance / RUBBER + 1));
}

/** Progressive resistance past a boundary, never a hard stop (§8.5). */
export function resist(value: number, min: number, max: number): number {
  if (value < min) return min + rubberBand(value - min);
  if (value > max) return max + rubberBand(value - max);
  return value;
}

/**
 * Auto-scroll speed in px/s for a pointer `fromStart` px from the leading edge
 * of a scrollable span `length` px long. Negative scrolls back, positive
 * forward, zero anywhere outside the two bands.
 *
 * Squared, so the band is gentle where the user is merely near it and quick at
 * the very edge — "accelerating with proximity to the edge" (§8.5).
 */
export function edgeSpeed(fromStart: number, length: number): number {
  const fromEnd = length - fromStart;
  if (fromStart < EDGE_BAND) return -EDGE_MAX_SPEED * ((EDGE_BAND - fromStart) / EDGE_BAND) ** 2;
  if (fromEnd < EDGE_BAND) return EDGE_MAX_SPEED * ((EDGE_BAND - fromEnd) / EDGE_BAND) ** 2;
  return 0;
}

export interface Sample {
  t: number;
  x: number;
  y: number;
}

/** Push a position sample, keeping the buffer to the tail of the gesture. */
export function sample(samples: Sample[], x: number, y: number): void {
  samples.push({ t: performance.now(), x, y });
  if (samples.length > 12) samples.shift();
}

/** The pointer's velocity in px/s at `now`, from the tail of its samples. */
export function velocityOf(samples: Sample[], now: number): { x: number; y: number } {
  if (samples.length < 2) return { x: 0, y: 0 };
  const last = samples[samples.length - 1];
  if (now - last.t > VELOCITY_STALE_MS) return { x: 0, y: 0 };
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t > VELOCITY_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return { x: 0, y: 0 };
  return {
    x: clamp((last.x - first.x) / dt, -VELOCITY_LIMIT, VELOCITY_LIMIT),
    y: clamp((last.y - first.y) / dt, -VELOCITY_LIMIT, VELOCITY_LIMIT),
  };
}
