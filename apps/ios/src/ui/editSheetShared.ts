import { StyleSheet } from 'react-native';
import { type ThemeColors, useStyles } from './theme.ts';

/**
 * The editor models store wall-clock strings (YYYY-MM-DD / HH:MM) shared
 * with desktop; the native pickers speak JS Date. Reminders, tasks and
 * the birthday time are floating wall clock in the device zone, so
 * local-time Dates round-trip exactly here. Events are wall clock in the
 * primary zone instead: they go through pickerDates.ts. Degenerate
 * strings fall back to today 09:00 — a picker must never receive an
 * Invalid Date.
 */
export const dateFromParts = (date: string, time?: string): Date => {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = (time ?? '09:00').split(':').map(Number);
  if (!year || !month || !day) {
    return new Date();
  }
  const parsed = new Date(year, month - 1, day, hour ?? 9, minute ?? 0);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const pad2 = (value: number) => String(value).padStart(2, '0');

export const toDateString = (value: Date): string =>
  `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;

export const toTimeString = (value: Date): string =>
  `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;

// Option tables: REPEAT_OPTIONS, REPEAT_ENDS_OPTIONS, SCOPE_OPTIONS, RSVP_OPTIONS in
// @calendar/app-state (editorOptions); the chips render their `short` text.

const makeSheetStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    attendee: {
      color: colors['text-secondary'],
      fontSize: 14,
      paddingVertical: 2,
    },
    /** Save and Delete while a save or delete is running (a press does nothing then). */
    busy: {
      opacity: 0.4,
    },
    calendarGroup: {
      color: colors['text-secondary'],
      fontSize: 12,
      paddingTop: 8,
      textTransform: 'uppercase',
    },
    calendarName: {
      color: colors['text-secondary'],
      flex: 1,
      fontSize: 15,
    },
    calendarRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      paddingVertical: 6,
    },
    calendarSelected: {
      color: colors.text,
      fontWeight: '600',
    },
    cancel: {
      color: colors['text-secondary'],
      fontSize: 16,
    },
    check: {
      color: colors.primary,
      fontSize: 16,
      fontWeight: '700',
    },
    chip: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 8,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    chipDot: {
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    chipLabel: {
      color: colors.text,
      fontSize: 14,
    },
    chipMeta: {
      color: colors['text-secondary'],
      fontSize: 12,
    },
    chipRemove: {
      color: colors['text-secondary'],
      fontSize: 16,
      paddingHorizontal: 2,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: 8,
    },
    container: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    content: {
      padding: 16,
      // Room below the last control (Delete): on a phone the form can end
      // exactly at the home indicator, where a tap never lands (CI runs
      // 35591082639 and 35594605564 tapped Delete's cut-off edge).
      paddingBottom: 48,
    },
    deleteButton: {
      alignItems: 'center',
      borderColor: colors['event-blush'],
      borderRadius: 10,
      borderWidth: 1,
      marginTop: 24,
      paddingVertical: 12,
    },
    deleteLabel: {
      color: colors.danger,
      fontSize: 15,
      fontWeight: '600',
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      marginBottom: 10,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    hint: {
      color: colors['text-secondary'],
      fontSize: 13,
      marginTop: 4,
    },
    input: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      // A TextInput's ink defaults to black whatever the appearance.
      color: colors.text,
      fontSize: 16,
      marginBottom: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    joinButton: {
      alignItems: 'center',
      backgroundColor: colors.success,
      borderRadius: 10,
      marginBottom: 12,
      paddingVertical: 10,
    },
    joinLabel: {
      color: colors['on-primary'],
      fontSize: 15,
      fontWeight: '700',
    },
    label: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      marginBottom: 4,
      textTransform: 'uppercase',
    },
    modeRow: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    notesInput: {
      minHeight: 72,
      textAlignVertical: 'top',
    },
    pickerRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    readOnly: {
      opacity: 0.6,
    },
    readOnlyNote: {
      color: colors['text-secondary'],
      fontSize: 13,
      marginBottom: 8,
    },
    save: {
      color: colors.primary,
      fontSize: 16,
      fontWeight: '700',
    },
    scopeChip: {
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: 1,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    scopeChipActive: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    scopeChipDisabled: {
      opacity: 0.4,
    },
    scopeLabel: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '600',
    },
    scopeLabelActive: {
      color: colors['on-primary'],
    },
    scopeRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 14,
    },
    suggestion: {
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    suggestionMeta: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    suggestions: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      marginBottom: 12,
      marginTop: -6,
    },
    suggestionStale: {
      opacity: 0.5,
    },
    suggestionTitle: {
      color: colors.text,
      fontSize: 16,
    },
    swatch: {
      borderRadius: 4,
      height: 14,
      width: 14,
    },
    switchRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginVertical: 10,
    },
    timeField: {
      flex: 1,
    },
    timePicker: {
      alignSelf: 'flex-start',
    },
    timesRow: {
      flexDirection: 'row',
      gap: 12,
    },
    title: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '700',
    },
    webLink: {
      color: colors.primary,
      fontSize: 14,
      marginTop: 4,
    },
  });

export type SheetStyles = ReturnType<typeof makeSheetStyles>;

/** A selectable chip's style: the shared scope chip, filled when active. */
export const chip = (sheetStyles: SheetStyles, active: boolean) => [
  sheetStyles.scopeChip,
  active && sheetStyles.scopeChipActive,
];
export const chipLabel = (sheetStyles: SheetStyles, active: boolean) => [
  sheetStyles.scopeLabel,
  active && sheetStyles.scopeLabelActive,
];

/** The edit sheets' shared styles, in the current appearance. */
export const useSheetStyles = () => useStyles(makeSheetStyles);
