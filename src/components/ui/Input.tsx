/**
 * Text input and textarea. PROJECT-SPEC.md §8.4 (Inputs).
 *
 * A `--surface-2` well at 12px radius with no border at rest; focus adds the
 * 2px accent ring. The label sits above at 13px/500 and the error below in
 * `--negative`. Validation is the caller's job — this component renders the
 * error it is handed, which keeps "validated on blur" a decision the form makes
 * rather than one every field re-invents.
 */

import { useId, type InputHTMLAttributes, type Ref, type TextareaHTMLAttributes } from 'react';

const WELL =
  'w-full rounded-control border-0 bg-surface-2 px-4 text-text outline-none ' +
  'placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-accent ' +
  'disabled:opacity-60';

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-2 block text-text-secondary"
      style={{ fontSize: '13px', fontWeight: 500 }}
    >
      {children}
    </label>
  );
}

function Error({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-2 text-meta text-negative">
      {children}
    </p>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label?: string;
  error?: string | null;
  /** React 19 passes `ref` as an ordinary prop; it is declared so TS sees it. */
  ref?: Ref<HTMLInputElement>;
}

export function Input({ label, error, id, ...rest }: InputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const errorId = `${inputId}-error`;

  return (
    <div>
      {label && <Label htmlFor={inputId}>{label}</Label>}
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={WELL}
        style={{ height: 'var(--button-height)', outlineOffset: '0px' }}
        {...rest}
      />
      {error && <Error id={errorId}>{error}</Error>}
    </div>
  );
}

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label?: string;
  error?: string | null;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ label, error, id, rows = 3, ...rest }: TextareaProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const errorId = `${inputId}-error`;

  return (
    <div>
      {label && <Label htmlFor={inputId}>{label}</Label>}
      <textarea
        id={inputId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`${WELL} resize-none py-3`}
        style={{ outlineOffset: '0px', lineHeight: 'var(--text-body-leading)' }}
        {...rest}
      />
      {error && <Error id={errorId}>{error}</Error>}
    </div>
  );
}
