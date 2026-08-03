/**
 * Buttons. PROJECT-SPEC.md §8.4 (three tiers, one primary per view), §8.5
 * (press feedback on pointer-down).
 *
 * Loading swaps the label for a spinner *inside the same pill*: the label stays
 * in the layout with `visibility: hidden` and the spinner is overlaid, so the
 * button cannot change size at the exact moment the user is looking at it.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  fullWidth?: boolean;
  /** A leading Phosphor glyph, 20px, already coloured by the variant. */
  icon?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  // Fully-rounded pill, accent fill, --on-accent at 600.
  primary: 'rounded-pill bg-accent text-on-accent',
  // Same pill shape, accent tint, accent text.
  secondary: 'rounded-pill bg-accent-tint text-accent',
  // Plain accent text, no container.
  tertiary: 'rounded-chip text-accent',
  destructive: 'rounded-pill bg-transparent text-negative',
};

export function Button({
  variant = 'primary',
  loading = false,
  fullWidth = false,
  icon,
  children,
  className = '',
  disabled,
  type = 'button',
  style,
  ...rest
}: ButtonProps) {
  const container = variant === 'tertiary';

  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        'pressable relative inline-flex items-center justify-center gap-2 select-none',
        // Disabled is reduced opacity on the same shape, never a grey restyle.
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        container ? 'px-2 py-2' : 'px-5',
        fullWidth ? 'w-full' : '',
        className,
      ].join(' ')}
      // A caller's `style` is merged rather than spread over the top: the pill's
      // height and type scale are part of the tier, and a one-off colour must
      // not silently take them with it.
      style={{
        // Tertiary has no container, so it does not carry the 48px pill height.
        height: container ? 'auto' : 'var(--button-height)',
        minHeight: container ? 'var(--tap-target)' : undefined,
        fontSize: 'var(--text-row)',
        fontWeight: variant === 'primary' ? 600 : 500,
        ...style,
      }}
      {...rest}
    >
      <span
        className="inline-flex items-center gap-2"
        style={{ visibility: loading ? 'hidden' : undefined }}
      >
        {icon}
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      )}
    </button>
  );
}

/**
 * The in-button spinner. Linear easing is legal for spinners and shimmers and
 * nowhere else (§8.5), and `data-motion="essential"` keeps it turning under
 * `prefers-reduced-motion` — a frozen spinner reads as a hung app.
 */
export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      data-motion="essential"
      className="block rounded-pill"
      style={{
        width: size,
        height: size,
        border: '2px solid color-mix(in srgb, currentColor 28%, transparent)',
        borderTopColor: 'currentColor',
        animation: 'cairn-spin 700ms linear infinite',
      }}
    />
  );
}
