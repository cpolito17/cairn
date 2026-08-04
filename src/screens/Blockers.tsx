/**
 * Blockers — placeholder. PROJECT-SPEC-V2.md §7.
 *
 * Issue 24 builds the shell that reaches this view: the route, the selector
 * segment, and the back/forward behaviour around it. The dependency graph
 * itself is a later issue, so this renders the app's own empty state — one
 * quiet typographic line, no illustration (§8.4) — rather than a stub that
 * looks like a broken screen.
 */

import { EmptyLine } from '../components/ui/Section';

export function Blockers() {
  return (
    <>
      <h1 className="mb-section text-board-title text-text">Blockers</h1>
      <EmptyLine>
        The dependency graph lands in a later issue. Nothing to show here yet.
      </EmptyLine>
    </>
  );
}
