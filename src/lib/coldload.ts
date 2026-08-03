/**
 * "Has this surface already staggered in?" PROJECT-SPEC.md §8.5.
 *
 * Board cards and Up Next entries stagger in at 40ms intervals **on the cold
 * load only** — never on subsequent renders. Without a record of what has
 * already played, every re-render of the list replays the entrance, which is
 * the single most common way a tasteful stagger becomes a twitch.
 *
 * The record is module scope rather than component state on purpose: navigating
 * to a board and back remounts the home screen, and that is a subsequent render
 * of the same surface, not a cold load.
 */

const played = new Set<string>();

/** True once, for the first mount of `key` in this session. */
export function claimColdLoad(key: string): boolean {
  if (played.has(key)) return false;
  played.add(key);
  return true;
}

/** Test seam. Nothing in the app calls this. */
export function resetColdLoad(): void {
  played.clear();
}

/** The stagger interval, in seconds, for `motion`'s `delay`. */
export const STAGGER_STEP = 0.04;

/** Entrance delay for row `index`, capped so a long list does not crawl. */
export function staggerDelay(index: number): number {
  return Math.min(index, 8) * STAGGER_STEP;
}
