import type { RecurrenceFrequency, RecurringScope, RsvpResponse } from '@calendar/core';
import { StyleSheet } from 'react-native';
import { palette } from './theme.ts';

/**
 * The editor model stores wall-clock strings (YYYY-MM-DD / HH:MM) shared
 * with desktop; the native pickers speak JS Date. On iOS the editor's
 * zone is the device zone, so local-time Dates round-trip exactly.
 * Degenerate strings fall back to today 09:00 — a picker must never
 * receive an Invalid Date.
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

export const RSVPS: ReadonlyArray<{ label: string; value: RsvpResponse }> = [
  { label: 'Accept', value: 'accepted' },
  { label: 'Maybe', value: 'tentative' },
  { label: 'Decline', value: 'declined' },
];

export const REPEATS: ReadonlyArray<{ label: string; value: RecurrenceFrequency | 'none' }> = [
  { label: 'None', value: 'none' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Yearly', value: 'yearly' },
];

export const REPEAT_ENDS: ReadonlyArray<{ label: string; value: 'after' | 'never' | 'on' }> = [
  { label: 'Never', value: 'never' },
  { label: 'After', value: 'after' },
  { label: 'On date', value: 'on' },
];

export const SCOPES: ReadonlyArray<{ label: string; value: RecurringScope }> = [
  { label: 'This event', value: 'instance' },
  { label: 'This + following', value: 'following' },
  { label: 'All events', value: 'series' },
];

export const sheetStyles = StyleSheet.create({
  attendee: {
    color: palette.textMuted,
    fontSize: 14,
    paddingVertical: 2,
  },
  calendarName: {
    color: palette.textMuted,
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
    color: palette.text,
    fontWeight: '600',
  },
  cancel: {
    color: palette.textMuted,
    fontSize: 16,
  },
  check: {
    color: '#2563eb',
    fontSize: 16,
    fontWeight: '700',
  },
  container: {
    backgroundColor: palette.background,
    flex: 1,
  },
  content: {
    padding: 16,
  },
  deleteButton: {
    alignItems: 'center',
    borderColor: '#fecaca',
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 24,
    paddingVertical: 12,
  },
  deleteLabel: {
    color: '#dc2626',
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: '#b91c1c',
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
    color: palette.textMuted,
    fontSize: 13,
    marginTop: 4,
  },
  input: {
    backgroundColor: '#ffffff',
    borderColor: palette.border,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  joinButton: {
    alignItems: 'center',
    backgroundColor: '#16a34a',
    borderRadius: 10,
    marginBottom: 12,
    paddingVertical: 10,
  },
  joinLabel: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  label: {
    color: palette.textMuted,
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
  save: {
    color: '#2563eb',
    fontSize: 16,
    fontWeight: '700',
  },
  scopeChip: {
    borderColor: palette.border,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  scopeChipActive: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  scopeLabel: {
    color: palette.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  scopeLabelActive: {
    color: '#ffffff',
  },
  scopeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
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
    fontSize: 17,
    fontWeight: '700',
  },
  webLink: {
    color: '#2563eb',
    fontSize: 14,
    marginTop: 4,
  },
});
