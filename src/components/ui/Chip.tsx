/**
 * Metadata chips and the selectable duration chip. PROJECT-SPEC.md §8.4.
 *
 * Two things wear this shape and only one of them is a control, so they are two
 * components rather than one with a `readOnly` prop:
 *
 * - `Chip` is data — 12px text at tertiary or secondary contrast with a small
 *   leading Phosphor glyph, no container of its own in the task row. It is
 *   never focusable, because a row's chips are not six extra tab stops.
 * - `SelectableChip` is the composer's duration control: a real button, 8px
 *   radius, accent tint when selected, and a ≥44px target.
 */

import type { ReactNode } from 'react';

export interface ChipProps {
  /** 16px Phosphor glyph. §8.4 sizes chips' icons at 16. */
  icon?: ReactNode;
  /**
   * §8.4 puts chips "at tertiary or secondary contrast"; secondary is the
   * default because tertiary on `--bg` measures under 4.5:1 in both themes,
   * and §8.6 does not exempt 12px text from that floor.
   */
  tone?: 'tertiary' | 'secondary' | 'negative' | 'accent';
  /** Completed rows desaturate their whole chip cluster (§6.5). */
  muted?: boolean;
  /**
   * Opt in for a chip whose text is not a fixed, short vocabulary (a date, a
   * duration, "Blocked") but carries something unbounded — a task name, up to
   * 120 characters (§6.4) — the way "Waiting on {name}" does. The default
   * `shrink-0` is what keeps a duration chip from being squeezed into
   * unreadable digits next to its neighbours, but held against unbounded text
   * it does the opposite of what a `flex-wrap` row is for: the chip refuses to
   * shrink, so it overflows past the row's edge instead of wrapping onto one
   * of its own. `wrap` drops that refusal for the one chip that needs to.
   */
  wrap?: boolean;
  children?: ReactNode;
  title?: string;
  'aria-label'?: string;
}

const TONES = {
  tertiary: 'text-text-tertiary',
  secondary: 'text-text-secondary',
  negative: 'text-negative',
  accent: 'text-accent',
} as const;

export function Chip({ icon, tone = 'secondary', muted = false, wrap = false, children, ...rest }: ChipProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-meta ${wrap ? '' : 'shrink-0'} ${TONES[tone]}`}
      // §8.5: the chips crossfade to their completed contrast over ~150ms
      // rather than switching. An opacity fade aids comprehension, so it is one
      // of the things `prefers-reduced-motion` keeps.
      data-motion="essential"
      style={{
        opacity: muted ? 0.55 : 1,
        transition: 'opacity 150ms var(--ease-out)',
        wordBreak: wrap ? 'break-word' : undefined,
      }}
      {...rest}
    >
      {icon}
      {children}
    </span>
  );
}

export interface SelectableChipProps {
  selected: boolean;
  onClick(): void;
  children: ReactNode;
  'aria-label'?: string;
}

export function SelectableChip({ selected, onClick, children, ...rest }: SelectableChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={[
        'pressable inline-flex items-center justify-center rounded-chip px-3 text-meta',
        selected ? 'bg-accent-tint text-accent' : 'bg-surface-2 text-text-secondary',
      ].join(' ')}
      style={{ minHeight: 'var(--tap-target)', fontWeight: 600 }}
      {...rest}
    >
      {children}
    </button>
  );
}
