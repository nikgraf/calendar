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

/** Shared radii, matching the desktop's `--radius-*` tokens. */
export const RADIUS = { control: 8, event: 6, popover: 12 } as const;
