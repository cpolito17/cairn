/**
 * Drag scheduling, block moves, and the live resize — the Planner's pointer
 * primitive. PROJECT-SPEC-V2.md §6.7 (governing); PROJECT-SPEC.md §2, §5, §8.5.
 *
 * This is the **second** drag primitive, not an extension of `Reorderable`.
 * That one reorders a list: one dimension, one surface, one kind of outcome.
 * This one starts in the unscheduled list and lands on a grid — two surfaces —
 * places in two dimensions, snaps to a 15-minute lattice, and carries a resize
 * edge that changes a duration rather than a position. The two share their
 * *conventions* (`lib/gesture.ts`) and their springs (`lib/motion.ts`); they do
 * not share a lifecycle, because there is no honest way to write one that is
 * both without a mode flag on every other line.
 *
 * **The dragged thing is a proxy, and that is forced.** In `Reorderable` the row
 * itself is transformed, which is possible because the row never changes size or
 * leaves its list. Here a list row becomes a block of its duration's real height
 * the moment it is picked up (§6.7 — a 2-hour task is a 2-hour-tall object under
 * the finger, so the user is placing a real shape), and on a narrow viewport it
 * leaves a bottom sheet that closes behind it. So the gesture renders one fixed
 * layer element and moves *that* with a transform, while the element it stands
 * in for goes to `opacity: 0` — never `display: none`, which would relayout the
 * column it was in.
 *
 * **Nothing per-frame goes through React.** Transforms are written straight to
 * `style.transform` from MotionValue subscriptions, the same arrangement
 * `lib/flip.ts` uses and for the same reason: a value that reaches the DOM on
 * the next React commit is one frame of lag in the one interaction the release
 * is judged on. React is told only what changes at human speed — which task is
 * under the gesture, and which 15-minute slot the preview is showing.
 *
 * **The live resize is the hard case for §8.5's transform-and-opacity rule.**
 * A block growing under the finger cannot animate `height`; that is a defect,
 * and it is also the obvious implementation. So a resizing block is drawn as
 * three slices — a top cap, a middle, a bottom cap — and only the middle is
 * scaled, with the bottom cap translated by the delta. The caps keep their own
 * height, so the corner radius and the 1px top and bottom edges never stretch,
 * which is what a naive `scaleY` on the whole block gets visibly wrong. Nothing
 * in this file writes `height`, `width`, `top` or `left` after a gesture begins.
 *
 * Interruption falls out of the same arrangement as it does in `Reorderable`:
 * input is never locked, and a grab reads the proxy's *live* transform as its
 * starting offset — so a block picked up while it is still settling continues
 * from where it appears rather than from where it was headed. The settling
 * proxy is itself the press target, which is what makes that reachable at all.
 */

import { animate, motionValue, type MotionValue } from 'motion/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { crossesMidnight, effectiveMinutes, startOfLocalDay } from '../../../shared/schedule';
import {
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  SCHEDULE_STEP_MINUTES,
  type Task,
} from '../../../shared/types';
import {
  clamp,
  CLICK_GUARD_MS,
  edgeSpeed,
  LIFT_SCALE,
  LIFT_SECONDS,
  LONG_PRESS_MS,
  POINTER_SLOP,
  resist,
  sample,
  TOUCH_SLOP,
  velocityOf,
  type Sample,
} from '../../lib/gesture';
import { OUT, prefersReducedMotion, SETTLE } from '../../lib/motion';
import {
  resizeTaskSpec,
  scheduleTaskSpec,
  unscheduleTaskSpec,
  useStore,
  type MutationSpec,
} from '../../lib/store';
import { BlockFace, blockRange, blockSurface, LANE_GAP_PX } from './Block';
import { minutePixels } from './scale';

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;

/**
 * `--radius-chip` as a number, which the resize slices need and CSS cannot hand
 * them. Kept in step with the token by hand — the alternative is reading a
 * computed style per frame for a value that has not changed since first paint.
 */
const CAP_PX = 8;

/** What a gesture is doing. Three verbs, one pointer lifecycle. */
export type DragKind = 'create' | 'move' | 'resize';

/* --- what the grid tells the gesture about itself -------------------------- */

export interface GridRegistration {
  /** The box the columns scroll inside. Auto-scroll drives this, not the page. */
  scroller: HTMLElement;
  /** The row holding the axis and the day columns. Its top edge is minute zero. */
  content: HTMLElement;
  /** Local midnights of the columns on screen, in order. */
  days: number[];
}

/* --- the published state --------------------------------------------------- */

/** What the layer needs to draw the thing under the pointer. */
export interface ProxySpec {
  task: Task;
  kind: DragKind;
  /** The proxy's own box, in px. Set once per gesture; never animated. */
  width: number;
  height: number;
  /** Resize slices: cap height and the middle's unscaled height. */
  cap: number;
  middle: number;
}

/** The 15-minute slot the gesture is currently committing to, if any. */
export interface SlotSpec {
  startMs: number;
  minutes: number;
}

interface State {
  /** The task under a gesture or its settle — dimmed at source, drawn as proxy. */
  activeId: string | null;
  kind: DragKind | null;
  proxy: ProxySpec | null;
  slot: SlotSpec | null;
  /** True while the drag is over the unscheduled list, which unschedules. */
  overList: boolean;
}

const EMPTY: State = {
  activeId: null,
  kind: null,
  proxy: null,
  slot: null,
  overList: false,
};

/* --- the gesture ----------------------------------------------------------- */

interface Candidate {
  task: Task;
  kind: DragKind;
  pointerId: number;
  el: HTMLElement;
  clientX: number;
  clientY: number;
  touch: boolean;
  timer: number | null;
}

interface Frame {
  /** The row whose top edge is minute zero. Read live — see `minuteZero`. */
  content: HTMLElement;
  /** Viewport x of each day column's content box, and the shared column width. */
  columnLefts: number[];
  columnWidth: number;
  contentLeft: number;
  days: number[];
  scroller: HTMLElement;
  /** The sticky day header, which the top auto-scroll band must clear. */
  headerHeight: number;
}

interface Drag {
  kind: DragKind;
  task: Task;
  pointerId: number;
  touch: boolean;
  frame: Frame | null;
  /** Where the list is, so a block dropped on it unschedules (§6.7). */
  listRect: DOMRect | null;

  /* geometry of the thing under the finger */
  width: number;
  height: number;
  /** The pointer's offset inside the proxy at grab. This is the grab offset. */
  grabX: number;
  grabY: number;

  /* live pointer */
  clientX: number;
  clientY: number;
  samples: Sample[];
  raf: number | null;
  lastFrame: number;

  /* the resolved landing, recomputed every frame */
  dayIndex: number;
  startMinutes: number;
  overList: boolean;

  /* resize only */
  baseMinutes: number;
  maxMinutes: number;
  startMs: number;
  liveMinutes: number;
  /** Where the resize began, in viewport y. The delta is measured from here. */
  anchorY: number;
}

/**
 * One controller per Planner. It owns the pointer lifecycle, the layer's
 * transforms, and the small amount of state React is allowed to see.
 */
class Scheduler {
  /* --- subscribers -------------------------------------------------------- */

  private state: State = EMPTY;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): State => this.state;

  private publish(next: Partial<State>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /* --- registrations ------------------------------------------------------ */

  private grid: GridRegistration | null = null;
  private list: HTMLElement | null = null;
  private preview: HTMLElement | null = null;
  /** Called when a drag leaves a surface that has to get out of its way — the
   *  narrow viewport's bottom sheet, which is covering the grid it is aimed at. */
  onDragOut: (() => void) | null = null;

  registerGrid(grid: GridRegistration | null): void {
    this.grid = grid;
  }

  registerList(el: HTMLElement | null): void {
    this.list = el;
  }

  registerPreview(el: HTMLElement | null): void {
    this.preview = el;
  }

  /* --- the layer's elements ----------------------------------------------- */

  private proxyEl: HTMLElement | null = null;
  private middleEl: HTMLElement | null = null;
  private bottomEl: HTMLElement | null = null;

  private x = motionValue(0);
  private y = motionValue(0);
  private sx = motionValue(1);
  private sy = motionValue(1);
  private lift = motionValue(1);
  /** The resize slices' scale, kept apart from the proxy's own transform. */
  private stretch = motionValue(1);
  private grow = motionValue(0);

  constructor() {
    const write = () => this.writeProxy();
    this.x.on('change', write);
    this.y.on('change', write);
    this.sx.on('change', write);
    this.sy.on('change', write);
    this.lift.on('change', write);
    const writeSlices = () => this.writeSlices();
    this.stretch.on('change', writeSlices);
    this.grow.on('change', writeSlices);
  }

  attachProxy = (el: HTMLElement | null): void => {
    this.proxyEl = el;
    if (el) this.writeProxy();
  };

  attachSlices = (middle: HTMLElement | null, bottom: HTMLElement | null): void => {
    this.middleEl = middle;
    this.bottomEl = bottom;
    if (middle || bottom) this.writeSlices();
  };

  private writeProxy(): void {
    const el = this.proxyEl;
    if (el === null) return;
    const scaleX = this.sx.get() * this.lift.get();
    const scaleY = this.sy.get() * this.lift.get();
    el.style.transform =
      `translate3d(${this.x.get()}px, ${this.y.get()}px, 0) scale(${scaleX}, ${scaleY})`;
  }

  private writeSlices(): void {
    if (this.middleEl) this.middleEl.style.transform = `scaleY(${this.stretch.get()})`;
    if (this.bottomEl) this.bottomEl.style.transform = `translate3d(0, ${this.grow.get()}px, 0)`;
  }

  /* --- gesture state ------------------------------------------------------ */

  private candidate: Candidate | null = null;
  private drag: Drag | null = null;
  /**
   * Set at release; a click landing inside the guard is that release, not a tap.
   *
   * `-Infinity` rather than `0`, and the difference is a bug: `performance.now()`
   * counts from the document, so for the first 400ms of every page load `now - 0`
   * is *inside* the guard, and a tap on a block in that window is swallowed as
   * the tail of a drag that never happened.
   */
  private released = Number.NEGATIVE_INFINITY;
  /** Where the proxy last was, for a failed write's return flight. */
  private landed: DOMRect | null = null;
  private failed = false;
  private flight = 0;

  /** True when a click on `taskId` is really the tail of a drag (§8.5). */
  swallowsClick(taskId: string): boolean {
    if (this.state.activeId === taskId) return true;
    return performance.now() - this.released < CLICK_GUARD_MS;
  }

  /* --- window plumbing ---------------------------------------------------- */

  private bound = {
    move: (event: PointerEvent) => this.onMove(event),
    up: (event: PointerEvent) => this.onUp(event),
    cancel: (event: PointerEvent) => this.onCancel(event),
    key: (event: KeyboardEvent) => {
      // §6.7: Escape cancels an in-flight drag and returns the item to the list.
      if (event.key === 'Escape' && this.drag !== null) {
        event.preventDefault();
        this.finish(true);
      }
    },
    // Non-passive and only while a drag is underway: this is what stops iOS
    // Safari from turning the gesture into a scroll of the grid or of the
    // sheet the row came out of. Until the long-press resolves the browser is
    // left alone and a swipe scrolls normally.
    touch: (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    },
    menu: (event: Event) => event.preventDefault(),
  };

  private attach(): void {
    window.addEventListener('pointermove', this.bound.move);
    window.addEventListener('pointerup', this.bound.up);
    window.addEventListener('pointercancel', this.bound.cancel);
  }

  private detach(): void {
    window.removeEventListener('pointermove', this.bound.move);
    window.removeEventListener('pointerup', this.bound.up);
    window.removeEventListener('pointercancel', this.bound.cancel);
    window.removeEventListener('keydown', this.bound.key);
    document.removeEventListener('touchmove', this.bound.touch);
    document.removeEventListener('contextmenu', this.bound.menu);
  }

  /* --- initiation --------------------------------------------------------- */

  /**
   * A press that may become a gesture. Initiation matches the existing
   * primitive exactly (§6.7): ~6px on a fine pointer, a 200ms long-press with
   * ~10px of slop on touch.
   */
  press(event: ReactPointerEvent, task: Task, kind: DragKind): void {
    if (event.button !== 0) return;
    // One gesture at a time; additional touch points are ignored (§8.5).
    if (this.drag !== null || this.candidate !== null) return;

    const touch = event.pointerType !== 'mouse';
    this.candidate = {
      task,
      kind,
      pointerId: event.pointerId,
      el: event.currentTarget as HTMLElement,
      clientX: event.clientX,
      clientY: event.clientY,
      touch,
      timer: null,
    };

    this.attach();
    // The resize edge is a deliberate grab on a small target, not something a
    // scroll can wander into, so it begins on contact rather than on a press.
    if (kind === 'resize') this.begin();
    else if (touch) this.candidate.timer = window.setTimeout(() => this.begin(), LONG_PRESS_MS);
  }

  /**
   * Pick a settling proxy back up. §8.5's interruptibility, at the one place it
   * is reachable: the proxy is the only thing on screen during a settle, so it
   * is the thing that has to accept the next press.
   */
  regrab(event: ReactPointerEvent): void {
    const spec = this.state.proxy;
    if (spec === null || this.drag !== null || spec.kind === 'resize') return;
    if (this.failed) return;

    event.preventDefault();
    this.stopFlight();

    // Whatever the proxy is doing right now is where the new drag starts from.
    // Taken from the values rather than from the DOM: the proxy scales about
    // its top-left through a flight, so a measured rect would have to be
    // un-scaled about the wrong origin, and a re-grab would kick a pixel or two
    // against the finger at the exact moment it is meant to feel continuous.
    const resumed = {
      liveX: this.x.get(),
      liveY: this.y.get(),
      width: spec.width,
      height: spec.height,
    };
    this.sx.jump(1);
    this.sy.jump(1);

    this.candidate = {
      task: spec.task,
      kind: spec.kind,
      pointerId: event.pointerId,
      el: event.currentTarget as HTMLElement,
      clientX: event.clientX,
      clientY: event.clientY,
      touch: event.pointerType !== 'mouse',
      timer: null,
    };
    this.attach();
    this.begin(resumed);
  }

  private cancelCandidate(): void {
    if (this.candidate === null) return;
    if (this.candidate.timer !== null) window.clearTimeout(this.candidate.timer);
    this.candidate = null;
    if (this.drag === null) this.detach();
  }

  /**
   * Start tracking. Every measurement the gesture needs is taken here, once:
   * reading geometry per frame would cost a reflow and would be wrong anyway,
   * because the things being measured are the things being transformed.
   */
  private begin(
    resumed?: { liveX: number; liveY: number; width: number; height: number },
    atX?: number,
    atY?: number,
  ): void {
    const candidate = this.candidate;
    if (candidate === null) return;
    if (candidate.timer !== null) window.clearTimeout(candidate.timer);
    this.candidate = null;

    const { task, kind } = candidate;
    const ppm = minutePixels();
    const frame = this.measureFrame();

    // The block's length under the finger: its committed duration, or the
    // 30-minute default a scheduled task with no duration renders at (§3.1).
    const minutes = effectiveMinutes(task);

    // The resize's press lands on the handle, but the shape the gesture works
    // on is the block the handle belongs to.
    const source =
      kind === 'resize'
        ? document.querySelector<HTMLElement>(`[data-block-id="${cssEscape(task.id)}"]`) ??
          candidate.el
        : candidate.el;
    const origin = resumed
      ? new DOMRect(resumed.liveX, resumed.liveY, resumed.width, resumed.height)
      : layoutRectOfPressed(source);
    let width: number;
    let height: number;
    let grabX: number;
    let grabY: number;

    if (kind === 'create') {
      // §6.7: the item takes the height its duration implies the moment it
      // leaves the list. The width it takes is the column it is headed for, so
      // what is under the finger is the shape that will be on the grid.
      width = frame ? frame.columnWidth - LANE_GAP_PX * 2 : origin.width;
      height = minutes * ppm;
      // The vertical grab offset is kept in *pixels* — the top of the block
      // stays exactly as far above the finger as the top of the row was — while
      // the horizontal one is kept in proportion, because a 300px row and a
      // 90px column have no shared absolute offset worth preserving.
      grabY = clamp(candidate.clientY - origin.top, 0, height);
      grabX = origin.width > 0 ? ((candidate.clientX - origin.left) / origin.width) * width : width / 2;
    } else {
      width = origin.width;
      height = origin.height;
      grabX = candidate.clientX - origin.left;
      grabY = candidate.clientY - origin.top;
    }

    const startMs = task.scheduledAt ?? 0;
    const startMinutes =
      task.scheduledAt === null
        ? 0
        : (task.scheduledAt - startOfLocalDay(task.scheduledAt)) / MINUTE_MS;

    const drag: Drag = {
      kind,
      task,
      pointerId: candidate.pointerId,
      touch: candidate.touch,
      frame,
      listRect: this.list ? this.list.getBoundingClientRect() : null,
      width,
      height,
      grabX,
      grabY,
      clientX: candidate.clientX,
      clientY: candidate.clientY,
      samples: [],
      raf: null,
      lastFrame: performance.now(),
      dayIndex: 0,
      startMinutes: 0,
      overList: false,
      baseMinutes: minutes,
      // §6.7: a resize may not take the block across midnight or outside
      // [15, 720]. Both bounds are enforced here rather than at the write, so
      // the shape under the finger is never one the Worker would refuse.
      maxMinutes: Math.min(MAX_DURATION_MINUTES, MINUTES_PER_DAY - startMinutes),
      startMs,
      liveMinutes: minutes,
      anchorY: candidate.clientY,
    };
    this.drag = drag;

    // The proxy has to exist *before* the browser paints this frame, or the
    // item blinks out of the list and back in one frame later. A synchronous
    // flush inside a pointer handler is the only way to get an element out of
    // React in the same tick, and it is what keeps the whole visual in one
    // component rather than in a second, hand-built copy of `Block`.
    const cap = Math.min(CAP_PX, Math.floor((MIN_DURATION_MINUTES * ppm) / 2));
    flushSync(() => {
      this.publish({
        activeId: task.id,
        kind,
        proxy: {
          task,
          kind,
          width,
          height,
          cap,
          middle: Math.max(1, height - cap * 2),
        },
        slot: null,
        overList: false,
      });
    });

    this.x.jump(resumed ? resumed.liveX : origin.left);
    this.y.jump(resumed ? resumed.liveY : origin.top);
    this.sx.jump(1);
    this.sy.jump(1);
    this.stretch.jump(1);
    this.grow.jump(0);

    // §8.5: on grab the thing lifts — 1.02, 150ms, out-curve. Under reduced
    // motion the elevation still reads through the shadow; the scale does not.
    if (prefersReducedMotion() || kind === 'resize') this.lift.jump(1);
    else void animate(this.lift, LIFT_SCALE, { duration: LIFT_SECONDS, ease: OUT });

    if (this.proxyEl) {
      try {
        // §8.5: pointer capture, so tracking survives the pointer leaving the
        // element it started on — which here it does immediately and by design,
        // since the whole gesture is about crossing from one surface to another.
        this.proxyEl.setPointerCapture(drag.pointerId);
      } catch {
        // Capture can be refused if the pointer has already gone; the window
        // listeners are the fallback and the gesture still completes.
      }
    }

    document.body.style.userSelect = 'none';
    if (drag.touch) {
      document.addEventListener('touchmove', this.bound.touch, { passive: false });
      document.addEventListener('contextmenu', this.bound.menu);
    }
    window.addEventListener('keydown', this.bound.key);

    // The list is on top of the grid on a narrow viewport, and the grid is
    // where this gesture is going. Ask it to get out of the way.
    if (kind === 'create') this.onDragOut?.();

    this.sizePreview(drag);
    drag.raf = requestAnimationFrame((now) => this.step(now));
    this.track(atX ?? drag.clientX, atY ?? drag.clientY);
  }

  private measureFrame(): Frame | null {
    const grid = this.grid;
    if (grid === null) return null;

    const content = grid.content.getBoundingClientRect();
    const columns = Array.from(
      grid.content.querySelectorAll<HTMLElement>('[data-day-column]'),
    ).map((el) => el.getBoundingClientRect());
    if (columns.length === 0) return null;

    const header = grid.scroller.querySelector<HTMLElement>('[data-day-header]');

    return {
      content: grid.content,
      columnLefts: columns.map((rect) => rect.left),
      columnWidth: columns[0].width,
      contentLeft: content.left,
      days: grid.days,
      scroller: grid.scroller,
      headerHeight: header ? header.getBoundingClientRect().height : 0,
    };
  }

  /* --- tracking ----------------------------------------------------------- */

  /** The previewed slot's box: one column wide, the dragged duration tall. */
  private sizePreview(drag: Drag): void {
    const el = this.preview;
    const frame = drag.frame;
    if (el === null || frame === null) return;
    el.style.width = `${frame.columnWidth - LANE_GAP_PX * 2}px`;
    el.style.height = `${effectiveMinutes(drag.task) * minutePixels()}px`;
  }

  /**
   * Viewport y of minute zero, right now.
   *
   * Read rather than remembered-and-corrected. The obvious version caches the
   * top at grab and subtracts however far the grid has auto-scrolled since,
   * which is right until anything *else* moves the grid — the page scrolling
   * under a wheel, the narrow viewport's sheet closing and giving the body its
   * scrollbar back, a font finishing loading. Each of those silently puts every
   * snap out by the same amount for the rest of the gesture. One rect read a
   * frame, on an element already being touched, costs less than being wrong.
   */
  private minuteZero(frame: Frame): number {
    return frame.content.getBoundingClientRect().top;
  }

  private track(clientX: number, clientY: number): void {
    const drag = this.drag;
    if (drag === null) return;

    drag.clientX = clientX;
    drag.clientY = clientY;
    sample(drag.samples, clientX, clientY);

    if (drag.kind === 'resize') {
      this.trackResize(drag);
      return;
    }

    // 1:1 with the pointer, from wherever it was grabbed. Nothing here consults
    // the proxy's centre, which is the whole of "respects the grab offset": the
    // point under the finger at pointer-down stays under it.
    this.x.set(clientX - drag.grabX);
    this.y.set(clientY - drag.grabY);

    const overList =
      drag.listRect !== null &&
      clientX >= drag.listRect.left &&
      clientX <= drag.listRect.right &&
      clientY >= drag.listRect.top &&
      clientY <= drag.listRect.bottom;

    const landing = this.landingFor(drag, clientX - drag.grabX, clientY - drag.grabY);
    drag.dayIndex = landing.dayIndex;
    drag.startMinutes = landing.startMinutes;
    drag.overList = overList;

    this.showPreview(drag, !overList && landing.onGrid);
  }

  /**
   * The 15-minute slot a proxy at (`left`, `top`) would land in. The day comes
   * from the column nearest the pointer, the minute from the proxy's own top
   * edge — which is what makes the preview line up with the shape rather than
   * with the finger.
   */
  private landingFor(
    drag: Drag,
    left: number,
    top: number,
  ): { dayIndex: number; startMinutes: number; onGrid: boolean } {
    const frame = drag.frame;
    if (frame === null) return { dayIndex: 0, startMinutes: 0, onGrid: false };

    const ppm = minutePixels();
    const centre = left + drag.width / 2;
    let dayIndex = 0;
    let best = Infinity;
    for (let i = 0; i < frame.columnLefts.length; i++) {
      const distance = Math.abs(centre - (frame.columnLefts[i] + frame.columnWidth / 2));
      if (distance < best) {
        best = distance;
        dayIndex = i;
      }
    }

    const raw = (top - this.minuteZero(frame)) / ppm;
    const minutes = effectiveMinutes(drag.task);
    const startMinutes = clamp(
      Math.round(raw / SCHEDULE_STEP_MINUTES) * SCHEDULE_STEP_MINUTES,
      0,
      MINUTES_PER_DAY - minutes,
    );

    return { dayIndex, startMinutes, ...this.onGrid(drag) };
  }

  /**
   * Whether the drop is aimed at the grid at all. About the pointer, not the
   * shape: a proxy hanging half out of the scroll box is still being aimed at
   * the column under the finger.
   */
  private onGrid(drag: Drag): { onGrid: boolean } {
    const frame = drag.frame;
    if (frame === null) return { onGrid: false };
    const box = frame.scroller.getBoundingClientRect();
    return {
      onGrid:
        drag.clientX >= box.left &&
        drag.clientX <= box.right &&
        drag.clientY >= box.top &&
        drag.clientY <= box.bottom,
    };
  }

  /**
   * §6.7: the snapped slot is previewed under the drag at reduced opacity as
   * the pointer moves, so the commitment is visible before it is made.
   *
   * Per frame this writes a transform and an opacity, and nothing else. The box
   * is `sizePreview`'s, set once when the gesture starts: a width and a height
   * rewritten every frame would be a layout property driven by hand, which §8.5
   * calls a defect even in the frames where the value happens not to change.
   */
  private showPreview(drag: Drag, visible: boolean): void {
    const el = this.preview;
    const frame = drag.frame;
    if (el === null || frame === null) return;

    if (!visible) {
      el.style.opacity = '0';
      if (this.state.slot !== null) this.publish({ slot: null, overList: drag.overList });
      else if (this.state.overList !== drag.overList) this.publish({ overList: drag.overList });
      return;
    }

    const ppm = minutePixels();
    el.style.transform =
      `translate3d(${frame.columnLefts[drag.dayIndex] - frame.contentLeft + LANE_GAP_PX}px,` +
      ` ${drag.startMinutes * ppm}px, 0)`;
    el.style.opacity = '1';

    const startMs = frame.days[drag.dayIndex] + drag.startMinutes * MINUTE_MS;
    const slot = this.state.slot;
    // React hears about the slot at human speed — when the 15-minute answer
    // changes — never per frame.
    if (slot === null || slot.startMs !== startMs) {
      this.publish({ slot: { startMs, minutes: effectiveMinutes(drag.task) }, overList: false });
    } else if (this.state.overList) {
      this.publish({ overList: false });
    }
  }

  /**
   * The resize. The duration steps in 15-minute increments live, and the shape
   * follows it 1:1 — until a bound, where the give is continuous and
   * progressive rather than a dead stop (§6.7). What is committed is always the
   * clamped, snapped value; the rubber-band is what the hand feels on the way
   * to being told no.
   */
  private trackResize(drag: Drag): void {
    const ppm = minutePixels();
    const basePx = drag.baseMinutes * ppm;
    const minPx = MIN_DURATION_MINUTES * ppm;
    const maxPx = drag.maxMinutes * ppm;
    const rawPx = basePx + (drag.clientY - drag.anchorY);

    const snappedMinutes = clamp(
      Math.round(rawPx / ppm / SCHEDULE_STEP_MINUTES) * SCHEDULE_STEP_MINUTES,
      MIN_DURATION_MINUTES,
      drag.maxMinutes,
    );
    const visualPx =
      rawPx < minPx || rawPx > maxPx ? resist(rawPx, minPx, maxPx) : snappedMinutes * ppm;

    this.setResizeShape(drag, visualPx);

    if (drag.liveMinutes !== snappedMinutes) {
      drag.liveMinutes = snappedMinutes;
      this.publish({ slot: { startMs: drag.startMs, minutes: snappedMinutes } });
    }
  }

  /** Height by transform: the middle stretches, the bottom cap travels. */
  private setResizeShape(drag: Drag, px: number): void {
    const spec = this.state.proxy;
    if (spec === null) return;
    this.stretch.set(Math.max(0, (px - spec.cap * 2) / spec.middle));
    this.grow.set(px - drag.height);
  }

  /* --- edge auto-scroll ---------------------------------------------------- */

  private step(now: number): void {
    const drag = this.drag;
    if (drag === null) return;

    const dt = Math.min(0.05, (now - drag.lastFrame) / 1000);
    drag.lastFrame = now;

    // Re-read once a frame rather than once a gesture: on a narrow viewport the
    // list is a sheet that closes the moment a drag leaves it, and a rect
    // captured at grab would go on refusing drops over the grid it used to
    // cover. `null` once it has gone is exactly right — there is nothing to
    // drop onto and nothing to unschedule against.
    drag.listRect = this.list ? this.list.getBoundingClientRect() : null;

    const frame = drag.frame;
    if (frame !== null) {
      // §6.7: auto-scroll near the vertical edges *of the grid*, accelerating
      // with proximity — the same band and the same curve `Reorderable` uses at
      // the viewport edges. Measured below the sticky header, which is not grid.
      const box = frame.scroller.getBoundingClientRect();
      const top = box.top + frame.headerHeight;
      const speed = edgeSpeed(drag.clientY - top, box.bottom - top);
      if (speed !== 0 && drag.clientX >= box.left - 40 && drag.clientX <= box.right + 40) {
        const before = frame.scroller.scrollTop;
        frame.scroller.scrollTop = before + speed * dt;
        // The proxy is pinned to the finger in *viewport* space, so a scroll
        // moves the grid under it and the landing has to be recomputed.
        if (frame.scroller.scrollTop !== before) this.track(drag.clientX, drag.clientY);
      }
    }

    drag.raf = requestAnimationFrame((next) => this.step(next));
  }

  /* --- the pointer lifecycle ---------------------------------------------- */

  private onMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag !== null) {
      // Additional touch points are ignored once a drag is underway (§8.5).
      if (event.pointerId !== drag.pointerId) return;
      this.track(event.clientX, event.clientY);
      return;
    }

    const candidate = this.candidate;
    if (candidate === null || event.pointerId !== candidate.pointerId) return;

    const distance = Math.hypot(
      event.clientX - candidate.clientX,
      event.clientY - candidate.clientY,
    );
    if (candidate.touch) {
      // Movement before the press resolves means the user is scrolling, and a
      // scroll must never become a drag.
      if (distance > TOUCH_SLOP) this.cancelCandidate();
      return;
    }
    // Anchored to where the pointer went *down*, not to where it is now, so the
    // few pixels of slop that armed the drag are applied on the first frame
    // instead of being swallowed. The point the user grabbed stays the point
    // under their pointer — the same anchoring `Reorderable` does, and the whole
    // of "respects the grab offset".
    if (distance > POINTER_SLOP) this.begin(undefined, event.clientX, event.clientY);
  }

  private onUp(event: PointerEvent): void {
    if (this.drag !== null) {
      if (event.pointerId !== this.drag.pointerId) return;
      this.finish(false);
      return;
    }
    if (this.candidate?.pointerId === event.pointerId) this.cancelCandidate();
  }

  private onCancel(event: PointerEvent): void {
    if (this.drag !== null) {
      if (event.pointerId !== this.drag.pointerId) return;
      this.finish(true);
      return;
    }
    if (this.candidate?.pointerId === event.pointerId) this.cancelCandidate();
  }

  private finish(cancelled: boolean): void {
    const drag = this.drag;
    if (drag === null) return;
    this.drag = null;

    if (drag.raf !== null) cancelAnimationFrame(drag.raf);
    this.detach();
    document.body.style.userSelect = '';
    this.released = performance.now();
    if (this.preview) this.preview.style.opacity = '0';

    try {
      this.proxyEl?.releasePointerCapture(drag.pointerId);
    } catch {
      // Already released with the pointer itself.
    }

    const reduced = prefersReducedMotion();
    if (reduced) this.lift.jump(1);
    else void animate(this.lift, 1, { duration: LIFT_SECONDS, ease: OUT });

    if (drag.kind === 'resize') {
      this.finishResize(drag, cancelled, reduced);
      return;
    }

    const velocity = cancelled ? { x: 0, y: 0 } : velocityOf(drag.samples, performance.now());

    /*
     * The landing is the slot the preview was showing, and nothing else.
     *
     * §8.5 says to project where a gesture was going before choosing where it
     * lands, and `Reorderable` does exactly that — a flicked row is thrown
     * further than its release point. That rule cannot apply here, and the
     * reason is the preview. A reordering row shows no promise about where it
     * will end up, so projecting it is a free improvement; a dragged block has
     * been drawing its destination under itself the whole way down, and §6.7's
     * acceptance is "the block lands where the preview was". Throwing it a slot
     * past the rectangle it just promised is not momentum, it is a lie.
     *
     * The velocity is not discarded — it goes where it belongs, into the settle
     * (`fly`), so the gesture and the animation are still one movement.
     */
    const landing = { dayIndex: drag.dayIndex, startMinutes: drag.startMinutes, ...this.onGrid(drag) };

    if (cancelled || (!landing.onGrid && !drag.overList)) {
      this.flyHome(drag, velocity, reduced);
      return;
    }

    if (drag.overList) {
      // §6.7: dragging a block back onto the task list clears `scheduledAt`.
      // A row that never left the list has nothing to clear.
      if (drag.kind === 'create' || drag.task.scheduledAt === null) {
        this.flyHome(drag, velocity, reduced);
        return;
      }
      this.commit(drag, unscheduleTaskSpec(drag.task), null, velocity, reduced);
      return;
    }

    const frame = drag.frame;
    if (frame === null) {
      this.flyHome(drag, velocity, reduced);
      return;
    }

    const startMs = frame.days[landing.dayIndex] + landing.startMinutes * MINUTE_MS;
    if (startMs === drag.task.scheduledAt) {
      // Nothing to persist — but the proxy is still where the finger left it,
      // so it settles into the slot it is already in rather than vanishing.
      this.commit(
        drag,
        null,
        {
          left: frame.columnLefts[landing.dayIndex] + LANE_GAP_PX,
          top: this.minuteZero(frame) + landing.startMinutes * minutePixels(),
        },
        velocity,
        reduced,
      );
      return;
    }

    this.commit(
      drag,
      scheduleTaskSpec(drag.task, startMs),
      {
        left: frame.columnLefts[landing.dayIndex] + LANE_GAP_PX,
        top: this.minuteZero(frame) + landing.startMinutes * minutePixels(),
      },
      velocity,
      reduced,
    );
  }

  /**
   * The write, and the settle that carries the release velocity into it. The
   * block is in the store before this returns — §6.7's "written optimistically"
   * — and the proxy is what the eye follows into the slot, so there is no seam
   * between the gesture and the animation.
   */
  private commit(
    drag: Drag,
    spec: MutationSpec<Task> | null,
    target: { left: number; top: number } | null,
    velocity: { x: number; y: number },
    reduced: boolean,
  ): void {
    this.failed = false;

    if (spec !== null) {
      void useStore
        .getState()
        .mutate(spec)
        .then((ok) => {
          if (ok) return;
          // §6.7: a failed write animates the item back to the list rather than
          // snapping it. If the settle is still running the failure waits for
          // it — one movement out, one movement back, never both at once.
          this.failed = true;
          if (this.flight === 0) this.returnFlight(drag.task);
        });
    }

    if (target === null) {
      // Unscheduled: the destination is the row the task is about to occupy in
      // the list, which does not exist until the commit renders. Measure it on
      // the next frame; until then the proxy holds still where it was released.
      this.flyToElement(drag, `[data-unscheduled-row="${cssEscape(drag.task.id)}"]`, velocity, reduced);
      return;
    }

    this.fly(
      drag,
      { left: target.left, top: target.top, width: drag.width, height: drag.height },
      velocity,
      reduced,
    );
    // Lane packing may have narrowed the block; re-aim once it has rendered.
    requestAnimationFrame(() => this.retarget(drag, `[data-block-id="${cssEscape(drag.task.id)}"]`));
  }

  /** Cancelled, or dropped nowhere: back where it came from, nothing written. */
  private flyHome(drag: Drag, velocity: { x: number; y: number }, reduced: boolean): void {
    const selector =
      drag.kind === 'create'
        ? `[data-unscheduled-row="${cssEscape(drag.task.id)}"]`
        : `[data-block-id="${cssEscape(drag.task.id)}"]`;
    this.flyToElement(drag, selector, velocity, reduced);
  }

  private flyToElement(
    drag: Drag,
    selector: string,
    velocity: { x: number; y: number },
    reduced: boolean,
  ): void {
    const found = document.querySelector<HTMLElement>(selector);
    if (found !== null) {
      this.fly(drag, found.getBoundingClientRect(), velocity, reduced);
      return;
    }
    // The destination is not on screen — the narrow viewport's list is behind a
    // closed sheet, or the row has not rendered yet. Settle where it is and let
    // it go; there is nothing to travel to and a jump to nowhere is worse.
    this.fly(drag, null, velocity, reduced);
    requestAnimationFrame(() => this.retarget(drag, selector));
  }

  /**
   * Spring the proxy onto `rect`, then hand the real element back.
   *
   * Position *and* size, both by transform: the proxy keeps the box it was
   * given at grab and reaches a differently-sized destination by scaling from
   * its own top-left. That is the FLIP arrangement `lib/flip.ts` performs for
   * rows — invert, then release — applied to a layer element instead of a
   * re-rendered one, which is the part `flip.ts` cannot do, since its whole
   * design is one key, one element, one size.
   */
  private fly(
    drag: Drag,
    rect: { left: number; top: number; width: number; height: number } | null,
    velocity: { x: number; y: number },
    reduced: boolean,
  ): void {
    if (rect === null) {
      // Nowhere to travel to — the destination is off screen, or behind a sheet
      // that has closed. It settles where it is rather than jumping to nothing.
      this.land(reduced ? null : this.lift, drag.task);
      return;
    }

    const target = this.targetsFor(drag, rect);

    if (reduced) {
      // Gentler, not zero (§8.5): it lands where it belongs without travelling.
      this.x.jump(target.x);
      this.y.jump(target.y);
      this.sx.jump(target.sx);
      this.sy.jump(target.sy);
      this.finishFlight(drag.task);
      return;
    }

    // The release velocity, handed straight into the settle, is the seam
    // removal §8.5 asks for: the spring starts at the speed the finger left.
    void animate(this.x, target.x, { ...SETTLE, velocity: velocity.x });
    void animate(this.y, target.y, { ...SETTLE, velocity: velocity.y });
    void animate(this.sx, target.sx, SETTLE);
    void animate(this.sy, target.sy, SETTLE);
    this.land(this.x, drag.task);
  }

  private targetsFor(
    box: { width: number; height: number },
    rect: { left: number; top: number; width: number; height: number },
  ) {
    return {
      x: rect.left,
      y: rect.top,
      sx: box.width > 0 ? rect.width / box.width : 1,
      sy: box.height > 0 ? rect.height / box.height : 1,
    };
  }

  /**
   * Watch the flight rather than await it.
   *
   * The obvious version counts four animation promises, and it is wrong here:
   * `retarget` re-aims those same values a frame later — a block that landed in
   * a two-lane cluster is narrower than the proxy assumed — and re-animating a
   * MotionValue discards the animation whose promise the count was waiting on.
   * The count then never reaches zero, the proxy is never taken away, and the
   * real block stays invisible underneath it. Asking the values whether they
   * are still moving cannot be broken by re-aiming them, because re-aiming is
   * one of the things it is asking about.
   */
  private land(watch: MotionValue<number> | null, task: Task): void {
    const id = ++this.flight;
    if (watch === null) {
      this.finishFlight(task);
      return;
    }
    const tick = () => {
      if (this.flight !== id) return;
      const moving =
        this.x.isAnimating() || this.y.isAnimating() || this.sx.isAnimating() ||
        this.sy.isAnimating() || (watch === this.lift && this.lift.isAnimating());
      if (moving) {
        requestAnimationFrame(tick);
        return;
      }
      this.finishFlight(task);
    };
    requestAnimationFrame(tick);
  }

  /** The end of a flight: hand the real element back, or turn around. */
  private finishFlight(task: Task): void {
    this.flight = 0;
    this.landed = this.proxyEl?.getBoundingClientRect() ?? null;
    if (this.failed) {
      this.returnFlight(task);
      return;
    }
    this.clear();
  }

  /** Re-aim a flight at an element that has only now rendered. */
  private retarget(drag: Drag, selector: string): void {
    if (this.flight === 0 || this.drag !== null) return;
    const found = document.querySelector<HTMLElement>(selector);
    if (found === null) return;
    // Motion retargets from the value's live position and velocity, so this
    // bends the flight rather than restarting it.
    const target = this.targetsFor(drag, found.getBoundingClientRect());
    void animate(this.x, target.x, SETTLE);
    void animate(this.y, target.y, SETTLE);
    void animate(this.sx, target.sx, SETTLE);
    void animate(this.sy, target.sy, SETTLE);
  }

  private stopFlight(): void {
    this.flight = 0;
    this.x.stop();
    this.y.stop();
    this.sx.stop();
    this.sy.stop();
    this.lift.stop();
  }

  /**
   * The write failed and the store has rolled back. The item is where the eye
   * last saw it, and it travels from there to wherever it now belongs — §6.7's
   * "animates it back to the list rather than snapping it". The retryable toast
   * is `mutate`'s, raised the moment the request came back.
   */
  private returnFlight(task: Task): void {
    this.failed = false;
    const spec = this.state.proxy;
    const from = this.landed;
    if (spec === null || from === null) {
      this.clear();
      return;
    }

    const home =
      document.querySelector<HTMLElement>(`[data-unscheduled-row="${cssEscape(task.id)}"]`) ??
      document.querySelector<HTMLElement>(`[data-block-id="${cssEscape(task.id)}"]`);
    if (home === null) {
      this.clear();
      return;
    }

    if (prefersReducedMotion()) {
      this.clear();
      return;
    }

    const target = this.targetsFor(spec, home.getBoundingClientRect());
    void animate(this.x, target.x, SETTLE);
    void animate(this.y, target.y, SETTLE);
    void animate(this.sx, target.sx, SETTLE);
    void animate(this.sy, target.sy, SETTLE);
    this.land(this.x, task);
  }

  /**
   * The resize's release. The value committed is the snapped, bounded one; if
   * the hand was past a boundary the shape springs back out of the rubber-band
   * into it rather than cutting to it.
   */
  private finishResize(drag: Drag, cancelled: boolean, reduced: boolean): void {
    const ppm = minutePixels();
    const minutes = cancelled ? drag.baseMinutes : drag.liveMinutes;
    const target = minutes * ppm;

    // The same generation guard the flights carry: a resize that is still
    // springing out of its rubber-band when the next gesture starts must not
    // reach `clear()` and take the new gesture's proxy down with it.
    const id = ++this.flight;
    const settle = () => {
      if (this.flight !== id) return;
      this.flight = 0;
      this.clear();
    };

    if (!cancelled && minutes !== drag.task.durationMinutes) {
      void useStore.getState().mutate(resizeTaskSpec(drag.task, minutes));
    }

    const spec = this.state.proxy;
    if (spec === null || reduced) {
      settle();
      return;
    }

    const velocity = velocityOf(drag.samples, performance.now()).y;
    let running = 2;
    const one = () => {
      if (--running > 0) return;
      settle();
    };
    void animate(this.stretch, Math.max(0, (target - spec.cap * 2) / spec.middle), {
      ...SETTLE,
      velocity: velocity / spec.middle,
    }).then(one, one);
    void animate(this.grow, target - drag.height, { ...SETTLE, velocity }).then(one, one);
  }

  /** Put the real element back and take the proxy away, in one commit. */
  private clear(): void {
    this.stopFlight();
    this.attachSlices(null, null);
    this.publish({ activeId: null, kind: null, proxy: null, slot: null, overList: false });
  }

  /** Everything a gesture could have left behind, for an unmount mid-drag. */
  teardown(): void {
    if (this.candidate?.timer != null) window.clearTimeout(this.candidate.timer);
    if (this.drag?.raf != null) cancelAnimationFrame(this.drag.raf);
    this.candidate = null;
    this.drag = null;
    this.detach();
    document.body.style.userSelect = '';
  }
}

/**
 * The element's box with its own transform divided back out — its *layout*
 * position, which is what a grab offset has to be measured against.
 *
 * By the time a gesture begins, `:active` has already applied §8.5's press
 * feedback, so the thing being measured is 3% smaller than the thing the user
 * aimed at. Reading the visual box therefore puts the grab offset out by half
 * that shrink — 1.9px on a two-hour block — and the shape gives a small visible
 * kick against the finger at the moment it lifts. Small, and exactly the kind of
 * thing "1:1 tracking that respects the grab offset" is a promise about.
 *
 * The scale is about the element's centre (the press rule sets no origin), which
 * is why undoing it moves both edges. Same arithmetic as `lib/flip.ts`'s
 * `layoutRectOf`, which divides out a MotionValue-driven transform for the same
 * reason; this one reads the computed matrix, because the transform here belongs
 * to a stylesheet rather than to us.
 */
function layoutRectOfPressed(el: HTMLElement): DOMRect {
  const rect = el.getBoundingClientRect();
  const matrix = getComputedStyle(el).transform;
  if (matrix === 'none' || matrix === '') return rect;

  const values = matrix.slice(matrix.indexOf('(') + 1, -1).split(',').map(Number);
  // `matrix(a, b, c, d, e, f)` and `matrix3d(...)` both start with the x scale
  // and carry the y scale at index 3 or 5.
  const scaleX = values[0];
  const scaleY = matrix.startsWith('matrix3d') ? values[5] : values[3];
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX === 0 || scaleY === 0) {
    return rect;
  }

  const width = rect.width / scaleX;
  const height = rect.height / scaleY;
  return new DOMRect(
    rect.left + (rect.width - width) / 2,
    rect.top + (rect.height - height) / 2,
    width,
    height,
  );
}

/** `CSS.escape` where it exists; ids here are UUIDs, so this is belt and braces. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

/* --- React surface --------------------------------------------------------- */

const SchedulingContext = createContext<Scheduler | null>(null);

export function SchedulingProvider({
  onDragOut,
  children,
}: {
  /** Called when a drag needs the surface it started on to get out of the way. */
  onDragOut?(): void;
  children: ReactNode;
}) {
  const ref = useRef<Scheduler | null>(null);
  if (ref.current === null) ref.current = new Scheduler();
  const scheduler = ref.current;
  scheduler.onDragOut = onDragOut ?? null;

  useEffect(() => () => scheduler.teardown(), [scheduler]);

  return (
    <SchedulingContext.Provider value={scheduler}>
      {children}
      <DragLayer scheduler={scheduler} />
    </SchedulingContext.Provider>
  );
}

export function useScheduler(): Scheduler | null {
  return useContext(SchedulingContext);
}

function useSchedulingState(): State {
  const scheduler = useContext(SchedulingContext);
  return useSyncExternalStore(
    scheduler ? scheduler.subscribe : noopSubscribe,
    scheduler ? scheduler.snapshot : emptySnapshot,
    emptySnapshot,
  );
}

function noopSubscribe(): () => void {
  return () => {};
}

function emptySnapshot(): State {
  return EMPTY;
}

/**
 * True while `taskId` is under a gesture or its settle. The element it names
 * renders at `opacity: 0` — the proxy is standing in for it — and never at
 * `display: none`, which would take its space out of the column.
 */
export function useIsDragging(taskId: string): boolean {
  return useSchedulingState().activeId === taskId;
}

/** The slot the drag is currently committing to, for the proxy's own label. */
export function useDragSlot(): SlotSpec | null {
  return useSchedulingState().slot;
}

/** True while a drag is hovering the unscheduled list, which unschedules. */
export function useOverList(): boolean {
  const state = useSchedulingState();
  return state.overList && state.kind === 'move';
}

/** Registers the grid's geometry with the gesture. Called by `Schedule`. */
export function useGridRegistration(registration: GridRegistration | null): void {
  const scheduler = useContext(SchedulingContext);
  useEffect(() => {
    scheduler?.registerGrid(registration);
    return () => scheduler?.registerGrid(null);
  }, [scheduler, registration]);
}

/** Registers the unscheduled list as a drop target. Called by the list. */
export function useListRegistration(): (el: HTMLElement | null) => void {
  const scheduler = useContext(SchedulingContext);
  return useCallback((el: HTMLElement | null) => scheduler?.registerList(el), [scheduler]);
}

/** The handlers a draggable row or block needs, bound to one task. */
export function useDragHandlers(task: Task, kind: DragKind) {
  const scheduler = useContext(SchedulingContext);
  return useMemo(
    () => ({
      onPointerDown(event: ReactPointerEvent) {
        scheduler?.press(event, task, kind);
      },
      onClickCapture(event: React.MouseEvent) {
        // The click that follows a drag is the release, not a tap.
        if (!scheduler?.swallowsClick(task.id)) return;
        event.preventDefault();
        event.stopPropagation();
      },
      onDragStart(event: React.DragEvent) {
        event.preventDefault();
      },
    }),
    [scheduler, task, kind],
  );
}

/* --- the layer ------------------------------------------------------------- */

/**
 * The one fixed element the gesture moves. It is in a portal on `document.body`
 * so that it outlives the surface it came from: on a narrow viewport the row's
 * bottom sheet closes the instant the drag begins, and a proxy rendered inside
 * that sheet would leave with it.
 */
function DragLayer({ scheduler }: { scheduler: Scheduler }) {
  const state = useSyncExternalStore(scheduler.subscribe, scheduler.snapshot, emptySnapshot);
  const spec = state.proxy;
  if (spec === null) return null;

  return createPortal(
    <div
      aria-hidden="true"
      ref={scheduler.attachProxy}
      onPointerDown={(event) => scheduler.regrab(event)}
      className="planner-proxy"
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: `${spec.width}px`,
        height: `${spec.height}px`,
        // A settling proxy is the only thing on screen, so it is what a new
        // press has to land on for the settle to be interruptible (§8.5).
        // While the pointer is down it is captured and this changes nothing.
        pointerEvents: 'auto',
        touchAction: 'none',
        zIndex: 60,
        transformOrigin: 'top left',
        willChange: 'transform',
      }}
    >
      {spec.kind === 'resize' ? (
        <ResizeShape spec={spec} scheduler={scheduler} slot={state.slot} />
      ) : (
        <DragShape spec={spec} slot={state.slot} />
      )}
      {/* Below an hour the block itself is too short to hold `BlockFace`'s own
          range line (`EXPANDED_MINUTES` in Block.tsx), so this is the only
          place the range is legible while the drag is live. At an hour and
          above the settled block reads it directly, so the popup would be
          telling the eye something it can already see below the task name. */}
      {state.slot && state.slot.minutes < 60 && (
        <div
          className="pointer-events-none absolute left-[calc(100%+8px)] top-0 whitespace-nowrap rounded-chip bg-surface px-2 py-1 text-meta text-text shadow-md"
          style={{ zIndex: 2 }}
        >
          {blockRange(state.slot.startMs, state.slot.minutes)}
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * The dragged block: one surface, at the size its duration implies, reading the
 * slot it is currently over. The range updates as the drag crosses a 15-minute
 * line and at no other time — the shape follows the finger every frame, the
 * words follow the commitment.
 */
function DragShape({ spec, slot }: { spec: ProxySpec; slot: SlotSpec | null }) {
  return (
    <div
      style={{
        ...blockSurface(spec.task),
        position: 'absolute',
        inset: 0,
        borderRadius: `${CAP_PX}px`,
        boxShadow: 'var(--shadow-md)',
        overflow: 'hidden',
      }}
    >
      <BlockFace
        task={spec.task}
        minutes={effectiveMinutes(spec.task)}
        startMs={slot?.startMs ?? spec.task.scheduledAt}
      />
    </div>
  );
}

/**
 * The resizing block, in three slices.
 *
 * Only the middle scales. The caps hold their height, so the radius and the
 * horizontal edges stay true at any duration — the thing a single `scaleY` on
 * the whole block gets wrong, visibly, at exactly the sizes a resize passes
 * through. The label fades out as the block gets too short to hold it, which is
 * an opacity change and therefore allowed where a reflow would not be.
 */
function ResizeShape({
  spec,
  scheduler,
  slot,
}: {
  spec: ProxySpec;
  scheduler: Scheduler;
  slot: SlotSpec | null;
}) {
  const middle = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scheduler.attachSlices(middle.current, bottom.current);
    return () => scheduler.attachSlices(null, null);
  }, [scheduler]);

  const live = slot?.minutes ?? effectiveMinutes(spec.task);
  const surface = blockSurface(spec.task);
  const sides = {
    background: surface.background,
    borderLeft: surface.borderLeft,
    borderRight: surface.borderRight,
  };

  return (
    <>
      <div
        style={{
          ...sides,
          borderTop: surface.borderTop,
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: `${spec.cap}px`,
          borderTopLeftRadius: `${CAP_PX}px`,
          borderTopRightRadius: `${CAP_PX}px`,
        }}
      />
      <div
        ref={middle}
        style={{
          ...sides,
          position: 'absolute',
          left: 0,
          right: 0,
          top: `${spec.cap}px`,
          height: `${spec.middle}px`,
          transformOrigin: 'top',
          willChange: 'transform',
        }}
      />
      <div
        ref={bottom}
        style={{
          ...sides,
          borderBottom: surface.borderBottom,
          position: 'absolute',
          left: 0,
          right: 0,
          top: `${spec.cap + spec.middle}px`,
          height: `${spec.cap}px`,
          borderBottomLeftRadius: `${CAP_PX}px`,
          borderBottomRightRadius: `${CAP_PX}px`,
          willChange: 'transform',
        }}
      />
      {/* The label, unscaled and top-anchored. It fades out as the block gets
          too short to hold it — an opacity change, where clipping it to a live
          height would be the layout write §8.5 forbids. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          color: surface.color,
          pointerEvents: 'none',
        }}
      >
        <BlockFace
          task={spec.task}
          minutes={live}
          startMs={spec.task.scheduledAt}
          fade={clamp((live - MIN_DURATION_MINUTES) / MIN_DURATION_MINUTES, 0, 1)}
        />
      </div>
    </>
  );
}

/* --- the previewed slot ---------------------------------------------------- */

/**
 * The slot the drop will land in, drawn under the drag at reduced opacity
 * (§6.7). It lives inside the columns, so it scrolls with them; the gesture
 * moves it by transform and sets its box only when a drag begins.
 */
export function PreviewSlot() {
  const scheduler = useContext(SchedulingContext);
  return (
    <div
      aria-hidden="true"
      ref={(el) => scheduler?.registerPreview(el)}
      className="planner-preview"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        opacity: 0,
        pointerEvents: 'none',
        transformOrigin: 'top left',
        willChange: 'transform',
      }}
    />
  );
}

/* --- the geometry a resize must respect ------------------------------------ */

/**
 * Whether a duration is legal for a block starting at `startMs` — the rule the
 * resize's bounds and the keyboard's Shift+arrows both answer to (§3.1, §6.7).
 */
export function clampDuration(startMs: number, minutes: number): number {
  const bounded = clamp(minutes, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES);
  if (!crossesMidnight(startMs, bounded)) return bounded;
  const room =
    Math.floor(
      (MINUTES_PER_DAY - (startMs - startOfLocalDay(startMs)) / MINUTE_MS) / SCHEDULE_STEP_MINUTES,
    ) * SCHEDULE_STEP_MINUTES;
  return Math.max(MIN_DURATION_MINUTES, room);
}
