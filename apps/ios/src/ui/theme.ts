import {
  eventTint,
  type EventTint,
  THEMES,
  type ThemeColors,
  type ThemeScheme,
} from '@calendar/core';
import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

export { contrastingTextColor as chipTextColor } from '@calendar/core';
export type { ThemeColors };

/**
 * The brand tokens for the appearance the phone is in. Static layout stays
 * in `StyleSheet.create`; colors come from here at render time so a flip
 * of the system appearance re-themes every screen.
 */
export const useTheme = (): { colors: ThemeColors; scheme: ThemeScheme } => {
  const scheme: ThemeScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { colors: THEMES[scheme], scheme };
};

/**
 * A style sheet built from the theme: `const styles = useStyles(makeStyles)`
 * with a module-level `makeStyles = (colors: ThemeColors) => StyleSheet.create(…)`.
 * The sheet is rebuilt only when the appearance flips (`THEMES[scheme]` is
 * one object per scheme), so the component keeps stable style references.
 */
export const useStyles = <T>(make: (colors: ThemeColors) => T): T => {
  const { colors } = useTheme();
  return useMemo(() => make(colors), [colors, make]);
};

/** The fill, text and edge colors a calendar-colored item takes in the current appearance. */
export const useEventTint = (hex: string): EventTint => eventTint(hex, useTheme().scheme);

/**
 * The ground under grouped lists (Settings): iOS draws white rows on a
 * tinted background in light mode and lighter rows on the canvas in dark,
 * so light takes `fill` and dark stays on `canvas`. `THEMES[scheme]` is
 * one object per scheme, which is what lets this tell them apart.
 */
export const groupedGround = (colors: ThemeColors): string =>
  colors === THEMES.dark ? colors.canvas : colors.fill;

/**
 * Each zone's text color by its place in the list, primary first: the same
 * in the hour gutter, its city header, the detail sheet and the editor, so
 * a shade says which zone a time belongs to (the desktop's `zoneInk`).
 * Only drawn while there is more than one zone.
 */
export const zoneColor = (colors: ThemeColors, index: number): string =>
  [colors.text, colors['text-secondary'], colors['text-tertiary']][Math.min(index, 2)]!;

/**
 * Text that acts — Save, Undo, Open in Maps, an action row: `primary` in
 * semibold, spread first into a style (`{ ...actionText(colors), fontSize }`).
 * `primary` is the text's own charcoal, so the weight is what sets an action
 * apart from the words beside it. Cancel and Close take secondary text
 * instead, as the editor's Cancel does.
 */
export const actionText = (colors: ThemeColors): { color: string; fontWeight: '600' } => ({
  color: colors.primary,
  fontWeight: '600',
});

/** Shared radii, matching the desktop's `--radius-*` tokens. */
export const RADIUS = { control: 8, event: 6, popover: 12 } as const;

/**
 * The largest Dynamic Type scale for text whose box cannot grow — passed as
 * `maxFontSizeMultiplier`: event and task blocks on the grid, all-day chips
 * and "+N more", the hour gutter, the day numbers in their circles (the
 * week strip, the timeline's header, the month), glyphs in fixed buttons
 * ("+", the dictation mic, an avatar's initial), and the bars along the
 * top — the calendar's header and the sheets' Cancel · title · Save rows,
 * where the system's own bars do not grow with the text size at all. 1.35
 * is xxxLarge, the largest standard size: the five accessibility sizes
 * above it pushed that text out of its box, and Save off the screen.
 * Everything else — sheet content, forms, lists, Settings, the agenda,
 * the notices — scales fully, growing its box instead.
 */
export const BOX_FONT_SCALE = 1.35;
