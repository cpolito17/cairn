/**
 * The Planner — placeholder. PROJECT-SPEC-V2.md §6.
 *
 * As with Blockers: issue 24 builds the route and the selector segment that
 * reach this view, and the calendar itself is a later issue. The working-hours
 * setting the planner will read is already writable from the settings sheet,
 * which is why it is stated here — it is set, it is persisted, and it is simply
 * not drawn yet.
 */

import { EmptyLine } from '../components/ui/Section';

export function Planner() {
  return (
    <>
      <h1 className="mb-section text-board-title text-text">Planner</h1>
      <EmptyLine>
        The calendar lands in a later issue. Your working hours are already saved
        in settings.
      </EmptyLine>
    </>
  );
}
