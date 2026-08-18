/**
 * Editing the dependency graph by drag, on the Blockers page.
 *
 * Three gestures, one machine, because all three are the same shape: press
 * something, drag a line, drop it on something, and a link changes.
 *
 *   * **Connect.** Press the dot on a node's right edge and drag to another
 *     node. The node you land on waits on the node you came from — left to
 *     right, prerequisite to dependent, the direction the page already draws.
 *   * **Retarget.** Press an existing edge anywhere along it and drag. The
 *     dependent end stays pinned and the *prerequisite* end follows the
 *     pointer: the question the gesture asks is "what does this wait on
 *     instead?". Dropping on empty space removes the link.
 *   * **Splice.** Long-press a task in the Standalone well and drag it onto an
 *     edge. It lands *inside* that edge — `A → task → B` — which is what makes
 *     the line itself, rather than either of its ends, the drop target.
 *
 * **No rule lives here.** `shared/dependencies.ts` decides what is legal and
 * `lib/actions.ts` writes it; this file decides what is under the pointer. That
 * split is deliberate and it is what lets the drag grey out an illegal target
 * with the same function that will refuse the write — a user must never learn a
 * rule by having a gesture fail silently.
 *
 * **Motion.** PROJECT-SPEC.md §8.5 governs, and the parts that apply do so in
 * full: pointer capture so tracking survives leaving the element, 1:1 tracking,
 * transform and opacity only, edge auto-scroll accelerating with proximity,
 * Escape to cancel, and input never locked. What does *not* apply is release
 * velocity: a reorder throws a row toward a slot and needs the seam covered,
 * while a connect either lands on a target or does not, and projecting a
 * connection past where the user let go would connect things they did not aim
 * at. There is nothing to settle, so nothing settles.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  linkDependency,
  retargetDependency,
  spliceIntoEdge,
  unlinkDependency,
} from '../../lib/actions';
import { edgeSpeed, LONG_PRESS_MS, POINTER_SLOP, TOUCH_SLOP } from '../../lib/gesture';
import { useStore } from '../../lib/store';
import {
  canDependOn,
  lookupOf,
  planRetarget,
  planSplice,
} from '../../../shared/dependencies';
import type { Task } from '../../../shared/types';

/** What the drag is trying to do. */
export type ConnectIntent =
  | { kind: 'connect'; sourceId: string }
  | { kind: 'retarget'; fromId: string; toId: string }
  | { kind: 'splice'; taskId: string };

/** What is under the pointer, in the terms the intents care about. */
export type DropTarget =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; fromId: string; toId: string }
  | null;

export interface ConnectState {
  intent: ConnectIntent;
  /** Live pointer position, in the tree layer's own coordinates. */
  x: number;
  y: number;
  target: DropTarget;
  /** True when releasing here would change the graph. */
  valid: boolean;
}

/** A point in the tree layer's coordinates, for anchoring the rubber line. */
export interface Anchor {
  x: number;
  y: number;
}

export interface ConnectHandlers {
  state: ConnectState | null;
  /** Begin immediately, for a dedicated handle that owns its own touch. */
  begin(event: ReactPointerEvent, intent: ConnectIntent): void;
  /** Begin after a long press, for a source that also has to be scrollable. */
  beginOnHold(event: ReactPointerEvent, intent: ConnectIntent): void;
  /** True once a drag has actually started, for suppressing the click after. */
  dragged: RefObject<boolean>;
}

/**
 * The drag machine for one board row.
 *
 * Scoped per row rather than per page because a link can never cross a board
 * (§6.4): a gesture that could leave one row's coordinate space would be
 * offering something the data refuses.
 */
export function useConnectDrag(
  layer: RefObject<HTMLDivElement | null>,
  scroller: RefObject<HTMLDivElement | null>,
): ConnectHandlers {
  const [state, setState] = useState<ConnectState | null>(null);
  const dragged = useRef(false);
  // The live gesture, off React state: a pointermove must not wait for a render
  // to know what it is doing.
  const gesture = useRef<{
    intent: ConnectIntent;
    pointerId: number;
    element: Element;
    origin: { x: number; y: number };
    started: boolean;
    holdTimer: number | null;
    /** Viewport coordinates, for the auto-scroll loop between moves. */
    client: { x: number; y: number };
  } | null>(null);
  const frame = useRef<number | null>(null);

  const stop = useCallback(() => {
    const live = gesture.current;
    if (live) {
      if (live.holdTimer !== null) window.clearTimeout(live.holdTimer);
      try {
        (live.element as HTMLElement).releasePointerCapture(live.pointerId);
      } catch {
        // The capture is already gone — the element unmounted, or the pointer
        // was cancelled by the browser. Nothing to release.
      }
    }
    gesture.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setState(null);
  }, []);

  /** Recompute the layer-space position and the drop target from the last client point. */
  const refresh = useCallback(() => {
    const live = gesture.current;
    const element = layer.current;
    if (!live || !live.started || !element) return;

    const rect = element.getBoundingClientRect();
    const target = targetAt(live.client.x, live.client.y);
    const tasks = useStore.getState().tasks;

    setState({
      intent: live.intent,
      x: live.client.x - rect.left,
      y: live.client.y - rect.top,
      target,
      valid: isValid(live.intent, target, tasks),
    });
  }, [layer]);

  /** Edge auto-scroll: the row scrolls under the drag so a distant node is reachable. */
  const autoScroll = useCallback(() => {
    frame.current = null;
    const live = gesture.current;
    const element = scroller.current;
    if (!live || !live.started || !element) return;

    const rect = element.getBoundingClientRect();
    const speed = edgeSpeed(live.client.x - rect.left, rect.width);
    if (speed !== 0) {
      // One frame's worth at 60fps. Deliberately not measured against a real
      // delta: a dropped frame should scroll less, not lurch.
      element.scrollLeft += speed / 60;
      refresh();
    }
    frame.current = requestAnimationFrame(autoScroll);
  }, [scroller, refresh]);

  const finish = useCallback(() => {
    const live = gesture.current;
    if (!live) return;
    const started = live.started;
    const intent = live.intent;
    const target = started ? targetAt(live.client.x, live.client.y) : null;
    stop();
    if (started) commit(intent, target);
  }, [stop]);

  useEffect(() => {
    if (state === null) return;
    // Escape cancels an in-flight drag and leaves the graph exactly as it was
    // (§6.7's rule for the Planner, and the same expectation here).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, stop]);

  useEffect(() => stop, [stop]);

  const start = useCallback(
    (event: ReactPointerEvent, intent: ConnectIntent, hold: boolean) => {
      // A second touch during a drag is ignored, per §8.5.
      if (gesture.current) return;
      if (event.button !== undefined && event.button !== 0) return;

      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);
      dragged.current = false;

      gesture.current = {
        intent,
        pointerId: event.pointerId,
        element,
        origin: { x: event.clientX, y: event.clientY },
        client: { x: event.clientX, y: event.clientY },
        started: false,
        holdTimer: null,
      };

      const live = gesture.current;
      // The hold is a *touch* rule and only a touch rule: it exists so that
      // scrolling a list never becomes dragging out of it (§8.5). A mouse has
      // no such ambiguity, so a mouse always gets the 6px slop instead —
      // holding a pointer still for 200ms before a drag would take is not a
      // gesture anyone on a trackpad expects to have to perform.
      if (hold && event.pointerType !== 'mouse') {
        live.holdTimer = window.setTimeout(() => {
          live.holdTimer = null;
          live.started = true;
          dragged.current = true;
          refresh();
          frame.current = requestAnimationFrame(autoScroll);
        }, LONG_PRESS_MS);
      } else if (!hold && event.pointerType !== 'mouse') {
        // A dedicated handle with `touch-action: none` is not competing with a
        // scroll, so a touch on one is a drag from the first pixel.
        live.started = true;
        dragged.current = true;
        refresh();
        frame.current = requestAnimationFrame(autoScroll);
      }
    },
    [refresh, autoScroll],
  );

  const begin = useCallback(
    (event: ReactPointerEvent, intent: ConnectIntent) => start(event, intent, false),
    [start],
  );
  const beginOnHold = useCallback(
    (event: ReactPointerEvent, intent: ConnectIntent) => start(event, intent, true),
    [start],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const live = gesture.current;
      if (!live || event.pointerId !== live.pointerId) return;
      live.client = { x: event.clientX, y: event.clientY };

      if (!live.started) {
        const slop = event.pointerType === 'mouse' ? POINTER_SLOP : TOUCH_SLOP;
        const moved =
          Math.abs(event.clientX - live.origin.x) > slop ||
          Math.abs(event.clientY - live.origin.y) > slop;
        if (!moved) return;

        if (live.holdTimer !== null) {
          // Moved before the hold elapsed: this was a scroll, not a drag.
          window.clearTimeout(live.holdTimer);
          gesture.current = null;
          return;
        }
        live.started = true;
        dragged.current = true;
        frame.current = requestAnimationFrame(autoScroll);
      }

      event.preventDefault();
      refresh();
    };

    const onUp = (event: PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) finish();
    };
    const onCancel = (event: PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) stop();
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [refresh, finish, stop, autoScroll]);

  return { state, begin, beginOnHold, dragged };
}

/**
 * What sits under a viewport point.
 *
 * `elementFromPoint` rather than hit-testing the geometry by hand: the nodes
 * are real boxes and the edges are real strokes, and the browser already knows
 * where they are. Both layers carry data attributes for exactly this. The
 * dragged overlay is `pointer-events: none`, so it never answers for itself.
 *
 * A node wins over an edge where they overlap, because a node is the smaller,
 * more deliberate target and an edge passing behind one is not something a
 * user is aiming at.
 */
function targetAt(clientX: number, clientY: number): DropTarget {
  const element = document.elementFromPoint(clientX, clientY);
  if (!element) return null;

  const node = element.closest('[data-blocker-node]');
  const id = node?.getAttribute('data-blocker-node');
  if (id) return { kind: 'node', id };

  const edge = element.closest('[data-edge-from]');
  const fromId = edge?.getAttribute('data-edge-from');
  const toId = edge?.getAttribute('data-edge-to');
  if (fromId && toId) return { kind: 'edge', fromId, toId };

  return null;
}

/**
 * Whether releasing on `target` would change the graph.
 *
 * Every branch asks `shared/dependencies.ts` rather than re-deriving anything,
 * so what the drag highlights and what the write accepts cannot drift apart.
 * A retarget onto nothing is *valid* — that is the delete gesture, and it is
 * the one case where an empty drop is an answer rather than a miss.
 */
function isValid(
  intent: ConnectIntent,
  target: DropTarget,
  tasks: Record<string, Task>,
): boolean {
  const lookup = lookupOf(tasks);

  if (intent.kind === 'connect') {
    if (target?.kind !== 'node') return false;
    const source = tasks[intent.sourceId];
    const dependent = tasks[target.id];
    return Boolean(source && dependent && canDependOn(dependent, source, lookup));
  }

  if (intent.kind === 'retarget') {
    const dependent = tasks[intent.toId];
    if (!dependent) return false;
    // Released over nothing: the link goes away.
    if (target === null) return true;
    if (target.kind !== 'node') return false;
    if (target.id === intent.fromId) return false;
    const prerequisite = tasks[target.id];
    return Boolean(
      prerequisite && planRetarget(dependent, intent.fromId, prerequisite, lookup),
    );
  }

  if (target?.kind !== 'edge') return false;
  const task = tasks[intent.taskId];
  const to = tasks[target.toId];
  return Boolean(task && to && planSplice(task, target.fromId, to, lookup));
}

/** Write the drop. Refusals are the actions' own, and they say why in a toast. */
function commit(intent: ConnectIntent, target: DropTarget): void {
  const tasks = useStore.getState().tasks;

  if (intent.kind === 'connect') {
    if (target?.kind !== 'node') return;
    const dependent = tasks[target.id];
    if (dependent) linkDependency(dependent, intent.sourceId);
    return;
  }

  if (intent.kind === 'retarget') {
    const dependent = tasks[intent.toId];
    if (!dependent) return;
    if (target === null) {
      unlinkDependency(dependent, intent.fromId);
      return;
    }
    if (target.kind !== 'node' || target.id === intent.fromId) return;
    retargetDependency(dependent, intent.fromId, target.id);
    return;
  }

  if (target?.kind !== 'edge') return;
  const task = tasks[intent.taskId];
  if (task) spliceIntoEdge(task, target.fromId, target.toId);
}

/**
 * The rubber line, drawn from a fixed anchor to the pointer.
 *
 * Dashed and in the accent while it is over something it can land on, dashed
 * and tertiary while it is not — one stroke that answers "will this do
 * anything" without a second element appearing to say so. A retarget released
 * over nothing deletes the link, so *that* case reads as valid, in `--negative`
 * rather than the accent because it is the one drop that destroys something.
 */
export function ConnectLine({
  anchor,
  state,
}: {
  anchor: Anchor | null;
  state: ConnectState;
}) {
  if (!anchor) return null;

  const deleting = state.intent.kind === 'retarget' && state.target === null;
  const stroke = deleting
    ? 'var(--negative)'
    : state.valid
      ? 'var(--accent)'
      : 'var(--text-tertiary)';

  // The same cubic the drawn edges use, so the line being dragged and the lines
  // already there are visibly the same kind of object.
  const controlX = anchor.x + (state.x - anchor.x) / 2;

  return (
    <path
      d={`M ${anchor.x} ${anchor.y} C ${controlX} ${anchor.y}, ${controlX} ${state.y}, ${state.x} ${state.y}`}
      fill="none"
      stroke={stroke}
      strokeWidth="2"
      strokeDasharray="5 4"
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}
