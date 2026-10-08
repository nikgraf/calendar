import {
  useBackendMutations,
  useBirthdayReminderOverrides,
  useBirthdayReminderSettings,
  useSettingsEditor,
} from '@calendar/app-state';
import {
  BIRTHDAY_LEAD_DAYS,
  DEVICE_ONLY_SETTING_COPY,
  type BirthdayLeadDays,
  type BirthdayReminderSettings,
  leadDaysLabel,
  leadDaysSummary,
} from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { dateFromParts, toTimeString } from './editSheetShared.ts';
import { NotificationsDenied, useNotificationPermission } from './NotificationsDenied.tsx';
import { useSectionStyles } from './settingsShared.ts';
import { type ThemeColors, useStyles } from './theme.ts';

/**
 * Lead times and delivery time for birthday notifications. Device-local
 * by design (the first setting that does not sync), and the copy says so.
 */
export function BirthdayRemindersSection() {
  const sectionStyles = useSectionStyles();
  const styles = useStyles(makeStyles);
  const { setBirthdayReminderOverride, setBirthdayReminderSettings } = useBackendMutations();
  const overrides = useBirthdayReminderOverrides() ?? [];
  const [settings, persist] = useSettingsEditor(
    useBirthdayReminderSettings(),
    setBirthdayReminderSettings,
  );
  const [failure, setFailure] = useState<string | null>(null);
  // The last save found notifications not allowed (it may have just asked).
  const [refused, setRefused] = useState(false);
  const [permission, recheck] = useNotificationPermission();

  if (!settings) {
    return null;
  }
  const denied =
    settings.enabled && permission !== 'granted' && (refused || permission === 'denied');
  const save = (next: Partial<BirthdayReminderSettings>) =>
    void persist(next).then(
      ({ notificationsGranted }) => {
        setFailure(null);
        setRefused(!notificationsGranted);
        recheck();
      },
      (error: unknown) => setFailure(String(error)),
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
      {overrides.length > 0 ? (
        <View style={styles.overrides} testID="birthday-overrides">
          <Text style={styles.overridesTitle}>CUSTOM PER PERSON</Text>
          {overrides.map((override, index) => (
            <View
              key={`${override.displayName}:${String(override.month)}-${String(override.day)}`}
              style={styles.overrideRow}
            >
              <Text numberOfLines={1} style={styles.overrideName}>
                {override.displayName}
                <Text style={sectionStyles.meta}> · {leadDaysSummary(override.leadDays)}</Text>
              </Text>
              <Pressable
                accessibilityLabel={`Reset reminders for ${override.displayName}`}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() =>
                  void setBirthdayReminderOverride({ ...override, leadDays: null }).catch(
                    (error: unknown) => setFailure(String(error)),
                  )
                }
                testID={`birthday-override-reset-${String(index)}`}
              >
                <Text style={styles.reset}>Reset</Text>
              </Pressable>
            </View>
          ))}
          <Text style={sectionStyles.meta}>
            Change a person&apos;s reminders from their birthday in the calendar.
          </Text>
        </View>
      ) : null}
      {denied ? <NotificationsDenied testID="birthday-notifications-denied" /> : null}
      {failure ? (
        <Text style={sectionStyles.action} testID="birthday-notifications-failed">
          {failure}
        </Text>
      ) : null}
      <Text style={sectionStyles.meta} testID="birthday-device-only">
        {DEVICE_ONLY_SETTING_COPY}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: 1,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    chipActive: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    chipLabel: {
      color: colors.text,
      fontSize: 13,
    },
    chipLabelActive: {
      color: colors['on-primary'],
      fontWeight: '600',
    },
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 10,
    },
    label: {
      color: colors.text,
      fontSize: 14,
    },
    overrideName: {
      color: colors.text,
      flexShrink: 1,
      fontSize: 14,
    },
    overrideRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'space-between',
      paddingVertical: 4,
    },
    overrides: {
      marginTop: 12,
    },
    overridesTitle: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      marginBottom: 2,
    },
    pickerRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 10,
    },
    reset: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: '600',
    },
    switchRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 10,
    },
  });
