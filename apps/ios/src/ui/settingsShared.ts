import { StyleSheet } from 'react-native';
import { type ThemeColors, useStyles } from './theme.ts';

/** Card chrome shared by the Settings sections (accounts, PR preview, diagnostics). */
const makeSectionStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: '600',
      marginTop: 2,
    },
    busy: {
      opacity: 0.5,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: 16,
      padding: 12,
    },
    meta: {
      color: colors['text-secondary'],
      fontSize: 12,
      marginTop: 2,
    },
    title: {
      fontSize: 15,
      fontWeight: '600',
    },
  });

/** The settings sections' shared card chrome, in the current appearance. */
export const useSectionStyles = () => useStyles(makeSectionStyles);
