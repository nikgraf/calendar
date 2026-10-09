/**
 * A box that asks or warns, the conflict banner's look: a raised surface
 * with an edge in its tone. The tones are text colors that flip with the
 * appearance, so the edge carries the meaning and the box stays a surface
 * — a tinted fill was a bright box in dark mode.
 */
export const CALLOUT_CLASS = {
  danger:
    'rounded-control border border-l-4 border-hairline border-l-danger bg-surface-raised text-ink',
  warning:
    'rounded-control border border-l-4 border-hairline border-l-warning bg-surface-raised text-ink',
} as const;
