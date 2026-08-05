/**
 * The behaviour a sheet and a modal share: escape to close, a focus trap while
 * open, focus restored to whatever opened it, and the page behind held still.
 *
 * It lives apart from both components because a half-implemented focus trap is
 * the kind of thing that gets copied rather than fixed.
 */

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useOverlay(
  open: boolean,
  onClose: () => void,
  container: RefObject<HTMLElement | null>,
  /**
   * Default true: focus the first focusable descendant, as below. Set false
   * for the one sheet where that descendant is a bare `<select>` with nothing
   * else ahead of it (the Planner's Unscheduled sort control) — focusing a
   * `<select>` programmatically pops its native picker open on some mobile
   * browsers, so "the first thing inside" is the wrong default there. `false`
   * still traps Tab and Escape exactly as `true` does; it only changes what
   * receives focus at the moment the overlay opens, falling back to the
   * container itself, same as an overlay with no focusable content at all.
   */
  autoFocus = true,
): void {
  // `onClose` is read through a ref rather than depended on.
  //
  // Callers define it in their render body — the composer's `requestClose`
  // consults the live draft — so it is a different function on every render,
  // and a render happens on every keystroke. With it in the dependency list
  // this effect tore itself down and set itself up again on each one, which
  // meant "focus the first thing inside" fired mid-typing and moved the caret
  // from the field the user was typing in to the close button. The trap has to
  // run once per *opening*, not once per render.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;

    const opener = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    // Focus the first thing inside rather than leaving the caret behind the
    // scrim, where the next Tab would walk the page underneath — unless the
    // caller already knows that's the wrong element to land on.
    const first = autoFocus ? container.current?.querySelector<HTMLElement>(FOCUSABLE) : null;
    (first ?? container.current)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !container.current) return;

      const nodes = Array.from(container.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [open, container, autoFocus]);
}
