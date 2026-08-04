/**
 * The hover details card. PROJECT-SPEC.md §6.4, §8.4, §8.5.
 *
 * A task on the dashboard shows its name and little else — that is what keeps
 * a board card scannable. This is the rest of it, on hover: notes, due date and
 * time, duration, difficulty, priority, blocked, and what it is waiting on. All
 * of it at meta size, because it is reference material, not a second reading of
 * the row.
 *
 * Three decisions worth stating.
 *
 * **Hover and focus, never tap.** §8.5 gates hover effects behind a fine
 * pointer, and this is one: on a touch device the card never opens, which is
 * correct because tapping opens the composer and the composer holds all of the
 * same fields. Nothing lives only here. Keyboard focus opens it too, so it is
 * not mouse-only.
 *
 * **Portalled, and positioned in viewport coordinates.** The triggers sit
 * inside a horizontally scrolling strip and inside cards that carry motion
 * transforms, and either one would clip or re-anchor an absolutely positioned
 * child. Rendering to `document.body` at a measured rect is what makes one
 * component work in both places.
 *
 * **Inert.** `pointer-events: none`, so it can never swallow the click meant
 * for the row underneath, and there is nothing inside it to interact with.
 */

import {
  Clock,
  Flag,
  LinkSimple,
  Prohibit,
  Timer,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatDue, formatDuration, formatOverdue } from '../lib/dates';
import { useBlockedBy } from '../lib/store';
import type { Task } from '../../shared/types';

/** Long enough that crossing a list does not flash five cards. */
const OPEN_DELAY_MS = 260;
const CARD_WIDTH = 260;
/** Gap between the trigger and the card, and the margin kept off each edge. */
const OFFSET = 8;
const MARGIN = 8;

interface Placement {
  left: number;
  top: number;
  /** Which way it opened, so the entrance moves *from* the trigger. */
  from: 'above' | 'below';
}

export interface TaskDetailsProps {
  task: Task;
  children: ReactNode;
  /** Applied to the wrapper, which is otherwise layout-neutral. */
  className?: string;
}

export function TaskDetails({ task, children, className }: TaskDetailsProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  function place() {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;

    // Clamped to the viewport rather than flipped horizontally: a card that
    // jumps sides as the pointer travels along a row is harder to read than one
    // that stops at the edge.
    const left = Math.min(
      Math.max(MARGIN, rect.left),
      window.innerWidth - CARD_WIDTH - MARGIN,
    );
    // Above by preference, below when there is not room — measured against the
    // trigger, so a card in the top row of the dashboard opens downward.
    const above = rect.top > window.innerHeight / 2;
    setPlacement({
      left,
      top: above ? rect.top - OFFSET : rect.bottom + OFFSET,
      from: above ? 'above' : 'below',
    });
  }

  function open() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(place, OPEN_DELAY_MS);
  }

  function close() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setPlacement(null);
  }

  return (
    <span
      ref={anchor}
      className={className}
      onPointerEnter={(event) => {
        // The gate §8.5 asks for. A touch reports `pointerType: 'touch'` and is
        // ignored; only a real hover opens the card.
        if (event.pointerType === 'mouse') open();
      }}
      onPointerLeave={close}
      onFocusCapture={place}
      onBlurCapture={close}
    >
      {children}
      {placement && <DetailsCard task={task} placement={placement} />}
    </span>
  );
}

function DetailsCard({ task, placement }: { task: Task; placement: Placement }) {
  const waiting = useBlockedBy(task.id);
  const [now] = useState(() => Date.now());
  const overdue = formatOverdue(task, now);
  const due = overdue ?? formatDue(task, now);

  const rows: ReactNode[] = [];
  if (due) {
    rows.push(
      // `formatDue` already appends the time when there is one, so this row is
      // the whole of the due information and nothing is added to it.
      <Row key="due" icon={<Clock size={14} />} {...(overdue ? { tone: 'negative' as const } : {})}>
        {due}
      </Row>,
    );
  }
  if (task.duration) {
    rows.push(
      <Row key="duration" icon={<Timer size={14} />}>
        {formatDuration(task.duration)}
      </Row>,
    );
  }
  if (task.difficulty !== null) {
    rows.push(
      <Row key="difficulty" icon={<Pip />}>
        Difficulty {task.difficulty} of 5
      </Row>,
    );
  }
  if (task.priority) {
    rows.push(
      <Row key="priority" icon={<Flag size={14} weight="fill" />} tone="accent">
        Priority
      </Row>,
    );
  }
  if (task.blocked) {
    rows.push(
      <Row key="blocked" icon={<Prohibit size={14} />}>
        Blocked
      </Row>,
    );
  }
  if (waiting) {
    rows.push(
      <Row key="waiting" icon={<LinkSimple size={14} />}>
        Waiting on {waiting.name}
      </Row>,
    );
  }

  const empty = rows.length === 0 && !task.notes;

  return createPortal(
    <div
      role="tooltip"
      className="cairn-details pointer-events-none fixed z-50 p-3"
      style={{
        left: placement.left,
        top: placement.top,
        width: CARD_WIDTH,
        transform: placement.from === 'above' ? 'translateY(-100%)' : undefined,
        transformOrigin: placement.from === 'above' ? 'bottom left' : 'top left',
        backgroundColor: 'var(--surface)',
        border: 'var(--hairline-width) solid var(--hairline)',
        borderRadius: 'var(--radius-control)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <p className="text-meta text-text" style={{ fontWeight: 600 }}>
        {task.name}
      </p>

      {task.notes && (
        <p
          className="mt-2 text-meta text-text-secondary"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {task.notes}
        </p>
      )}

      {rows.length > 0 && <div className="mt-2 grid gap-1">{rows}</div>}

      {empty && <p className="mt-2 text-meta text-text-tertiary">No details yet</p>}
    </div>,
    document.body,
  );
}

function Row({
  icon,
  tone,
  children,
}: {
  icon: ReactNode;
  tone?: 'negative' | 'accent';
  children: ReactNode;
}) {
  return (
    <span
      className="flex items-center gap-2 text-meta"
      style={{
        color:
          tone === 'negative'
            ? 'var(--negative)'
            : tone === 'accent'
              ? 'var(--accent)'
              : 'var(--text-secondary)',
      }}
    >
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </span>
  );
}

/** The difficulty glyph: one filled pip, matching the row's `Pips`. */
function Pip() {
  return (
    <span
      aria-hidden="true"
      className="block rounded-pill"
      style={{ width: '4px', height: '12px', backgroundColor: 'currentColor' }}
    />
  );
}
