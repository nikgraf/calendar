import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'danger' | 'ghost' | 'primary' | 'secondary';

const VARIANT: Record<ButtonVariant, string> = {
  danger: 'text-danger hover:bg-fill',
  ghost: 'text-ink-secondary hover:bg-fill hover:text-ink',
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'bg-fill text-ink hover:bg-hairline',
};

const SIZE = {
  md: 'h-8 px-3 text-sm',
  sm: 'h-7 px-2.5 text-xs',
} as const;

/**
 * A text button in one of the four roles the design uses: the one filled
 * plum action of a surface, a soft-filled secondary, a quiet ghost, and a
 * red-text destructive one. Always `type="button"` unless told otherwise.
 */
export function Button({
  children,
  className = '',
  size = 'md',
  submit = false,
  variant = 'secondary',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  readonly children: ReactNode;
  readonly size?: keyof typeof SIZE;
  /** A form's submit button; everything else is a plain button. */
  readonly submit?: boolean;
  readonly variant?: ButtonVariant;
}) {
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-50 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      type={submit ? 'submit' : 'button'}
      {...rest}
    >
      {children}
    </button>
  );
}
