/**
 * FLIP — the shared "something moved, so show the movement" mechanism.
 * PROJECT-SPEC.md §8.5.
 *
 * Both interactions this app is judged on end the same way: state changes, the
 * list re-renders somewhere else, and the row has to *travel* there rather than
 * disappear from one place and reappear in another. A dropped row travels to
 * its new slot while the rows it displaced close the gap; a completed row
 * travels out of the active list and into the Completed group while the rows
 * above it close the gap. That is one mechanism, so it is written once.
 *
 * How it works: every participating element registers here with its key. After
 * every commit the group reads each element's *layout* position — its
 * `getBoundingClientRect` with its own transform divided back out, in document
 * coordinates so a scroll between commits cannot be mistaken for movement — and
 * compares it to where that element was last seen. If it moved, the element is
 * translated back to where it visually was and then sprung to zero. The browser
 * never paints the jump.
 *
 * Three properties of that design are the reason for it:
 *
 * - It animates from the **live presentation value**, never the logical target.
 *   A row grabbed or re-sorted mid-flight is re-referenced from wherever it
 *   currently appears, so an interrupt cannot make it jump (§8.5).
 * - It is **transform only**. Nothing here reads or writes width, height, top
 *   or left; the elements' layout positions are the browser's business and the
 *   only thing this file sets is a `translate3d`/`scale` pair.
 * - An element that moves between two lists — the active list and the Completed
 *   group — is a *different DOM node* rendered by React, so the key's last
 *   visual position is kept as a ghost across the commit that swaps them. That
 *   ghost is what makes completion one continuous movement instead of an exit
 *   animation followed by an entrance.
 *
 * Transforms are written straight to `style.transform` from a synchronous
 * MotionValue subscription rather than through a `motion` component: the
 * inversion has to land in the same frame as the commit that caused it, and a
 * value that reaches the DOM on the next animation frame is the one-frame flash
 * this whole file exists to avoid.
 */

import { animate, motionValue, type MotionValue } from 'motion/react';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import { prefersReducedMotion, REPOSITION, SETTLE } from './motion';

export interface FlipEntry {
  el: HTMLElement;
  /** Offset from the element's layout position. Zero at rest. */
  x: MotionValue<number>;
  y: MotionValue<number>;
  /** The drag lift. Kept here so the transform is written in one place. */
  scale: MotionValue<number>;
}

interface Tracked extends FlipEntry {
  /** Last known layout position, document coordinates. */
  left: number;
  top: number;
  seen: boolean;
  release: () => void;
}

/** Where a key was last seen on screen, kept across the commit that moves it. */
interface Ghost {
  left: number;
  top: number;
}

interface Handoff {
  x: number;
  y: number;
}

function transformOf(entry: FlipEntry): string {
  const scale = entry.scale.get();
  const translate = `translate3d(${entry.x.get()}px, ${entry.y.get()}px, 0)`;
  return scale === 1 ? translate : `${translate} scale(${scale})`;
}

export interface LayoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The element's box with its own transform divided back out, so a row that is
 * mid-animation still reports where the browser would lay it out. Scale is
 * about the center, which is why it shifts the edges and has to be undone.
 * Document coordinates: a page scrolled between two measurements has not moved
 * anything, and viewport coordinates would say it had.
 */
export function layoutRectOf(entry: FlipEntry, scrollX: number, scrollY: number): LayoutRect {
  const rect = entry.el.getBoundingClientRect();
  const scale = entry.scale.get() || 1;
  const width = rect.width / scale;
  const height = rect.height / scale;
  return {
    left: rect.left + scrollX + (rect.width - width) / 2 - entry.x.get(),
    top: rect.top + scrollY + (rect.height - height) / 2 - entry.y.get(),
    width,
    height,
  };
}

export class FlipGroup {
  private tracked = new Map<string, Tracked>();
  private ghosts = new Map<string, Ghost>();
  private handoffs = new Map<string, Handoff>();
  private paused = false;
  private quiet = false;
  private sweep = 0;
  private queued = false;

  /**
   * Ghosts and hand-offs live until the next frame, not until the next `run`.
   *
   * React does not guarantee that removing a row from one list and adding it to
   * another lands in a single commit, and in practice it does not: the active
   * list loses the row, a `run` follows, and only then does the Completed group
   * gain it. Clearing on `run` would throw the ghost away in the gap and the
   * row would appear at its destination instead of travelling to it. A frame is
   * the honest lifetime — anything within one frame is the same movement.
   */
  private scheduleSweep(): void {
    if (this.sweep !== 0) return;
    this.sweep = requestAnimationFrame(() => {
      this.sweep = 0;
      this.ghosts.clear();
      this.handoffs.clear();
      this.quiet = false;
    });
  }

  /** Run at the end of this commit, before paint, and only once. */
  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.run();
    });
  }

  /** Register an element under `key`. Returns the cleanup React 19 expects. */
  attach(key: string, el: HTMLElement): () => void {
    const ghost = this.ghosts.get(key);
    const entry: Tracked = {
      el,
      x: motionValue(0),
      y: motionValue(0),
      scale: motionValue(1),
      left: ghost?.left ?? 0,
      top: ghost?.top ?? 0,
      seen: ghost !== undefined,
      release: () => {},
    };

    const write = () => {
      el.style.transform = transformOf(entry);
    };
    write();
    const unsubscribe = [
      entry.x.on('change', write),
      entry.y.on('change', write),
      entry.scale.on('change', write),
    ];
    entry.release = () => unsubscribe.forEach((off) => off());

    this.tracked.set(key, entry);

    // A carried element has to be inverted in the commit that mounted it, and
    // the commit that mounts it is not always one the provider re-renders in —
    // the Completed group sits under an `AnimatePresence`, which re-renders
    // itself. A microtask runs after the whole commit and still before the
    // browser paints, which is the one place left to catch it. Without this the
    // row paints once at its destination and only then travels, which is the
    // disappear-and-reappear §8.5 is written to prevent.
    if (ghost !== undefined) this.schedule();

    return () => {
      const current = this.tracked.get(key);
      if (current !== entry) return;
      // The key's last *visual* position, not its layout position: if the row
      // was still travelling when it changed lists, the new element picks the
      // movement up from where the old one had got to.
      if (entry.seen) {
        this.ghosts.set(key, {
          left: entry.left + entry.x.get(),
          top: entry.top + entry.y.get(),
        });
        this.scheduleSweep();
      }
      entry.x.stop();
      entry.y.stop();
      entry.scale.stop();
      entry.release();
      this.tracked.delete(key);
    };
  }

  entry(key: string): FlipEntry | undefined {
    return this.tracked.get(key);
  }

  /**
   * Stop measuring. Held for the length of a drag: the layout genuinely does
   * not change while a row is being dragged — only its transform does — so
   * every commit in between would measure the same positions and the one
   * measurement that matters is the one taken before the gesture began.
   */
  pause(on: boolean): void {
    this.paused = on;
  }

  /** Record positions without animating: a resize is not movement. */
  remeasure(): void {
    this.run(true);
  }

  /**
   * §8.5: keyboard-initiated actions get no animation, ever. The next commit is
   * recorded and not animated.
   */
  skipNext(): void {
    // For the rest of the frame, not for the next `run`: one state change can
    // take more than one commit, and the second of them is the one that would
    // otherwise animate.
    this.quiet = true;
    this.scheduleSweep();
  }

  /**
   * Hand a release velocity to the next commit's settle for `key`, in px/s.
   * This is the seam-removal: the spring starts at the speed the finger left.
   */
  handOff(key: string, x: number, y: number): void {
    this.handoffs.set(key, { x, y });
    this.scheduleSweep();
  }

  run(silentOnce = false): void {
    const silent = silentOnce || this.quiet;
    if (this.paused) return;

    const reduced = prefersReducedMotion();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    // Every read first, then every write. Interleaving them makes each write
    // invalidate the next read, and a forty-row board pays for it in forced
    // reflows on a commit that usually has nothing to animate.
    const measured: { key: string; entry: Tracked; next: LayoutRect }[] = [];
    for (const [key, entry] of this.tracked) {
      measured.push({ key, entry, next: layoutRectOf(entry, scrollX, scrollY) });
    }

    for (const { key, entry, next } of measured) {
      // The test is whether the *layout* moved, not whether the element is
      // currently offset from it. An element that is mid-flight through a
      // commit that did not move it is left strictly alone — re-referencing it
      // would restart its spring from zero velocity, and a settle that hitches
      // every time something else re-renders is the interruption bug in
      // reverse.
      const moved =
        !entry.seen ||
        Math.abs(entry.left - next.left) > 0.5 ||
        Math.abs(entry.top - next.top) > 0.5;
      if (!moved) continue;

      const fromX = entry.seen ? entry.left + entry.x.get() - next.left : 0;
      const fromY = entry.seen ? entry.top + entry.y.get() - next.top : 0;
      const handoff = this.handoffs.get(key);
      const first = !entry.seen;

      entry.left = next.left;
      entry.top = next.top;
      entry.seen = true;

      // Nothing to travel from: the element has only just appeared, this is a
      // recording pass, or the user asked for no movement.
      if (first || silent) continue;
      if (reduced) {
        // Gentler, not zero (§8.5): the row still lands where it belongs, it
        // just does not travel there.
        entry.x.jump(0);
        entry.y.jump(0);
        continue;
      }

      // Carry whatever speed the value already had, so reversing mid-flight
      // blends velocity rather than cutting it (§8.5). An explicit hand-off
      // from a released drag wins over it.
      const velocityX = handoff?.x ?? entry.x.getVelocity();
      const velocityY = handoff?.y ?? entry.y.getVelocity();

      entry.x.jump(fromX);
      entry.y.jump(fromY);
      this.travel(entry, velocityX, velocityY);
    }

  }

  /** The settle itself, plus the hints that only hold while it is running. */
  private travel(entry: Tracked, velocityX: number, velocityY: number): void {
    const el = entry.el;
    el.style.willChange = 'transform';
    // A travelling row passes over its neighbours; without this it passes
    // under them and reads as two objects rather than one.
    if (el.style.zIndex === '') el.style.zIndex = '1';

    let running = 2;
    const done = () => {
      if (--running > 0) return;
      el.style.willChange = '';
      if (el.style.zIndex === '1') el.style.zIndex = '';
    };

    void animate(entry.x, 0, { ...SETTLE, velocity: velocityX }).then(done, done);
    void animate(entry.y, 0, { ...SETTLE, velocity: velocityY }).then(done, done);
  }
}

/** Displaced rows during a drag — the other spring §8.5 names (1.0 / 0.35). */
export const DISPLACE = REPOSITION;

const FlipContext = createContext<FlipGroup | null>(null);

export function useFlipGroup(): FlipGroup {
  const ref = useRef<FlipGroup | null>(null);
  if (ref.current === null) ref.current = new FlipGroup();
  return ref.current;
}

/** The group a `FlipItem` or a `Reorderable` beneath this provider belongs to. */
export function useFlipContext(): FlipGroup | null {
  return useContext(FlipContext);
}

/**
 * Measures after every commit beneath it. The provider re-renders whenever its
 * parent does, which for both consumers — the board screen and the context
 * home — is exactly when the lists it holds can have changed.
 */
export function FlipProvider({
  group: provided,
  children,
}: {
  /** Pass one in when the screen needs to reach the group itself. */
  group?: FlipGroup;
  children: ReactNode;
}) {
  const own = useFlipGroup();
  const group = provided ?? own;

  // No dependency array: the whole point is to run on every commit, before the
  // browser paints the layout the commit produced.
  useLayoutEffect(() => {
    group.run();
  });

  useEffect(() => {
    const onResize = () => group.remeasure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [group]);

  return createElement(FlipContext.Provider, { value: group }, children);
}

/** A ref callback that keeps `key` registered with the surrounding group. */
export function useFlipRef(key: string): (el: HTMLElement | null) => (() => void) | void {
  const group = useContext(FlipContext);
  return useCallback(
    (el: HTMLElement | null) => {
      if (el === null || group === null) return;
      return group.attach(key, el);
    },
    [group, key],
  );
}

/**
 * A list item that participates in the group. Used for the Completed rows,
 * which do not drag but do have to travel and close gaps.
 */
export function FlipItem({
  flipKey,
  className,
  children,
}: {
  flipKey: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useFlipRef(flipKey);
  return createElement('li', { ref, className }, children);
}
