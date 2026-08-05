/**
 * The failed-load state the month grid and the year heat map share
 * (PROJECT-SPEC.md §8.4).
 *
 * Both views draw the same tasks through the same store, so both fail for the
 * same reason at the same moment, and the copy has to distinguish a dropped
 * connection from a server answering 500s in exactly the way `loadErrorMessage`
 * already does. One component rather than two, because the second copy is where
 * the retry button quietly goes missing.
 */

import { useStore } from '../../lib/store';
import { Button } from '../ui/Button';
import { ErrorLine, loadErrorMessage } from '../ui/Section';

export function PlannerError({ subject }: { subject: string }) {
  const load = useStore((state) => state.load);
  const failure = useStore((state) => state.failure);

  return (
    <ErrorLine
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      }
    >
      {loadErrorMessage(subject, failure)}
    </ErrorLine>
  );
}
