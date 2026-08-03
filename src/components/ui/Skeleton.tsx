/**
 * Loading skeletons. PROJECT-SPEC.md §8.4 ("skeleton rows matching the real row
 * geometry with a shimmer — never a lone centered spinner in a content area").
 *
 * The shimmer is a band translated across the block, not an animated
 * background-position: §8.5 permits transform and opacity only, and linear
 * easing is legal for shimmers. Under `prefers-reduced-motion` the band stops
 * and the block stays as a plain recessed placeholder.
 */

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string;
  className?: string;
}

export function Skeleton({
  width = '100%',
  height = '1rem',
  radius = 'var(--radius-chip)',
  className = '',
}: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`relative block overflow-hidden bg-surface-2 ${className}`}
      style={{ width, height, borderRadius: radius }}
    >
      <span className="cairn-shimmer" />
    </span>
  );
}

/** A skeleton matching the task row's geometry: checkbox, name, chip cluster. */
export function SkeletonRow() {
  return (
    <div
      className="flex items-center gap-3 rounded-control bg-surface px-4"
      style={{ minHeight: 'var(--row-height)' }}
    >
      <Skeleton width={24} height={24} radius="var(--radius-chip)" />
      <Skeleton width="45%" height="1rem" />
      <span className="flex-1" />
      <Skeleton width={56} height="0.75rem" />
    </div>
  );
}

/** A skeleton matching the board card: title, description, bar, count. */
export function SkeletonCard() {
  return (
    <div
      className="rounded-card bg-surface p-5"
      style={{ border: 'var(--hairline-width) solid var(--hairline)' }}
    >
      <Skeleton width="55%" height="1.25rem" />
      <div className="mt-3">
        <Skeleton width="80%" height="0.875rem" />
      </div>
      <div className="mt-5">
        <Skeleton width="100%" height="var(--progress-height)" radius="var(--radius-pill)" />
      </div>
      <div className="mt-3">
        <Skeleton width={72} height="0.75rem" />
      </div>
    </div>
  );
}
