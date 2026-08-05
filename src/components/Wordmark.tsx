/**
 * The wordmark — the lettermark image, in place of the styled "tasks" text
 * this used to be. See index.css for the theme-swap it relies on and why two
 * images exist at all.
 *
 * A `role="img"`/`aria-label` wrapper around two decorative (`alt=""`)
 * `<img>`s rather than one `<img>` with a JS-computed `src`: which theme is
 * active is already known before first paint (`data-theme` is set from
 * module scope, per `lib/theme.ts`), and picking the image in CSS off that
 * same attribute means this never has to read the store, never re-renders on
 * a theme change it would otherwise have to subscribe to, and never has a
 * frame where the wrong logo was showing.
 *
 * `className` is required and has to set a height (`h-*`) — the two `<img>`s
 * are `h-full w-auto`, so the caller sizing the wrapper is what "roughly the
 * same size as the text was" means in practice: match the font-size the text
 * this replaces used, at each of its breakpoints.
 */

export function Wordmark({ className }: { className: string }) {
  return (
    <span role="img" aria-label="tasks" className={`inline-flex shrink-0 items-center ${className}`}>
      <img src="/brand/tasks-full.png" alt="" className="wordmark-on-light h-full w-auto" />
      <img src="/brand/tasks-full-on-dark.png" alt="" className="wordmark-on-dark h-full w-auto" />
    </span>
  );
}
