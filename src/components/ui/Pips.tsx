/**
 * Difficulty pips. PROJECT-SPEC.md §8.4.
 *
 * The same five segments mean two different things in two places, and the spec
 * is deliberate about it: in a task row difficulty is **data**, so filled
 * segments are `--text-secondary` against `--hairline` and never accent; in the
 * composer it is a **control**, so the filled segments move to accent while the
 * control has focus. That is the whole reason `Pips` and `PipsInput` are
 * separate — one is a `<span>`, the other is a radiogroup with arrow keys.
 */

import { useState } from 'react';
import type { Difficulty } from '../../../shared/types';

const LEVELS: Difficulty[] = [1, 2, 3, 4, 5];

function Pip({ filled, color }: { filled: boolean; color: string }) {
  return (
    <span
      aria-hidden="true"
      className="block rounded-pill"
      style={{
        width: '4px',
        height: '12px',
        backgroundColor: filled ? color : 'var(--hairline)',
        transition: 'background-color 160ms var(--ease-out)',
      }}
    />
  );
}

/** The read-only row variant: data, never accent. */
export function Pips({ value, muted = false }: { value: Difficulty; muted?: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[2px]"
      role="img"
      aria-label={`Difficulty ${value} of 5`}
      // Crossfades with the rest of the row's metadata on completion (§8.5).
      data-motion="essential"
      style={{ opacity: muted ? 0.55 : 1, transition: 'opacity 150ms var(--ease-out)' }}
    >
      {LEVELS.map((level) => (
        <Pip key={level} filled={level <= value} color="var(--text-secondary)" />
      ))}
    </span>
  );
}

export interface PipsInputProps {
  value: Difficulty | null;
  onChange(value: Difficulty | null): void;
  label: string;
}

/**
 * The composer variant. Tapping the level that is already set clears it, which
 * is the only way back to "not set" — and unset is the common case, so it has
 * to be reachable without a second control.
 */
export function PipsInput({ value, onChange, label }: PipsInputProps) {
  const [focused, setFocused] = useState(false);
  const color = focused ? 'var(--accent)' : 'var(--text-secondary)';

  function onKeyDown(event: React.KeyboardEvent) {
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();

    const next = (value ?? 0) + delta;
    if (next < 1) onChange(null);
    else if (next <= 5) onChange(next as Difficulty);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className="inline-flex items-center gap-1 rounded-chip"
      style={{ minHeight: 'var(--tap-target)' }}
    >
      {LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={value === level}
          aria-label={`Difficulty ${level}`}
          tabIndex={-1}
          onClick={() => onChange(value === level ? null : level)}
          onFocus={() => setFocused(true)}
          className="pressable flex items-center justify-center rounded-chip"
          style={{ width: '32px', height: 'var(--tap-target)' }}
        >
          <span
            aria-hidden="true"
            className="block rounded-pill"
            style={{
              width: '6px',
              height: '20px',
              backgroundColor:
                value !== null && level <= value ? color : 'var(--hairline)',
              transition: 'background-color 160ms var(--ease-out)',
            }}
          />
        </button>
      ))}
    </div>
  );
}
