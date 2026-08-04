/**
 * The day pager — the strip that stands in for the seven columns below the wide
 * breakpoint. PROJECT-SPEC-V2.md §6.4.
 *
 * Seven weekday initials with their dates, the selected one raised, the current
 * one marked. Tapping moves the day column beside it.
 *
 * It is a `radiogroup` rather than seven buttons: the seven are one choice, and
 * arrow keys walking the week is what a radio group gives for free. Selecting a
 * day is a keyboard-reachable navigation, which §8.5 says gets no animation —
 * and nothing here animates. The raised state is a background change.
 */

import { isSameDay } from '../../../shared/planner';

const INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface DayPagerProps {
  /** The seven local midnights of the visible week, Sunday first. */
  days: number[];
  selected: number;
  now: number;
  onSelect(day: number): void;
}

export function DayPager({ days, selected, now, onSelect }: DayPagerProps) {
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const delta =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    // Stops at the ends rather than wrapping: the strip is a week, and jumping
    // from Saturday to Sunday of the same week is not "next".
    const next = Math.min(days.length - 1, Math.max(0, index + delta));
    onSelect(days[next]);
  }

  return (
    <div role="radiogroup" aria-label="Day" className="mb-3 flex gap-1">
      {days.map((day, index) => {
        const date = new Date(day);
        const active = isSameDay(day, selected);
        const today = isSameDay(day, now);

        return (
          <button
            key={day}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            aria-label={`${NAMES[date.getDay()]} ${date.getDate()}${today ? ', today' : ''}`}
            onClick={() => onSelect(day)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className="pressable flex min-w-0 flex-1 flex-col items-center justify-center
                       rounded-control py-2"
            style={{
              minHeight: 'var(--tap-target)',
              background: active ? 'var(--surface-2)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-secondary)',
            }}
          >
            <span className="text-meta" style={{ fontWeight: 500 }}>
              {INITIALS[date.getDay()]}
            </span>
            {/* Today is marked by weight and an accent underline dot, never by
                recolouring the whole cell — the same restraint §6.3 asks of the
                week view's headers. */}
            <span className="text-row" style={{ fontWeight: today ? 700 : 500 }}>
              {date.getDate()}
            </span>
            <span
              aria-hidden="true"
              className="mt-1 block rounded-pill"
              style={{
                width: '4px',
                height: '4px',
                background: today ? 'var(--accent)' : 'transparent',
              }}
            />
          </button>
        );
      })}
    </div>
  );
}
