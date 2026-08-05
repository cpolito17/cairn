/**
 * The progress bar and its percentage. PROJECT-SPEC.md §8.4, §7.1, §8.5.
 *
 * The fill is a full-width block scaled by `transform: scaleX` from a left
 * origin. Animating `width` instead is called out in the spec as a defect and
 * it is a real one: `width` is a layout property, so every frame of the
 * animation reflows the row it sits in.
 *
 * The percentage is a digit ticker rather than a number that swaps. Each column
 * holds 0–9 stacked vertically and translates to the digit it wants, so a 38 →
 * 46 change rolls both columns instead of blinking. Tabular figures come from
 * the global `font-variant-numeric` (§8.3), which is what keeps the columns
 * from jittering as the digits change width.
 */

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export interface ProgressBarProps {
  /** Whole-number percentage, 0–100, from `boardProgress()`. */
  percent: number;
  label?: string;
  /** Optional board-specific fill. Defaults to the active theme accent. */
  color?: string;
}

export function ProgressBar({
  percent,
  label = 'Board progress',
  color = 'var(--accent)',
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className="relative w-full overflow-hidden bg-surface-2"
      style={{ height: 'var(--progress-height)', borderRadius: 'var(--radius-pill)' }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 block"
        style={{
          backgroundColor: color,
          borderRadius: 'var(--radius-pill)',
          transformOrigin: 'left center',
          transform: `scaleX(${clamped / 100})`,
          transition: 'transform 200ms var(--ease-out)',
        }}
      />
    </div>
  );
}

/**
 * A rolling figure. `value` is rendered digit by digit; the trailing unit is a
 * plain glyph, because a rolling percent sign would be motion for its own sake.
 */
export function NumberTicker({ value, suffix = '%' }: { value: number; suffix?: string }) {
  const text = String(Math.max(0, Math.round(value)));

  return (
    <span className="inline-flex items-baseline">
      {/* The columns are ten digits deep each, so the figure is spelled out
          once for assistive tech and the rolling markup is hidden from it. */}
      <span className="sr-only">
        {text}
        {suffix}
      </span>
      <span aria-hidden="true" className="inline-flex">
        {text.split('').map((char, index) => (
          // Keyed from the right so 9 → 10 rolls the ones column rather than
          // re-mounting both columns and losing the roll.
          <DigitColumn key={text.length - index} digit={Number(char)} />
        ))}
      </span>
      <span aria-hidden="true">{suffix}</span>
    </span>
  );
}

function DigitColumn({ digit }: { digit: number }) {
  return (
    <span
      className="inline-block overflow-hidden"
      style={{ height: '1em', lineHeight: 1, verticalAlign: 'bottom' }}
    >
      <span
        className="block"
        style={{
          transform: `translateY(${-digit * 10}%)`,
          transition: 'transform 200ms var(--ease-out)',
        }}
      >
        {DIGITS.map((d) => (
          <span key={d} className="block" style={{ height: '1em', lineHeight: 1 }}>
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}
