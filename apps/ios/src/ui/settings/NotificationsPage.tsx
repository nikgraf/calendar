import { useBackendMutations, useBirthdayReminderOverrides } from '@calendar/app-state';
import { DEVICE_ONLY_SETTING_COPY, leadDaysSummary } from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Linking } from 'react-native';
import { dateFromParts, toTimeString } from '../editSheetShared.ts';
import { useTheme } from '../theme.ts';
import {
  ActionRow,
  Footer,
  LeadingSpace,
  LeadingSymbol,
  NavRow,
  Row,
  Section,
  SettingsPage,
  SwipeRow,
  SwitchRow,
} from './GroupedList.tsx';
import { notificationsBlocked, useNotificationSettings } from './NotificationSettings.tsx';

/**
 * Notifications on this iPhone: before events (and, if asked, Apple
 * Calendar events too — the Calendar app already notifies for those), for
 * contact birthdays at the chosen lead times, and the people with times
 * of their own. All device-local; a save that switches one on asks iOS
 * for permission, and the page says up front when iOS has said no.
 */
export function NotificationsPage() {
  const { colors } = useTheme();
  const { setBirthdayReminderOverride } = useBackendMutations();
  const overrides = useBirthdayReminderOverrides() ?? [];
  const { birthdays, events, permission } = useNotificationSettings();
  const [overrideFailure, setOverrideFailure] = useState<string | null>(null);
  const blocked =
    notificationsBlocked(events, permission) || notificationsBlocked(birthdays, permission);

  return (
    <SettingsPage testID="settings-page-notifications">
      {blocked ? (
        <Section
          footer="Allow Solunivo under Settings › Notifications, or none of the notifications below can reach you."
          testID="notifications-denied"
        >
          <Row
            leading={<LeadingSymbol color={colors.warning} name="exclamationmark.triangle.fill" />}
            title="Notifications Are Off"
          />
          <ActionRow
            leading={<LeadingSpace />}
            onPress={() => void Linking.openSettings()}
            testID="notifications-open-settings"
            title="Open Settings"
          />
        </Section>
      ) : null}

      {events.settings ? (
        <Section
          footer={
            <>
              <Footer>
                A notification before each event, at the times set on the event or its calendar.
                Calendar already notifies you about Apple Calendar events; turn this on to get both.
              </Footer>
              {events.failure ? (
                <Footer testID="event-notifications-failed" tone="danger">
                  {events.failure}
                </Footer>
              ) : null}
            </>
          }
          header="Events"
          testID="event-notifications"
        >
          <SwitchRow
            onValueChange={(enabled) => events.save({ enabled })}
            switchTestID="event-notifications-enabled"
            title="Event Notifications"
            value={events.settings.enabled}
          />
          <SwitchRow
            disabled={!events.settings.enabled}
            onValueChange={(includeAppleCalendar) => events.save({ includeAppleCalendar })}
            switchTestID="event-notifications-apple"
            title="Apple Calendar Events"
            value={events.settings.includeAppleCalendar}
          />
        </Section>
      ) : null}

      {birthdays.settings ? (
        <Section
          footer={
            <>
              <Footer>A notification for every birthday in your contacts.</Footer>
              {birthdays.failure ? (
                <Footer testID="birthday-notifications-failed" tone="danger">
                  {birthdays.failure}
                </Footer>
              ) : null}
            </>
          }
          header="Birthdays"
          testID="birthday-reminders"
        >
          <SwitchRow
            onValueChange={(enabled) => birthdays.save({ enabled })}
            switchTestID="birthday-reminders-enabled"
            title="Birthday Reminders"
            value={birthdays.settings.enabled}
          />
          <NavRow
            href="/settings/birthday-leads"
            testID="birthday-lead-times"
            title="Remind Me"
            value={leadDaysSummary(birthdays.settings.leadDays)}
          />
          <Row
            accessory={
              <DateTimePicker
                accessibilityLabel="Reminder time"
                display="compact"
                mode="time"
                onChange={(_, picked) => {
                  if (picked) {
                    birthdays.save({ time: toTimeString(picked) });
                  }
                }}
                testID="birthday-time"
                value={dateFromParts('2026-01-01', birthdays.settings.time)}
              />
            }
            title="Time"
          />
        </Section>
      ) : null}

      {overrides.length > 0 ? (
        <Section
          footer={
            <>
              <Footer>
                Change a person’s reminders from their birthday in the calendar. Swipe left on a
                name to go back to the times above.
              </Footer>
              {overrideFailure ? (
                <Footer testID="birthday-override-failed" tone="danger">
                  {overrideFailure}
                </Footer>
              ) : null}
            </>
          }
          header="Custom per Person"
          testID="birthday-overrides"
        >
          {overrides.map((override, index) => (
            <SwipeRow
              action={() =>
                void setBirthdayReminderOverride({ ...override, leadDays: null }).then(
                  () => setOverrideFailure(null),
                  (error: unknown) => setOverrideFailure(String(error)),
                )
              }
              actionLabel="Reset"
              actionTestID={`birthday-override-reset-${String(index)}`}
              key={`${override.displayName}:${String(override.month)}-${String(override.day)}`}
              testID={`birthday-override-row-${String(index)}`}
              title={override.displayName}
              value={leadDaysSummary(override.leadDays)}
            />
          ))}
        </Section>
      ) : null}

      <Footer testID="notifications-device-only">{DEVICE_ONLY_SETTING_COPY}</Footer>
    </SettingsPage>
  );
}
