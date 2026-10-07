import type { ButtonHTMLAttributes, ReactNode } from 'react';

const SIZE = {
  md: 'size-8',
  sm: 'size-7',
} as const;

/**
 * A square button holding one icon. The label is the accessible name
 * (and the tooltip), so it is required — an icon alone says nothing to a
 * screen reader.
 */
export function IconButton({
  active = false,
  children,
  className = '',
  label,
  size = 'md',
  submit = false,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  /** Drawn as pressed: filled instead of ghost. */
  readonly active?: boolean;
  readonly children: ReactNode;
  readonly label: string;
  readonly size?: keyof typeof SIZE;
  /** A form's submit button; everything else is a plain button. */
  readonly submit?: boolean;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active || undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-control transition-colors disabled:cursor-default disabled:opacity-40 ${
        active ? 'bg-fill text-ink' : 'text-ink-secondary hover:bg-fill hover:text-ink'
      } ${SIZE[size]} ${className}`}
      title={label}
      type={submit ? 'submit' : 'button'}
      {...rest}
    >
      {children}
    </button>
  );
}
