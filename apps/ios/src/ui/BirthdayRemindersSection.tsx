import { useBackendMutations, useBirthdayReminderSettings } from '@calendar/app-state';
import {
  BIRTHDAY_LEAD_DAYS,
  BIRTHDAY_REMINDERS_DEVICE_ONLY,
  type BirthdayLeadDays,
  type BirthdayReminderSettings,
  leadDaysLabel,
} from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { dateFromParts, toTimeString } from './editSheetShared.ts';
import { sectionStyles } from './settingsShared.ts';
import { palette } from './theme.ts';

/**
 * Lead times and delivery time for birthday notifications. Device-local
 * by design (the first setting that does not sync), and the copy says so.
 */
export function BirthdayRemindersSection() {
  const settings = useBirthdayReminderSettings();
  const { setBirthdayReminderSettings } = useBackendMutations();
  const [notice, setNotice] = useState<string | null>(null);

  if (!settings) {
    return null;
  }
  const save = (next: Partial<BirthdayReminderSettings>) =>
    void setBirthdayReminderSettings({ ...settings, ...next }).then(
      ({ notificationsGranted }) =>
        setNotice(
          notificationsGranted
            ? null
            : 'Notifications are off — allow Solunivo under Settings › Notifications.',
        ),
      (error: unknown) => setNotice(String(error)),
    );
  const toggleLead = (lead: BirthdayLeadDays) => {
    const on = settings.leadDays.includes(lead);
    save({
      leadDays: on
        ? settings.leadDays.filter((value) => value !== lead)
        : [...settings.leadDays, lead],
    });
  };

  return (
    <View style={sectionStyles.card} testID="birthday-reminders">
      <Text style={sectionStyles.title}>Birthday reminders</Text>
      <Text style={sectionStyles.meta}>
        A notification for every contact birthday, at the lead times you pick.
      </Text>
      <View style={styles.switchRow}>
        <Text style={styles.label}>Remind me about birthdays</Text>
        <Switch
          onValueChange={(enabled) => save({ enabled })}
          testID="birthday-reminders-enabled"
          value={settings.enabled}
        />
      </View>
      <View style={[styles.chips, !settings.enabled && sectionStyles.busy]}>
        {BIRTHDAY_LEAD_DAYS.map((lead) => {
          const selected = settings.leadDays.includes(lead);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={lead}
              onPress={() => toggleLead(lead)}
              style={[styles.chip, selected && styles.chipActive]}
              // The suffix lets the e2e flow assert the state without a query.
              testID={`birthday-lead-${String(lead)}${selected ? '-on' : ''}`}
            >
              <Text style={[styles.chipLabel, selected && styles.chipLabelActive]}>
                {leadDaysLabel(lead)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.pickerRow}>
        <Text style={styles.label}>Time</Text>
        <DateTimePicker
          display="compact"
          mode="time"
          onChange={(_, picked) => picked && save({ time: toTimeString(picked) })}
          value={dateFromParts('2026-01-01', settings.time)}
        />
      </View>
      {notice ? (
        <Text style={sectionStyles.action} testID="birthday-notifications-denied">
          {notice}
        </Text>
      ) : null}
      <Text style={sectionStyles.meta} testID="birthday-device-only">
        {BIRTHDAY_REMINDERS_DEVICE_ONLY}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderColor: palette.border,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  chipLabel: {
    color: palette.text,
    fontSize: 13,
  },
  chipLabelActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  label: {
    color: palette.text,
    fontSize: 14,
  },
  pickerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
});
