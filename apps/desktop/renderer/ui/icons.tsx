import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  readonly size?: number;
}

/**
 * The icon set: 24-unit stroke paths drawn in `currentColor`, so an icon
 * takes the text color of its button. Decorative by default — the button
 * carries the name.
 */
function Icon({ children, size = 16, ...rest }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      aria-hidden
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
      width={size}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16.5v.5" />
  </Icon>
);
export const BellIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4" />
  </Icon>
);
export const CakeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 20h16M5 20v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7M12 11V8M12 4.5v.5" />
  </Icon>
);
export const CalendarIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect height="16" rx="2" width="18" x="3" y="5" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Icon>
);
export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const CheckCircleIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </Icon>
);
export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);
export const ChevronLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M15 18l-6-6 6-6" />
  </Icon>
);
export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 18l6-6-6-6" />
  </Icon>
);
export const ClockIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const CloudCheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 9.5 3.5 3.5 0 0 1 17 18z" />
    <path d="M9 13.5l2 2 4-4" />
  </Icon>
);
export const CloudUpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 9.5 3.5 3.5 0 0 1 17 18z" />
    <path d="M12 16v-5M9.5 13.5 12 11l2.5 2.5" />
  </Icon>
);
export const GlobeIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" />
  </Icon>
);
export const ListIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 6h14M5 12h14M5 18h9" />
  </Icon>
);
export const MapPinIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z" />
    <circle cx="12" cy="10" r="2.5" />
  </Icon>
);
export const MicIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect height="12" rx="3" width="6" x="9" y="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Icon>
);
export const MoreIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={3}>
    <path d="M5 12h.01M12 12h.01M19 12h.01" />
  </Icon>
);
export const PencilIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />
  </Icon>
);
export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const RepeatIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" />
  </Icon>
);
export const RobotIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4v3" />
    <rect height="12" rx="2" width="16" x="4" y="7" />
    <path d="M9 13v1M15 13v1" />
  </Icon>
);
export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Icon>
);
export const SidebarIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect height="14" rx="1" width="18" x="3" y="5" />
    <path d="M9 5v14" />
  </Icon>
);
export const SlidersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" />
  </Icon>
);
export const SparkleIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" />
  </Icon>
);
export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />
  </Icon>
);
export const UsersIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="9" cy="7.5" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
  </Icon>
);
export const VideoIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect height="10" rx="1" width="13" x="2" y="7" />
    <path d="M15 10.5l6-3.5v10l-6-3.5" />
  </Icon>
);
export const XIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

/** The settings panes' icons, keyed by pane id. */
export const PANE_ICON_PATHS = {
  accounts: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c.6-3.4 3.4-5.5 7-5.5s6.4 2.1 7 5.5" />
    </>
  ),
  agents: (
    <>
      <rect height="15" rx="3" width="18" x="3" y="4.5" />
      <path d="m7.5 10 2.5 2.25L7.5 14.5M12.5 14.5h4" />
    </>
  ),
  file: (
    <>
      <path d="M13.5 3.5h-6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5z" />
      <path d="M13.5 3.5v5h5M9 13h6M9 16.5h4" />
    </>
  ),
  general: (
    <>
      <circle cx="12" cy="12" r="6.25" />
      <circle cx="12" cy="12" r="2.25" />
      <path d="M12 3v2.75M12 18.25V21M3 12h2.75M18.25 12H21M5.64 5.64l1.94 1.94M16.42 16.42l1.94 1.94M5.64 18.36l1.94-1.94M16.42 7.58l1.94-1.94" />
    </>
  ),
  mirrors: (
    <>
      <rect height="11" rx="2" width="8" x="3" y="6.5" />
      <rect height="11" rx="2" width="8" x="13" y="6.5" />
      <path d="M9.5 12h5m-1.5-1.5 1.5 1.5-1.5 1.5" />
    </>
  ),
  notifications: (
    <>
      <path d="M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 2H5z" />
      <path d="M10 20.5a2.1 2.1 0 0 0 4 0" />
    </>
  ),
} as const;

export function PaneIcon({
  pane,
  ...props
}: IconProps & { readonly pane: keyof typeof PANE_ICON_PATHS }) {
  return <Icon {...props}>{PANE_ICON_PATHS[pane]}</Icon>;
}
