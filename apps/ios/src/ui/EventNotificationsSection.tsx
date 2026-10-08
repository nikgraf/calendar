import {
  useBackendMutations,
  useEventNotificationSettings,
  useSettingsEditor,
} from '@calendar/app-state';
import { DEVICE_ONLY_SETTING_COPY, type EventNotificationSettings } from '@calendar/core';
import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { NotificationsDenied, useNotificationPermission } from './NotificationsDenied.tsx';
import { useSectionStyles } from './settingsShared.ts';
import { type ThemeColors, useStyles } from './theme.ts';

/**
 * Whether event reminders notify on this iPhone, and whether Apple
 * Calendar events count too (the Calendar app already notifies for
 * those, so that one is off unless asked). Device-local like the
 * birthday reminders; every enabled save asks for permission.
 */
export function EventNotificationsSection() {
  const sectionStyles = useSectionStyles();
  const styles = useStyles(makeStyles);
  const { setEventNotificationSettings } = useBackendMutations();
  const [settings, persist] = useSettingsEditor(
    useEventNotificationSettings(),
    setEventNotificationSettings,
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
  const save = (next: Partial<EventNotificationSettings>) =>
    void persist(next).then(
      ({ notificationsGranted }) => {
        setFailure(null);
        setRefused(!notificationsGranted);
        recheck();
      },
      (error: unknown) => setFailure(String(error)),
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
      {denied ? <NotificationsDenied testID="event-notifications-denied" /> : null}
      {failure ? (
        <Text style={sectionStyles.action} testID="event-notifications-failed">
          {failure}
        </Text>
      ) : null}
      <Text style={sectionStyles.meta} testID="event-notifications-device-only">
        {DEVICE_ONLY_SETTING_COPY}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    label: {
      color: colors.text,
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
