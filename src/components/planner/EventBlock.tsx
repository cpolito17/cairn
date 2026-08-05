import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { PlacedBlock } from '../../../shared/planner';
import { localDateKey } from '../../../shared/events';
import type { PlannerEvent } from '../../../shared/types';
import { blockRange } from './Block';
import { minutePixels, minutesInto, offsetOf } from './scale';
import { updateEventSpec, useStore } from '../../lib/store';

type Gesture = { kind: 'move' | 'resize'; pointerId: number; x: number; y: number; startMs: number; minutes: number; moved: boolean };

export function EventBlock({ block, dayStart, event, onOpen }: {
  block: PlacedBlock; dayStart: number; event: PlannerEvent; onOpen(event: PlannerEvent): void;
}) {
  const gesture = useRef<Gesture | null>(null);
  const swallowed = useRef(false);
  const [live, setLive] = useState<{ startMs: number; minutes: number; dx: number; dy: number } | null>(null);
  const liveRef = useRef(live);
  const finishRef = useRef<(event: { pointerId: number }) => void>(() => undefined);
  const topMinutes = minutesInto(block.startMs, dayStart);
  const left = `calc(${(100 * block.lane) / block.lanes}% + 2px)`;
  const width = `calc(${100 / block.lanes}% - 4px)`;

  function begin(e: React.PointerEvent, kind: 'move' | 'resize') {
    if (e.button !== 0) return;
    e.stopPropagation();
    gesture.current = { kind, pointerId: e.pointerId, x: e.clientX, y: e.clientY, startMs: block.startMs, minutes: block.minutes, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function move(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const dyRaw = e.clientY - g.y;
    const dxRaw = e.clientX - g.x;
    if (!g.moved && Math.hypot(dxRaw, dyRaw) < 5) return;
    g.moved = true;
    const ppm = minutePixels();
    if (g.kind === 'resize') {
      const minutes = Math.max(15, Math.min(720, Math.round((g.minutes + dyRaw / ppm) / 15) * 15));
      const next = { startMs: g.startMs, minutes, dx: 0, dy: 0 };
      liveRef.current = next;
      setLive(next);
      return;
    }
    const column = document.elementsFromPoint(e.clientX, e.clientY)
      .map((node) => (node as HTMLElement).closest?.<HTMLElement>('[data-day-column]'))
      .find(Boolean);
    if (!column) return;
    const targetDay = Number(column.dataset.dayStart);
    const rect = column.getBoundingClientRect();
    const minute = Math.max(0, Math.min(1440 - g.minutes, Math.round(((e.clientY - rect.top) / ppm) / 15) * 15));
    const startMs = targetDay + minute * 60_000;
    const origin = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-day-column]')?.getBoundingClientRect();
    const next = { startMs, minutes: g.minutes, dx: origin ? rect.left - origin.left : dxRaw, dy: (startMs - targetDay - topMinutes * 60_000) / 60_000 * ppm };
    liveRef.current = next;
    setLive(next);
  }

  function finish(e: { pointerId: number }) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    const committed = liveRef.current;
    // Clear the local transform before the optimistic series update changes
    // the occurrence key; otherwise React can retire this instance before its
    // queued local reset is applied, leaving the old transform painted once.
    flushSync(() => { liveRef.current = null; setLive(null); });
    if (g.moved && committed) {
      swallowed.current = true;
      if (g.kind === 'resize') {
        if (committed.minutes !== event.durationMinutes) void useStore.getState().mutate(updateEventSpec(event, { durationMinutes: committed.minutes }));
      } else {
        const oldDay = new Date(g.startMs).getDay();
        const newDay = new Date(committed.startMs).getDay();
        const nextDays = oldDay === newDay ? event.weekdays : [...new Set(event.weekdays.map((day) => day === oldDay ? newDay : day))].sort();
        void useStore.getState().mutate(updateEventSpec(event, {
          weekdays: nextDays,
          startMinutes: Math.round((committed.startMs - new Date(committed.startMs).setHours(0, 0, 0, 0)) / 60_000),
          ...(committed.startMs < new Date(`${event.startsOn}T00:00:00`).getTime() ? { startsOn: localDateKey(committed.startMs) } : {}),
        }));
      }
    }
  }
  finishRef.current = finish;

  // Pointer capture is reliable in browsers, but a synthetic drag can release
  // at the window boundary without React delivering the element-level up.
  // The capture-phase fallback makes the commit path identical in both cases.
  useEffect(() => {
    const end = (event: PointerEvent) => finishRef.current(event);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    return () => {
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
    };
  }, []);

  const current = live ?? { startMs: block.startMs, minutes: block.minutes, dx: 0, dy: 0 };
  return <>
    <button type="button" data-event-block={event.id} onPointerDown={(e) => begin(e, 'move')} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onClick={(e) => { if (swallowed.current) { swallowed.current = false; e.preventDefault(); return; } onOpen(event); }}
      className="planner-event-block pressable absolute z-[4] overflow-visible rounded-chip px-2 text-left"
      style={{ top: offsetOf(topMinutes), height: offsetOf(current.minutes), left, width, transform: `translate(${current.dx}px, ${live ? current.dy : 0}px)`,
        background: 'var(--surface-2)', border: 'var(--hairline-width) dashed var(--text-tertiary)', color: 'var(--text)', touchAction: 'none' }}>
      <span className="block truncate" style={{ fontSize: '.75rem', lineHeight: block.minutes <= 15 ? offsetOf(15) : '1rem', fontWeight: 600 }}>{event.name}</span>
      {block.minutes >= 45 && <span className="block truncate text-meta text-text-secondary">{blockRange(current.startMs, current.minutes)}</span>}
      {live && <span className="pointer-events-none absolute left-[calc(100%+6px)] top-0 z-50 whitespace-nowrap rounded-chip bg-surface px-2 py-1 text-meta text-text shadow-md">{blockRange(current.startMs, current.minutes)}</span>}
    </button>
    <div aria-hidden="true" onPointerDown={(e) => begin(e, 'resize')} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      className="absolute z-[6] cursor-ns-resize" style={{ left, width, top: `calc(${offsetOf(topMinutes + block.minutes)} - 7px)`, height: 14, touchAction: 'none' }} />
  </>;
}
