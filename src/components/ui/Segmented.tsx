/**
 * Segmented control — the elevated-thumb variant. PROJECT-SPEC.md §8.4, §8.5.
 *
 * A recessed `--surface-2` track, the selected segment raised in `--surface`
 * with a small soft shadow, hairline dividers only between two unselected
 * segments. The thumb is a single element that moves between segments by layout
 * animation (`layoutId`), never a teleport and never a re-mount: mounting a new
 * thumb in the new slot is the bug that makes it look like it blinked across.
 *
 * Selecting the segment that is already selected changes nothing, so nothing
 * re-animates.
 */

import { motion } from 'motion/react';
import { useRef } from 'react';
import { UI_SPRING } from '../../lib/motion';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  /** Distinct per mounted control — the thumb's `layoutId` is derived from it. */
  id: string;
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  className?: string;
}

export function Segmented<T extends string>({
  id,
  label,
  options,
  value,
  onChange,
  className = '',
}: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  /**
   * §8.5: keyboard-initiated actions get no animation, ever. Arrow-keying
   * through a radio group is the clearest case there is — it is repeatable at
   * key-repeat speed, and a thumb springing after each press turns a two-press
   * traversal into a queue of springs chasing the focus ring.
   *
   * A ref rather than state: it has to be readable during the render the key
   * press causes, and a state update would land one render late — exactly the
   * render that animates.
   */
  const viaKeyboard = useRef(false);

  /** Arrow keys move the selection, which is what a radio group does. */
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (delta === 0) return;

    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    viaKeyboard.current = true;
    refs.current[next]?.focus();
    select(options[next].value);
  }

  function select(next: T) {
    // The guard is the whole of "pressing the same segment twice does not
    // re-animate" — no state change, no render, no layout animation.
    if (next === value) return;
    onChange(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex rounded-control bg-surface-2 p-1 ${className}`}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        // Dividers exist only between two unselected segments; the raised thumb
        // already separates itself from its neighbours.
        const divider =
          index > 0 && !selected && options[index - 1].value !== value;

        return (
          <div key={option.value} className="relative flex min-w-0 flex-1">
            {divider && (
              <span
                aria-hidden="true"
                className="absolute top-1/2 left-0 -translate-y-1/2 bg-hairline"
                style={{ width: 'var(--hairline-width)', height: '60%' }}
              />
            )}
            <button
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              // `detail === 0` is a click the keyboard synthesised — Space and
              // Enter on a focused radio arrive here exactly as a tap does, and
              // §8.5 wants them told apart. Same test the task row's checkbox
              // uses, for the same reason.
              onClick={(event) => {
                viaKeyboard.current = event.detail === 0;
                select(option.value);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={[
                'pressable relative w-full truncate rounded-chip px-3 text-center select-none',
                selected ? 'text-text' : 'text-text-secondary',
              ].join(' ')}
              style={{
                // The segments are the app's most-used control and sit at the
                // top of the thumb's reach: 44px is the floor, not a nicety.
                minHeight: 'var(--tap-target)',
                fontSize: 'var(--text-meta)',
                fontWeight: 600,
              }}
            >
              {selected && (
                <motion.span
                  aria-hidden="true"
                  layoutId={`segmented-thumb-${id}`}
                  className="absolute inset-0 rounded-chip bg-surface shadow-sm"
                  // §8.5 puts the thumb at ~200ms, critically damped, and it
                  // retargets mid-flight rather than restarting — which a
                  // keyframe could not do. `visualDuration` because that is the
                  // dial §8.5 means by response; plain `duration` on a spring is
                  // its total settle and lands somewhere else entirely.
                  transition={
                    viaKeyboard.current
                      ? { duration: 0 }
                      : { ...UI_SPRING, visualDuration: 0.2 }
                  }
                />
              )}
              <span className="relative">{option.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
