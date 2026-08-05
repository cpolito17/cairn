/**
 * The theme dropdown. PROJECT-SPEC-V2.md §5.1; PROJECT-SPEC.md §8.4, §8.5.
 *
 * Eight themes under two group headers, Dark and Light, each row carrying a
 * split swatch of that theme's own `--bg` and `--accent` and the selected row a
 * check in the *active* accent. Selecting applies immediately and closes the
 * list — the sheet stays open, so trying a second one is one tap, not four.
 *
 * **The list expands in flow rather than floating over the sheet.** This is the
 * one place the "popover scales from its trigger" rule (§8.5) is not what the
 * surface can support: the settings sheet is a scrolling container, and an
 * absolutely-positioned list of eight rows opening inside it would be clipped
 * at the container's edge with its lower half unreachable — the scroll cannot
 * reach content that is out of flow. Expanding in flow means the sheet simply
 * scrolls to it. What the rule is protecting — that the list is understood as
 * belonging to the control that opened it — is carried instead by the list
 * sitting directly beneath the trigger and animating from it.
 *
 * The layout change itself is instantaneous and only opacity and a 4px rise
 * animate. Animating the height would be animating a layout property, which
 * §8.5 rules out.
 *
 * Keyboard: the trigger opens with Enter or Space, focus lands on the selected
 * theme, the arrows walk the eight rows across the group boundary, Home and End
 * jump to the ends, Escape closes and hands focus back to the trigger.
 */

import { CaretDown, Check } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { keyboardMotionActive, OUT } from '../lib/motion';
import { THEME_GROUPS, THEME_LABELS, THEME_SWATCHES, type Theme } from '../lib/theme';

export interface ThemeSelectProps {
  value: Theme;
  onChange(theme: Theme): void;
}

/** The eight, flattened in display order — what the arrow keys walk. */
const ORDER: Theme[] = THEME_GROUPS.flatMap((group) => [...group.themes]);

export function ThemeSelect({ value, onChange }: ThemeSelectProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const rows = useRef<Record<string, HTMLButtonElement | null>>({});
  const listId = useId();
  const keyboard = keyboardMotionActive();

  // The selected theme is read through a ref by the open effect below, which
  // must run on *opening* and not again when the selection changes — re-running
  // it would pull focus back from wherever the user had moved it.
  const selected = useRef(value);
  selected.current = value;

  // Focus the selected row when the list opens, so the arrows start from where
  // the user already is rather than from the top of a list of eight.
  useEffect(() => {
    if (open) rows.current[selected.current]?.focus();
  }, [open]);

  /**
   * Escape closes the list, not the settings sheet behind it — and getting that
   * ordering right takes the capture phase on `window`.
   *
   * `useOverlay` closes the sheet from a capture-phase listener on `document`,
   * which runs before anything in the tree below it: a bubble-phase handler on
   * the row would call `stopPropagation` long after the sheet had already gone.
   * The capture path is window → document → …, so a capture listener here runs
   * first and can stop the event before the sheet ever sees it.
   */
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }

    // An outside press closes it, the same as any other dropdown in the app.
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }

    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }

  function onRowKeyDown(event: React.KeyboardEvent, index: number) {
    const delta =
      event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    let next = -1;
    if (delta !== 0) next = (index + delta + ORDER.length) % ORDER.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = ORDER.length - 1;
    if (next < 0) return;

    event.preventDefault();
    rows.current[ORDER[next]]?.focus();
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((was) => !was)}
        className="pressable flex w-full items-center gap-3 rounded-control bg-surface-2 px-4
                   text-left text-row text-text"
        style={{ minHeight: 'var(--button-height)' }}
      >
        <Swatch theme={value} />
        <span className="min-w-0 flex-1 truncate">{THEME_LABELS[value]}</span>
        <CaretDown
          size={16}
          className="shrink-0 text-text-secondary"
          style={{
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 200ms var(--ease-out)',
          }}
        />
      </button>

      <AnimatePresence custom={keyboard}>
        {open && (
          <motion.div
            id={listId}
            role="menu"
            aria-label="Theme"
            className="mt-2 overflow-hidden bg-surface py-2"
            style={{
              borderRadius: 'var(--radius-control)',
              border: 'var(--hairline-width) solid var(--hairline)',
              boxShadow: 'var(--shadow-md)',
            }}
            custom={keyboard}
            variants={{
              closed: (instant: boolean) => ({
                opacity: 0,
                y: -4,
                transition: instant ? { duration: 0 } : { duration: 0.18, ease: OUT },
              }),
              open: (instant: boolean) => ({
                opacity: 1,
                y: 0,
                transition: instant ? { duration: 0 } : { duration: 0.18, ease: OUT },
              }),
            }}
            initial="closed"
            animate="open"
            exit="closed"
          >
            {THEME_GROUPS.map((group) => (
              <div key={group.label} role="group" aria-label={group.label}>
                <p
                  className="px-4 pt-2 pb-1 text-section text-text-secondary"
                  style={{ textTransform: 'uppercase' }}
                >
                  {group.label}
                </p>
                {group.themes.map((theme) => (
                  <button
                    key={theme}
                    ref={(node) => {
                      rows.current[theme] = node;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={theme === value}
                    onClick={() => {
                      onChange(theme);
                      close(true);
                    }}
                    onKeyDown={(event) => onRowKeyDown(event, ORDER.indexOf(theme))}
                    className="pressable hoverable flex w-full items-center gap-3 px-4 text-left
                               text-row text-text"
                    style={{ minHeight: 'var(--tap-target)' }}
                  >
                    <Swatch theme={theme} />
                    <span className="min-w-0 flex-1 truncate">{THEME_LABELS[theme]}</span>
                    {theme === value && (
                      <Check size={18} weight="bold" className="shrink-0 text-accent" />
                    )}
                  </button>
                ))}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The split swatch: 20px at a 6px radius, divided on a 45° diagonal, the
 * lower-left half that theme's `--bg` and the upper-right half its `--accent`.
 * `linear-gradient(45deg, …)` runs bottom-left to top-right, which is that
 * split exactly, and hard stops at 50% keep it a division rather than a fade.
 *
 * The colours come from `THEME_SWATCHES` rather than from `var(--bg)`, and this
 * is the whole reason that manifest exists: `var(--bg)` inside this component
 * resolves to the *applied* theme, so every one of the eight rows would paint
 * the same swatch.
 *
 * The border is not `--hairline`. In a light theme that token is 8–10% black,
 * which at 1px around a near-white square against a white sheet is not a shape
 * — and a swatch that does not read as a shape is precisely what V2 §5.1 asks
 * this border to prevent. A fixed fraction of `--text` is a hairline in weight
 * and visible in both registers.
 */
function Swatch({ theme }: { theme: Theme }) {
  const { bg, accent } = THEME_SWATCHES[theme];

  return (
    <span
      aria-hidden="true"
      className="block shrink-0"
      style={{
        width: '20px',
        height: '20px',
        borderRadius: '6px',
        border: '1px solid color-mix(in srgb, var(--text) 22%, transparent)',
        background: `linear-gradient(45deg, ${bg} 0 50%, ${accent} 50% 100%)`,
      }}
    />
  );
}
