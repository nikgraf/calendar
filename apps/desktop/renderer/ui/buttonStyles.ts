/** The Settings panes' bordered button: Add time zone…, Clear location cache, Add mirror…, Add agent, the settings file's actions. */
export const SETTINGS_BUTTON_CLASS =
  'rounded-lg border border-hairline-strong px-3 py-1.5 text-sm hover:bg-surface-subtle disabled:opacity-50';

/*
 * Text that acts. `primary` is the text's own charcoal, so its color no
 * longer sets an action apart from the words around it: a second cue does.
 * Sizes and margins stay with each site.
 */

/**
 * An action word inside a sentence (…add them in Calendar. Open Calendar):
 * underlined all the time in the control-boundary grey, which turns the
 * word's own color on hover.
 */
export const TEXT_LINK_CLASS =
  'text-primary underline decoration-hairline-strong underline-offset-2 not-disabled:hover:decoration-current disabled:opacity-50';

/**
 * A text action that stands on its own (Make primary, Open in Maps, Copy,
 * Remove): set in medium and underlined on hover, in `primary` or, for one
 * that removes, `danger`.
 */
export const TEXT_ACTION_CLASS = {
  danger:
    'font-medium text-danger underline-offset-2 not-disabled:hover:underline disabled:opacity-50',
  primary:
    'font-medium text-primary underline-offset-2 not-disabled:hover:underline disabled:opacity-50',
} as const;
