import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ children, size = 24, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {children}
    </svg>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </Icon>
  );
}

export function CloudOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.3 8.2M3 3l18 18M4.5 9.5A4 4 0 0 0 7 18" />
    </Icon>
  );
}

export function CakeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20h16M4 20v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7M4 15c1.5 1.3 3 1.3 4.5 0s3-1.3 4.5 0 3 1.3 4.5 0 2-1 2.5-.7M8 11V8M12 11V8M16 11V8M8 5.5c0-1 .8-2 .8-2s.7 1 .7 2a.75.75 0 0 1-1.5 0zM12 5.5c0-1 .8-2 .8-2s.7 1 .7 2a.75.75 0 0 1-1.5 0zM16 5.5c0-1 .8-2 .8-2s.7 1 .7 2a.75.75 0 0 1-1.5 0z" />
    </Icon>
  );
}

/** A plain apple outline, not Apple's logo. */
export function AppleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 8c-1.4-1.3-3.5-1.5-5 .1-2.3 2.4-1.3 7.3 1 10 1 1.2 2.3 1.7 3.5 1.1h1c1.2.6 2.5.1 3.5-1.1 2.3-2.7 3.3-7.6 1-10-1.5-1.6-3.6-1.4-5-.1zM12 8c0-2 1-3.5 3-4" />
    </Icon>
  );
}

/** A four-square grid, not Google's logo. */
export function GoogleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="7" rx="1.5" width="7" x="3.5" y="3.5" />
      <rect height="7" rx="1.5" width="7" x="13.5" y="3.5" />
      <rect height="7" rx="1.5" width="7" x="3.5" y="13.5" />
      <rect height="7" rx="1.5" width="7" x="13.5" y="13.5" />
    </Icon>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Icon strokeWidth={2} {...props}>
      <rect height="12" rx="3" width="6" x="9" y="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </Icon>
  );
}

export function SparkleIcon({ size = 12, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      <path d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2z" />
    </svg>
  );
}
