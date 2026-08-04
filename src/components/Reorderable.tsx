/**
 * Drag to reorder. PROJECT-SPEC.md §8.5 (specified in full there), §6.6, §7.3.
 *
 * One primitive, used by the board's active task list and by the board cards on
 * the context home. It is written directly against Pointer Events because the
 * two things §5 makes non-negotiable — grab-offset respect and release-velocity
 * handoff — are exactly what a reorder library abstracts away: a library that
 * re-centres the row under the finger, or that cross-fades a drop instead of
 * springing it from the pointer's own speed, cannot be talked into either.
 *
 * What the pointer layer owns: initiation, tracking, the boundary resistance,
 * the edge auto-scroll, and the velocity at release. What it does *not* own is
 * the settle — the row is not animated to a slot here. On release the new
 * position is persisted optimistically, the list re-renders in its new order,
 * and `lib/flip.ts` translates the row from where it visually was to where it
 * now belongs and springs it home with the release velocity. That is why a
 * failed write animates the row back to its origin without a line of code
 * saying so: the rollback is another commit, and every commit travels.
 *
 * Interruption falls out of the same arrangement. Nothing is ever locked, and a
 * grab reads the row's live transform as its starting offset, so picking up a
 * row that is still settling continues from where it appears rather than from
 * where it was headed.
 *
 * The window listeners are attached through fixed trampolines rather than
 * directly: a handler defined in the render body is a different function on
 * every render, and `removeEventListener` given a different function removes
 * nothing. That is how a drag survives its own re-renders.
 */

import { animate } from 'motion/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  DISPLACE,
  FlipProvider,
  layoutRectOf,
  useFlipContext,
  useFlipRef,
  type FlipEntry,
  type LayoutRect,
} from '../lib/flip';
import { OUT, prefersReducedMotion, SETTLE } from '../lib/motion';

/** §8.5: a 200ms long-press with ~10px of hit-slop, so a scroll stays a scroll. */
const LONG_PRESS_MS = 200;
const TOUCH_SLOP = 10;
/** §8.5: on a fine pointer, ~6px of movement and the drag is already running. */
const POINTER_SLOP = 6;

const LIFT_SCALE = 1.02;
const LIFT_SECONDS = 0.15;

/** Asymptotic ceiling of the boundary rubber-band, in px. */
const RUBBER = 72;
/** Auto-scroll: the band at each viewport edge, and the speed at the very edge. */
const EDGE_BAND = 84;
const EDGE_MAX_SPEED = 1150;
/** Seconds of the release velocity projected before the landing slot is chosen. */
const PROJECTION = 0.12;
/** Velocity is measured over the tail of the gesture, not the whole of it. */
const VELOCITY_WINDOW_MS = 60;
/**
 * A gesture that has been still for longer than this has no velocity, whatever
 * the last few samples say. Without the check, holding a row steady for a beat
 * and then letting go throws it — the samples from before the pause are still
 * the newest ones there are.
 */
const VELOCITY_STALE_MS = 70;
const VELOCITY_LIMIT = 4000;
/** How long after a release a click is still that release, not a tap. */
const CLICK_GUARD_MS = 400;

export interface ReorderableItemState {
  dragging: boolean;
  index: number;
}

export interface ReorderableProps<T> {
  items: T[];
  getKey(item: T): string;
  /**
   * Fired once on release, with the item's new neighbours in the new order.
   * Either may be null at an end of the list. The caller turns them into a
   * position with `midpoint()` and persists optimistically (§7.3).
   */
  onReorder(item: T, before: T | null, after: T | null): void;
  children(item: T, state: ReorderableItemState): ReactNode;
  /** Applied to the list element. The board cards pass their grid here. */
  className?: string;
  itemClassName?: string;
  /** Radius of the lifted row's elevated surface. */
  liftRadius?: string;
  disabled?: boolean;
  /**
   * True when the region below the list refuses drops — the Completed group.
   * §8.5: a row dragged over it is refused with a visible boundary rather than
   * silently accepted.
   */
  refuseBelow?: boolean;
  'aria-label'?: string;
}

/** Which end of the list the row is currently being pushed against. */
type Edge = 'none' | 'top' | 'bottom';

interface Candidate {
  key: string;
  pointerId: number;
  el: HTMLElement;
  clientX: number;
  clientY: number;
  touch: boolean;
  timer: number | null;
}

interface Sample {
  t: number;
  x: number;
  y: number;
}

interface Drag {
  key: string;
  index: number;
  pointerId: number;
  el: HTMLElement;
  entry: FlipEntry;
  touch: boolean;
  /** Two columns or one. A single column never tracks horizontally. */
  grid: boolean;
  keys: string[];
  slots: LayoutRect[];
  origin: LayoutRect;
  baseX: number;
  baseY: number;
  startDocX: number;
  startDocY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  target: number;
  offsets: Map<string, { x: number; y: number }>;
  samples: Sample[];
  clientX: number;
  clientY: number;
  raf: number | null;
  lastFrame: number;
}

function rubberBand(overflow: number): number {
  const distance = Math.abs(overflow);
  return Math.sign(overflow) * RUBBER * (1 - 1 / (distance / RUBBER + 1));
}

/** Progressive resistance past an end of the list, never a hard stop (§8.5). */
function resist(value: number, min: number, max: number): number {
  if (value < min) return min + rubberBand(value - min);
  if (value > max) return max + rubberBand(value - max);
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function slotIndexFor(slots: LayoutRect[], x: number, y: number, grid: boolean): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const dy = y - (slot.top + slot.height / 2);
    const dx = grid ? x - (slot.left + slot.width / 2) : 0;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function velocityOf(samples: Sample[], now: number): { x: number; y: number } {
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

/**
 * The list, with a FLIP group around it if nothing above already provides one.
 * The board screen provides its own, because the group has to span the active
 * list *and* the Completed group for a completed row to travel between them.
 */
export function Reorderable<T>(props: ReorderableProps<T>) {
  const group = useFlipContext();
  const list = <ReorderableList {...props} />;
  return group ? list : <FlipProvider>{list}</FlipProvider>;
}

function ReorderableList<T>({
  items,
  getKey,
  onReorder,
  children,
  className,
  itemClassName,
  liftRadius = 'var(--radius-control)',
  disabled = false,
  refuseBelow = false,
  ...rest
}: ReorderableProps<T>) {
  const group = useFlipContext();
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [edge, setEdge] = useState<Edge>('none');

  const candidateRef = useRef<Candidate | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const edgeRef = useRef<Edge>('none');
  const suppressClickRef = useRef(0);

  // Handlers live for the length of a gesture, not the length of a render, so
  // they read the current props from here rather than closing over them.
  const latest = useRef({ items, getKey, onReorder, disabled, group });
  latest.current = { items, getKey, onReorder, disabled, group };

  // The list re-renders on its own state too, and its commits can be the ones
  // that moved something. `run` is idempotent — it only acts on elements whose
  // layout actually changed — so the provider running as well costs nothing.
  useLayoutEffect(() => {
    group?.run();
  });

  const setEdgeState = useCallback((next: Edge) => {
    if (edgeRef.current === next) return;
    edgeRef.current = next;
    setEdge(next);
  }, []);

  /* --- gesture state, all of it behind fixed identities ------------------- */

  const gesture = useRef({
    move(_event: PointerEvent) {},
    up(_event: PointerEvent) {},
    cancel(_event: PointerEvent) {},
    key(_event: KeyboardEvent) {},
  });

  const bound = useRef({
    move: (event: PointerEvent) => gesture.current.move(event),
    up: (event: PointerEvent) => gesture.current.up(event),
    cancel: (event: PointerEvent) => gesture.current.cancel(event),
    key: (event: KeyboardEvent) => gesture.current.key(event),
    // Non-passive, and only while a drag is underway: this is what stops iOS
    // Safari from turning the gesture into a page scroll. Until the long-press
    // resolves the browser is left alone and a swipe scrolls normally.
    touch: (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    },
    menu: (event: Event) => event.preventDefault(),
  }).current;

  const detach = useCallback(() => {
    window.removeEventListener('pointermove', bound.move);
    window.removeEventListener('pointerup', bound.up);
    window.removeEventListener('pointercancel', bound.cancel);
    window.removeEventListener('keydown', bound.key);
    document.removeEventListener('touchmove', bound.touch);
    document.removeEventListener('contextmenu', bound.menu);
  }, [bound]);

  /* --- tracking ----------------------------------------------------------- */

  /**
   * Move the other rows out of the way. Only the rows whose slot actually
   * changed are re-animated, so they move one at a time as the row passes them
   * rather than all at once as a block (§8.5).
   */
  const applyTarget = useCallback((drag: Drag, target: number) => {
    if (target === drag.target) return;
    drag.target = target;

    const count = drag.slots.length;
    const order: number[] = [];
    for (let i = 0; i < count; i++) if (i !== drag.index) order.push(i);
    order.splice(target, 0, drag.index);

    const reduced = prefersReducedMotion();
    const flip = latest.current.group;

    for (let slot = 0; slot < count; slot++) {
      const from = order[slot];
      if (from === drag.index) continue;
      const key = drag.keys[from];
      const entry = flip?.entry(key);
      if (!entry) continue;

      const next = {
        x: drag.grid ? drag.slots[slot].left - drag.slots[from].left : 0,
        y: drag.slots[slot].top - drag.slots[from].top,
      };
      const current = drag.offsets.get(key);
      if (current && current.x === next.x && current.y === next.y) continue;
      drag.offsets.set(key, next);

      if (reduced) {
        entry.x.jump(next.x);
        entry.y.jump(next.y);
      } else {
        if (drag.grid) void animate(entry.x, next.x, DISPLACE);
        void animate(entry.y, next.y, DISPLACE);
      }
    }
  }, []);

  const track = useCallback(
    (clientX: number, clientY: number) => {
      const drag = dragRef.current;
      if (!drag) return;

      drag.clientX = clientX;
      drag.clientY = clientY;

      const docX = clientX + window.scrollX;
      const docY = clientY + window.scrollY;

      // 1:1 with the pointer, from wherever the row was grabbed. Nothing here
      // consults the row's centre, which is what "respects the grab offset"
      // means: the point under the finger at pointer-down stays under it.
      const rawY = drag.baseY + (docY - drag.startDocY);
      const rawX = drag.grid ? drag.baseX + (docX - drag.startDocX) : drag.baseX;

      const y = resist(rawY, drag.minY, drag.maxY);
      const x = drag.grid ? resist(rawX, drag.minX, drag.maxX) : drag.baseX;

      drag.entry.y.set(y);
      if (drag.grid) drag.entry.x.set(x);

      drag.samples.push({ t: performance.now(), x: docX, y: docY });
      if (drag.samples.length > 12) drag.samples.shift();

      setEdgeState(rawY > drag.maxY + 1 ? 'bottom' : rawY < drag.minY - 1 ? 'top' : 'none');

      const centreY = drag.origin.top + y + drag.origin.height / 2;
      const centreX = drag.origin.left + x + drag.origin.width / 2;
      applyTarget(drag, slotIndexFor(drag.slots, centreX, centreY, drag.grid));
    },
    [applyTarget, setEdgeState],
  );

  /* --- edge auto-scroll --------------------------------------------------- */

  const step = useCallback(
    (now: number) => {
      const drag = dragRef.current;
      if (!drag) return;

      const dt = Math.min(0.05, (now - drag.lastFrame) / 1000);
      drag.lastFrame = now;

      const fromTop = drag.clientY;
      const fromBottom = window.innerHeight - drag.clientY;
      let speed = 0;
      // Accelerating with proximity to the edge (§8.5) — squared, so the band
      // is gentle where the user is merely near it and quick at the very edge.
      if (fromTop < EDGE_BAND) speed = -EDGE_MAX_SPEED * ((EDGE_BAND - fromTop) / EDGE_BAND) ** 2;
      else if (fromBottom < EDGE_BAND)
        speed = EDGE_MAX_SPEED * ((EDGE_BAND - fromBottom) / EDGE_BAND) ** 2;

      if (speed !== 0) {
        const before = window.scrollY;
        window.scrollBy(0, speed * dt);
        // The row is pinned to the finger in *document* space, so a scroll has
        // to re-run tracking or the row slides away from the finger.
        if (window.scrollY !== before) track(drag.clientX, drag.clientY);
      }

      drag.raf = requestAnimationFrame(step);
    },
    [track],
  );

  /* --- gesture lifecycle -------------------------------------------------- */

  const cancelCandidate = useCallback(() => {
    const candidate = candidateRef.current;
    if (!candidate) return;
    if (candidate.timer !== null) window.clearTimeout(candidate.timer);
    candidateRef.current = null;
    if (dragRef.current === null) detach();
  }, [detach]);

  /**
   * `atX`/`atY` are where the pointer is *now*; the candidate's own coordinates
   * are where it went down. The gesture is anchored to the latter, so the few
   * pixels of slop that armed the drag are applied on the first frame instead
   * of being swallowed: the point the user grabbed stays the point under their
   * pointer, which is the whole of "respects the grab offset".
   */
  const beginDrag = useCallback((atX?: number, atY?: number) => {
    const candidate = candidateRef.current;
    const flip = latest.current.group;
    if (!candidate || !flip) return;
    if (candidate.timer !== null) window.clearTimeout(candidate.timer);
    candidateRef.current = null;

    const entry = flip.entry(candidate.key);
    if (!entry) return;

    const { items: currentItems, getKey: keyOf } = latest.current;
    const keys = currentItems.map(keyOf);
    const index = keys.indexOf(candidate.key);
    if (index === -1) return;

    // Every measurement is taken here, once. Reading geometry per frame would
    // both cost a reflow and be wrong, because the rows are being transformed.
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const slots: LayoutRect[] = [];
    for (const k of keys) {
      const other = flip.entry(k);
      if (!other) return;
      slots.push(layoutRectOf(other, scrollX, scrollY));
    }

    // Whatever the row is doing right now is where the drag starts from: a row
    // still settling from a previous release is picked up where it appears.
    entry.x.stop();
    entry.y.stop();
    entry.scale.stop();

    const origin = slots[index];
    const grid = slots.some((slot) => Math.abs(slot.left - origin.left) > 1);
    const first = slots[0];
    const last = slots[slots.length - 1];

    const drag: Drag = {
      key: candidate.key,
      index,
      pointerId: candidate.pointerId,
      el: candidate.el,
      entry,
      touch: candidate.touch,
      grid,
      keys,
      slots,
      origin,
      baseX: entry.x.get(),
      baseY: entry.y.get(),
      startDocX: candidate.clientX + scrollX,
      startDocY: candidate.clientY + scrollY,
      minX: Math.min(...slots.map((slot) => slot.left)) - origin.left,
      maxX: Math.max(...slots.map((slot) => slot.left + slot.width)) - origin.width - origin.left,
      minY: first.top - origin.top,
      maxY: last.top + last.height - origin.height - origin.top,
      target: index,
      offsets: new Map(),
      samples: [],
      clientX: candidate.clientX,
      clientY: candidate.clientY,
      raf: null,
      lastFrame: performance.now(),
    };
    dragRef.current = drag;

    // The layout cannot change while a row is dragged, only transforms can, so
    // the group holds its measurements until the release commit.
    flip.pause(true);

    candidate.el.style.zIndex = '2';
    candidate.el.style.willChange = 'transform';
    document.body.style.userSelect = 'none';

    // §8.5: on grab the row lifts — 1.02, 150ms, out-curve. Under reduced
    // motion the elevation still reads through the shadow; the scale does not.
    if (!prefersReducedMotion()) {
      void animate(entry.scale, LIFT_SCALE, { duration: LIFT_SECONDS, ease: OUT });
    }
    setDraggingKey(drag.key);

    try {
      // §8.5: pointer capture, so tracking survives the pointer leaving the
      // row's bounds — which it does within the first few pixels of a drag.
      candidate.el.setPointerCapture(drag.pointerId);
    } catch {
      // Capture can be refused if the pointer has already gone; the window
      // listeners are the fallback and the gesture still completes.
    }
    if (drag.touch) {
      document.addEventListener('touchmove', bound.touch, { passive: false });
      document.addEventListener('contextmenu', bound.menu);
    }
    window.addEventListener('keydown', bound.key);

    drag.raf = requestAnimationFrame(step);
    track(atX ?? drag.clientX, atY ?? drag.clientY);
  }, [bound, step, track]);

  const finish = useCallback(
    (cancelled: boolean) => {
      const drag = dragRef.current;
      const flip = latest.current.group;
      if (!drag || !flip) return;
      dragRef.current = null;

      if (drag.raf !== null) cancelAnimationFrame(drag.raf);
      detach();
      try {
        drag.el.releasePointerCapture(drag.pointerId);
      } catch {
        // Already released with the pointer itself.
      }
      document.body.style.userSelect = '';
      drag.el.style.zIndex = '';
      drag.el.style.willChange = '';
      setEdgeState('none');
      setDraggingKey(null);
      suppressClickRef.current = performance.now();

      const reduced = prefersReducedMotion();
      if (reduced) drag.entry.scale.jump(1);
      else void animate(drag.entry.scale, 1, { duration: LIFT_SECONDS, ease: OUT });

      const velocity = cancelled
        ? { x: 0, y: 0 }
        : velocityOf(drag.samples, performance.now());

      // §8.5: project where the gesture was going before choosing the landing
      // slot, so a flick throws the row further than its release point.
      const y = clamp(drag.entry.y.get() + velocity.y * PROJECTION, drag.minY, drag.maxY);
      const x = drag.grid
        ? clamp(drag.entry.x.get() + velocity.x * PROJECTION, drag.minX, drag.maxX)
        : 0;
      const target = cancelled
        ? drag.index
        : slotIndexFor(
            drag.slots,
            drag.origin.left + x + drag.origin.width / 2,
            drag.origin.top + y + drag.origin.height / 2,
            drag.grid,
          );

      flip.pause(false);

      const { items: currentItems, getKey: keyOf, onReorder: reorder } = latest.current;
      const moved = currentItems[drag.index];

      if (target === drag.index || !moved || keyOf(moved) !== drag.key) {
        // Nothing to persist: the layout does not change, so nothing else will
        // bring the row home. It settles from its live position carrying the
        // release velocity, so the gesture and the spring are one movement.
        if (reduced) {
          drag.entry.x.jump(0);
          drag.entry.y.jump(0);
        } else {
          void animate(drag.entry.x, 0, { ...SETTLE, velocity: velocity.x });
          void animate(drag.entry.y, 0, { ...SETTLE, velocity: velocity.y });
        }
        return;
      }

      // Hand the velocity to the commit's settle, then persist optimistically.
      // The re-render is what moves the row: FLIP re-references it from where
      // it appears now and springs it into its new slot (§7.3).
      flip.handOff(drag.key, velocity.x, velocity.y);
      const rest = currentItems.filter((_, i) => i !== drag.index);
      reorder(moved, rest[target - 1] ?? null, rest[target] ?? null);
    },
    [detach, setEdgeState],
  );

  gesture.current.move = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (drag) {
      // Additional touch points are ignored once a drag is underway (§8.5).
      if (event.pointerId !== drag.pointerId) return;
      track(event.clientX, event.clientY);
      return;
    }

    const candidate = candidateRef.current;
    if (!candidate || event.pointerId !== candidate.pointerId) return;

    const distance = Math.hypot(
      event.clientX - candidate.clientX,
      event.clientY - candidate.clientY,
    );
    if (candidate.touch) {
      // Movement before the press resolves means the user is scrolling, and a
      // scroll must never become a drag.
      if (distance > TOUCH_SLOP) cancelCandidate();
      return;
    }
    if (distance > POINTER_SLOP) beginDrag(event.clientX, event.clientY);
  };

  gesture.current.up = (event: PointerEvent) => {
    if (dragRef.current) {
      if (event.pointerId !== dragRef.current.pointerId) return;
      finish(false);
      return;
    }
    if (candidateRef.current?.pointerId === event.pointerId) cancelCandidate();
  };

  gesture.current.cancel = (event: PointerEvent) => {
    if (dragRef.current) {
      if (event.pointerId !== dragRef.current.pointerId) return;
      finish(true);
      return;
    }
    if (candidateRef.current?.pointerId === event.pointerId) cancelCandidate();
  };

  gesture.current.key = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && dragRef.current) finish(true);
  };

  function onPointerDown(event: ReactPointerEvent<HTMLLIElement>, key: string) {
    // Any new press ends the previous release's click guard. Without this a
    // drag would swallow a deliberate tap that lands within the guard window —
    // reordering a row and then immediately checking it is one gesture in the
    // user's head and must be two here.
    suppressClickRef.current = 0;

    if (latest.current.disabled) return;
    if (event.button !== 0) return;
    // One gesture at a time.
    if (dragRef.current || candidateRef.current) return;
    // The checkbox, and any other real control inside a row, is not a drag
    // handle — a long press on a 44px target should still be a press.
    if ((event.target as Element | null)?.closest('[data-no-drag]')) return;

    const touch = event.pointerType !== 'mouse';
    const candidate: Candidate = {
      key,
      pointerId: event.pointerId,
      el: event.currentTarget,
      clientX: event.clientX,
      clientY: event.clientY,
      touch,
      timer: null,
    };
    candidateRef.current = candidate;

    window.addEventListener('pointermove', bound.move);
    window.addEventListener('pointerup', bound.up);
    window.addEventListener('pointercancel', bound.cancel);

    if (touch) candidate.timer = window.setTimeout(beginDrag, LONG_PRESS_MS);
  }

  /**
   * The keyboard route to the same result. §5's accessibility floor is
   * "keyboard-operable throughout", and a list that can only be reordered by
   * dragging is not — so Alt+↑/↓ moves the focused row one slot. It runs
   * through the same `onReorder` as the gesture, and animates nothing, because
   * §8.5 gives keyboard-initiated actions no animation, ever.
   */
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;

    const { items: currentItems, onReorder: reorder, disabled: off, group: flip } = latest.current;
    if (off) return;
    const target = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (target < 0 || target >= currentItems.length) return;

    event.preventDefault();
    flip?.skipNext();
    const rest = currentItems.filter((_, i) => i !== index);
    reorder(currentItems[index], rest[target - 1] ?? null, rest[target] ?? null);
  }

  function onClickCapture(event: ReactMouseEvent) {
    // The click that follows a drag is the release, not a tap on the row.
    if (performance.now() - suppressClickRef.current > CLICK_GUARD_MS) return;
    suppressClickRef.current = 0;
    event.preventDefault();
    event.stopPropagation();
  }

  // A gesture that outlived its component would leave the page unselectable and
  // the touch scroll blocked; this is the only place either can be stranded.
  useEffect(() => {
    return () => {
      if (dragRef.current === null && candidateRef.current === null) return;
      if (dragRef.current?.raf != null) cancelAnimationFrame(dragRef.current.raf);
      if (candidateRef.current?.timer != null) window.clearTimeout(candidateRef.current.timer);
      dragRef.current = null;
      candidateRef.current = null;
      detach();
      document.body.style.userSelect = '';
      latest.current.group?.pause(false);
    };
  }, [detach]);

  return (
    <div className="relative">
      <ul className={className} {...rest}>
        {items.map((item, index) => {
          const key = getKey(item);
          const dragging = draggingKey === key;
          return (
            <ReorderableRow
              key={key}
              itemKey={key}
              className={itemClassName}
              liftRadius={liftRadius}
              dragging={dragging}
              onPointerDown={(event) => onPointerDown(event, key)}
              onKeyDown={(event) => onKeyDown(event, index)}
              onClickCapture={onClickCapture}
            >
              {children(item, { dragging, index })}
            </ReorderableRow>
          );
        })}
      </ul>

      {/* §8.5: the ends of the list, and the refusal. Opacity only, and the
          bottom rule takes the negative semantic when what lies below is the
          Completed group — a refused drop, not merely an end of the list. */}
      <Boundary at="top" visible={edge === 'top'} refused={false} />
      <Boundary at="bottom" visible={edge === 'bottom'} refused={refuseBelow} />
    </div>
  );
}

function Boundary({
  at,
  visible,
  refused,
}: {
  at: 'top' | 'bottom';
  visible: boolean;
  refused: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 block"
      style={{
        top: at === 'top' ? '-2px' : undefined,
        bottom: at === 'bottom' ? '-2px' : undefined,
        height: '2px',
        borderRadius: 'var(--radius-pill)',
        backgroundColor: refused ? 'var(--negative)' : 'var(--text-tertiary)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 150ms var(--ease-out)',
      }}
    />
  );
}

function ReorderableRow({
  itemKey,
  className,
  liftRadius,
  dragging,
  onPointerDown,
  onKeyDown,
  onClickCapture,
  children,
}: {
  itemKey: string;
  className: string | undefined;
  liftRadius: string;
  dragging: boolean;
  onPointerDown(event: ReactPointerEvent<HTMLLIElement>): void;
  onKeyDown(event: React.KeyboardEvent): void;
  onClickCapture(event: ReactMouseEvent): void;
  children: ReactNode;
}) {
  const ref = useFlipRef(itemKey);

  return (
    <li
      ref={ref}
      className={`relative ${className ?? ''}`}
      data-reorderable-row=""
      data-dragging={dragging ? '' : undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClickCapture={onClickCapture}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      onDragStart={(event) => event.preventDefault()}
      style={{
        // A drag surface is not a text-selection surface: without this, a long
        // press on iOS raises the selection magnifier instead of lifting the
        // row, and a mouse drag paints the list blue.
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        cursor: dragging ? 'grabbing' : undefined,
      }}
    >
      {/* The lift's elevation, as its own layer so it fades by opacity rather
          than by animating box-shadow. It carries the surface colour too, so a
          lifted row reads as sitting above its siblings, not through them. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 block"
        style={{
          zIndex: -1,
          borderRadius: liftRadius,
          backgroundColor: 'var(--surface)',
          boxShadow: 'var(--shadow-md)',
          opacity: dragging ? 1 : 0,
          transition: 'opacity 150ms var(--ease-out)',
        }}
      />
      {children}
    </li>
  );
}
