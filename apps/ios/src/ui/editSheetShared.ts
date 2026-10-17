import { StyleSheet } from 'react-native';
import { groupedGround, type ThemeColors, useStyles } from './theme.ts';

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

/**
 * The editor's shell and the pieces of its forms that are not grouped-list
 * rows (`GroupedList.tsx` draws the rows and cards): the Cancel · title ·
 * Save row, the notes above the form, the controls over the cards.
 */
const makeSheetStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    /** A number field at a row's end: the repeat interval, the occurrence count. */
    accessoryField: {
      color: colors.text,
      fontSize: 17,
      minWidth: 64,
      paddingVertical: 14,
      textAlign: 'right',
    },
    /** Save and Delete while a save or delete is running (a press does nothing then). */
    busy: {
      opacity: 0.4,
    },
    cancel: {
      color: colors['text-secondary'],
      fontSize: 17,
    },
    container: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    /**
     * The form's scroll content: the cards carry their own insets. Room
     * below the last control (Delete): on a phone the form can end
     * exactly at the home indicator, where a tap never lands (CI runs
     * 35591082639 and 35594605564 tapped Delete's cut-off edge).
     */
    content: {
      paddingBottom: 48,
      paddingTop: 4,
    },
    /** A failure above the form, in the cards' text inset. */
    formError: {
      color: colors.danger,
      fontSize: 13,
      lineHeight: 18,
      marginHorizontal: 32,
      marginTop: 12,
    },
    /** A note above the form (a read-only calendar or list). */
    formNote: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
      marginHorizontal: 32,
      marginTop: 12,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingBottom: 10,
      paddingHorizontal: 16,
      paddingTop: 16,
    },
    headerEnd: {
      alignItems: 'flex-end',
    },
    /** The header's sides are as wide as each other, so the title sits centred. */
    headerSide: {
      minWidth: 64,
    },
    hint: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
    },
    joinButton: {
      alignItems: 'center',
      backgroundColor: colors.success,
      borderRadius: 14,
      marginHorizontal: 16,
      marginTop: 12,
      paddingVertical: 12,
    },
    joinLabel: {
      color: colors['on-success'],
      fontSize: 15,
      fontWeight: '700',
    },
    // A row, so the kind control's own `flex: 1` (grow) stays horizontal.
    modeFlash: {
      flex: 1,
      flexDirection: 'row',
    },
    /** A date picker and its time picker, side by side at a row's end. */
    pickerPair: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 4,
    },
    readOnly: {
      opacity: 0.6,
    },
    save: {
      color: colors.primary,
      fontSize: 17,
      fontWeight: '600',
    },
    // The form-sheet editor's header: on the form's ground, as a Settings page's bar is.
    sheetHeader: {
      backgroundColor: groupedGround(colors),
    },
    title: {
      color: colors.text,
      flex: 1,
      fontSize: 17,
      fontWeight: '600',
      textAlign: 'center',
    },
    /** A control over the cards (the kind control, "Apply to"), in the cards' inset. */
    topControl: {
      flexDirection: 'row',
      marginHorizontal: 16,
      marginTop: 12,
    },
  });

export type SheetStyles = ReturnType<typeof makeSheetStyles>;

/** The edit sheets' shared styles, in the current appearance. */
export const useSheetStyles = () => useStyles(makeSheetStyles);
