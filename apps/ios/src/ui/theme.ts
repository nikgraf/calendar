import {
  eventTint,
  type EventTint,
  THEMES,
  type ThemeColors,
  type ThemeScheme,
} from '@calendar/core';
import { useColorScheme } from 'react-native';

export { contrastingTextColor as chipTextColor } from '@calendar/core';

/**
 * The brand tokens for the appearance the phone is in. Static layout stays
 * in `StyleSheet.create`; colors come from here at render time so a flip
 * of the system appearance re-themes every screen.
 */
export const useTheme = (): { colors: ThemeColors; scheme: ThemeScheme } => {
  const scheme: ThemeScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { colors: THEMES[scheme], scheme };
};

/** The fill, text and edge colors a calendar-colored item takes in the current appearance. */
export const useEventTint = (hex: string): EventTint => eventTint(hex, useTheme().scheme);

/** The light-only palette the screens were built on; `useTheme` replaces it screen by screen. */
export const palette = {
  background: '#fafafa',
  border: '#e5e5e5',
  gridLine: '#f0f0f0',
  text: '#171717',
  textFaint: '#a3a3a3',
  textMuted: '#737373',
  /** Overdue task chips and dots: the same red as the today ring. */
  overdue: '#dc2626',
  today: '#ef4444',
};
