import { useBackendMutations, useEventNotificationSettings } from '@calendar/app-state';
import { DEVICE_ONLY_SETTING_COPY, type EventNotificationSettings } from '@calendar/core';
import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { sectionStyles } from './settingsShared.ts';
import { palette } from './theme.ts';

/**
 * Whether event reminders notify on this iPhone, and whether Apple
 * Calendar events count too (the Calendar app already notifies for
 * those, so that one is off unless asked). Device-local like the
 * birthday reminders; every enabled save asks for permission.
 */
export function EventNotificationsSection() {
  const settings = useEventNotificationSettings();
  const { setEventNotificationSettings } = useBackendMutations();
  const [notice, setNotice] = useState<string | null>(null);

  if (!settings) {
    return null;
  }
  const save = (next: Partial<EventNotificationSettings>) =>
    void setEventNotificationSettings({ ...settings, ...next }).then(
      ({ notificationsGranted }) =>
        setNotice(
          notificationsGranted
            ? null
            : 'Notifications are off — allow Solunivo under Settings › Notifications.',
        ),
      (error: unknown) => setNotice(String(error)),
    );

  return (
    <View style={sectionStyles.card} testID="event-notifications">
      <Text style={sectionStyles.title}>Event notifications</Text>
      <Text style={sectionStyles.meta}>
        A notification before each event, at the times set on the event or its calendar.
      </Text>
      <View style={styles.switchRow}>
        <Text style={styles.label}>Notify me before events</Text>
        <Switch
          onValueChange={(enabled) => save({ enabled })}
          testID="event-notifications-enabled"
          value={settings.enabled}
        />
      </View>
      <View style={[styles.switchRow, !settings.enabled && sectionStyles.busy]}>
        <Text style={styles.label}>Also for Apple Calendar events</Text>
        <Switch
          disabled={!settings.enabled}
          onValueChange={(includeAppleCalendar) => save({ includeAppleCalendar })}
          testID="event-notifications-apple"
          value={settings.includeAppleCalendar}
        />
      </View>
      <Text style={sectionStyles.meta}>
        Calendar already notifies you about these; on means you get both.
      </Text>
      {notice ? (
        <Text style={sectionStyles.action} testID="event-notifications-denied">
          {notice}
        </Text>
      ) : null}
      <Text style={sectionStyles.meta} testID="event-notifications-device-only">
        {DEVICE_ONLY_SETTING_COPY}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    color: palette.text,
    flexShrink: 1,
    fontSize: 14,
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 10,
  },
});
