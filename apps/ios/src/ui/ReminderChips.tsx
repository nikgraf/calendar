import type { useEventEditorModel } from '@calendar/app-state';
import {
  ALL_DAY_REMINDER_PRESET_MINUTES,
  MAX_REMINDER_OVERRIDES,
  REMINDER_PRESET_MINUTES,
  reminderLabel,
} from '@calendar/core';
import { Pressable, Switch, Text, View } from 'react-native';
import { sheetStyles as styles } from './editSheetShared.ts';

/**
 * The event's reminders as toggle chips, one per preset offset (an
 * offset set elsewhere joins the row selected). Google events get a
 * "Calendar default" switch above the chips; Apple events never can,
 * EventKit alarms being explicit. Email reminders are listed, not
 * edited, and ride along on the write-back.
 */
export function ReminderChips({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const {
    addReminder,
    calendarDefaultReminders,
    canUseDefaultReminders,
    isAllDay,
    readOnly,
    reminders,
    removeReminder,
    setUseDefaultReminders,
  } = model;
  const presets: ReadonlyArray<number> = isAllDay
    ? ALL_DAY_REMINDER_PRESET_MINUTES
    : REMINDER_PRESET_MINUTES;
  const popups = reminders.overrides
    .map((override, index) => ({ index, override }))
    .filter(({ override }) => override.method === 'popup');
  const emails = reminders.overrides.filter((override) => override.method === 'email');
  const offsets = [
    ...new Set([...presets, ...popups.map(({ override }) => override.minutes)]),
  ].sort((a, b) => a - b);
  const useDefault = canUseDefaultReminders && reminders.useDefault;
  const full = reminders.overrides.length >= MAX_REMINDER_OVERRIDES;
  const defaultCaption =
    calendarDefaultReminders.length === 0
      ? 'none'
      : calendarDefaultReminders
          .map((minutes) => reminderLabel(minutes, isAllDay).toLowerCase())
          .join(', ');

  const toggle = (minutes: number) => {
    const selected = popups.find(({ override }) => override.minutes === minutes);
    if (selected) {
      removeReminder(selected.index);
    } else {
      addReminder(minutes);
    }
  };

  return (
    <View testID="event-reminders">
      <Text style={styles.label}>Notifications</Text>
      {canUseDefaultReminders ? (
        <View style={styles.switchRow}>
          <Text style={styles.calendarName}>Calendar default ({defaultCaption})</Text>
          <Switch
            disabled={readOnly}
            onValueChange={setUseDefaultReminders}
            testID="event-reminders-default"
            value={reminders.useDefault}
          />
        </View>
      ) : null}
      {useDefault ? null : (
        <View style={styles.scopeRow}>
          {offsets.map((minutes) => {
            const selected = popups.some(({ override }) => override.minutes === minutes);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                disabled={readOnly || (full && !selected)}
                key={minutes}
                onPress={() => toggle(minutes)}
                style={[styles.scopeChip, selected && styles.scopeChipActive]}
                testID={`event-reminder-${String(minutes)}${selected ? '-on' : ''}`}
              >
                <Text style={[styles.scopeLabel, selected && styles.scopeLabelActive]}>
                  {reminderLabel(minutes, isAllDay)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {emails.map((override) => (
        <Text key={`email-${String(override.minutes)}`} style={styles.calendarName}>
          Email · {reminderLabel(override.minutes, isAllDay)}
        </Text>
      ))}
    </View>
  );
}
