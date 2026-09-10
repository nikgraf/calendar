import { StyleSheet } from 'react-native';
import { palette } from './theme.ts';

/** Card chrome shared by the Settings sections (accounts, PR preview, diagnostics). */
export const sectionStyles = StyleSheet.create({
  action: {
    color: '#d97706',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  busy: {
    opacity: 0.5,
  },
  card: {
    backgroundColor: '#ffffff',
    borderColor: palette.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 16,
    padding: 12,
  },
  meta: {
    color: palette.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
});
