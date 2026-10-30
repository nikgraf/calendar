import type { ReactNode } from 'react';

const base =
  'inline-flex items-center justify-center rounded-control px-5 py-3 font-medium no-underline transition-colors duration-[120ms]';

const buttonClass = {
  // On the dark download band: a light button on the ink ground.
  inverted: `${base} bg-on-primary text-primary hover:bg-highlight`,
  invertedOutline: `${base} border border-on-primary/40 text-on-primary hover:border-on-primary`,
  outline: `${base} border border-hairline-strong text-ink hover:bg-fill`,
  primary: `${base} bg-primary text-on-primary hover:bg-primary-hover`,
} as const;

export function ButtonLink({
  children,
  href,
  variant = 'primary',
}: {
  children: ReactNode;
  href: string;
  variant?: keyof typeof buttonClass;
}) {
  return (
    <a className={buttonClass[variant]} href={href}>
      {children}
    </a>
  );
}
