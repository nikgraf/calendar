import {
  useBackendMutations,
  useBirthdayReminderOverrides,
  useInLesson,
  useLessonTried,
} from '@calendar/app-state';
import {
  birthdayRemindersSummary,
  DEVICE_ONLY_SETTING_COPY,
  dismissesWhenDone,
  dismissesWhenOver,
} from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Linking } from 'react-native';
import { BirthdayReminderRows } from '../BirthdayReminderRows.tsx';
import { dateFromParts, toTimeString } from '../editSheetShared.ts';
import { useTheme } from '../theme.ts';
import {
  ActionRow,
  Footer,
  LeadingSpace,
  LeadingSymbol,
  Row,
  Section,
  SettingsPage,
  SwipeRow,
  SwitchRow,
} from '../GroupedList.tsx';
import { notificationsBlocked, useNotificationSettings } from './NotificationSettings.tsx';

/**
 * Notifications on this iPhone: before events (and, if asked, Apple
 * Calendar events too — the Calendar app already notifies for those), on
 * the day a task is due (Apple Reminders too, unless switched off), for
 * contact birthdays at each reminder's lead and time, and the people with
 * reminders of their own. All device-local; a save that switches one on asks iOS
 * for permission, and the page says up front when iOS has said no.
 */
export function NotificationsPage() {
  return (
    <SettingsPage testID="settings-page-notifications">
      <NotificationsSections />
    </SettingsPage>
  );
}

/**
 * The Notifications page's sections, also the Alerts lesson's body. In
 * a lesson, iOS not having been asked yet puts "Allow Notifications" on
 * top — a save with event notifications on, which asks — and any change
 * ticks the lesson (`useLessonTried`).
 */
export function NotificationsSections() {
  const { colors } = useTheme();
  const { setBirthdayReminderOverride } = useBackendMutations();
  const overrides = useBirthdayReminderOverrides() ?? [];
  const notifications = useNotificationSettings();
  const { permission } = notifications;
  const [overrideFailure, setOverrideFailure] = useState<string | null>(null);
  const tried = useLessonTried();
  // Every change is a try, in a lesson; outside one `tried` is nothing.
  const events = {
    ...notifications.events,
    save: (change: Parameters<typeof notifications.events.save>[0]) => {
      notifications.events.save(change);
      tried();
    },
  };
  const tasks = {
    ...notifications.tasks,
    save: (change: Parameters<typeof notifications.tasks.save>[0]) => {
      notifications.tasks.save(change);
      tried();
    },
  };
  const birthdays = {
    ...notifications.birthdays,
    save: (change: Parameters<typeof notifications.birthdays.save>[0]) => {
      notifications.birthdays.save(change);
      tried();
    },
  };
  const blocked =
    notificationsBlocked(events, permission) ||
    notificationsBlocked(tasks, permission) ||
    notificationsBlocked(birthdays, permission);
  const inLesson = useInLesson();

  return (
    <>
      {inLesson && permission === 'undetermined' && events.settings ? (
        <Section footer="iOS asks once whether Solunivo may notify you.">
          <ActionRow
            leading={<LeadingSymbol color={colors.primary} name="bell.badge" />}
            onPress={() => events.save({ enabled: true })}
            testID="notifications-allow"
            title="Allow Notifications"
          />
        </Section>
      ) : null}
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
              <Footer>
                Remove When Over takes an event’s notification out of Notification Center once the
                event has ended, the next time Solunivo runs.
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
          {/* Live while notifications are off: it still governs the ones
              already delivered, which the scheduler keeps clearing. */}
          <SwitchRow
            onValueChange={(dismissWhenOver) => events.save({ dismissWhenOver })}
            switchTestID="event-notifications-dismiss"
            title="Remove When Over"
            value={dismissesWhenOver(events.settings)}
          />
        </Section>
      ) : null}

      {tasks.settings ? (
        <Section
          footer={
            <>
              <Footer>
                A notification on the day a task is due, at the time above; a reminder with a time
                of its own notifies at that time. Reminders already notifies you about reminders
                with an alert; turn Apple Reminders off to leave those to it.
              </Footer>
              <Footer>
                Remove When Done takes a task’s notification out of Notification Center once it is
                checked off, or a minute after it is deleted, the next time Solunivo runs.
              </Footer>
              {tasks.failure ? (
                <Footer testID="task-notifications-failed" tone="danger">
                  {tasks.failure}
                </Footer>
              ) : null}
            </>
          }
          header="Tasks"
          testID="task-notifications"
        >
          <SwitchRow
            onValueChange={(enabled) => tasks.save({ enabled })}
            switchTestID="task-notifications-enabled"
            title="Task Notifications"
            value={tasks.settings.enabled}
          />
          <Row
            accessory={
              <DateTimePicker
                accessibilityLabel="Notify at, time"
                disabled={!tasks.settings.enabled}
                display="compact"
                mode="time"
                onValueChange={(_, picked) => {
                  tasks.save({ time: toTimeString(picked) });
                }}
                testID="task-notifications-time"
                value={dateFromParts('2026-01-01', tasks.settings.time)}
              />
            }
            disabled={!tasks.settings.enabled}
            title="Notify At"
          />
          <SwitchRow
            disabled={!tasks.settings.enabled}
            onValueChange={(includeAppleReminders) => tasks.save({ includeAppleReminders })}
            switchTestID="task-notifications-reminders"
            title="Apple Reminders"
            value={tasks.settings.includeAppleReminders}
          />
          {/* Live while notifications are off: they still govern the ones
              already delivered, which the scheduler keeps clearing. */}
          <SwitchRow
            onValueChange={(dismissTasksWhenDone) => tasks.save({ dismissTasksWhenDone })}
            switchTestID="task-notifications-dismiss-tasks"
            title="Remove Tasks When Done"
            value={dismissesWhenDone(tasks.settings, 'google')}
          />
          <SwitchRow
            onValueChange={(dismissRemindersWhenDone) => tasks.save({ dismissRemindersWhenDone })}
            switchTestID="task-notifications-dismiss-reminders"
            title="Remove Reminders When Done"
            value={dismissesWhenDone(tasks.settings, 'apple')}
          />
        </Section>
      ) : null}

      {birthdays.settings ? (
        <Section
          footer={
            <>
              <Footer>
                A notification for every birthday in your contacts, at each reminder’s time. Swipe
                left on a reminder to delete it.
              </Footer>
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
          {/* On this page, not one pushed over it: the Alerts lesson shows
              these sections in a stack of its own, and a push from there
              opened Settings' stack, whose editor never saw the lesson's
              changes (the row kept reading "On the day"). */}
          <BirthdayReminderRows
            onChange={(reminders) => birthdays.save({ reminders })}
            reminders={birthdays.settings.reminders}
            testIDPrefix="birthday-reminder"
          />
        </Section>
      ) : null}

      {overrides.length > 0 ? (
        <Section
          footer={
            <>
              <Footer>
                Change a person’s reminders from their birthday in the calendar. Swipe left on a
                name to go back to the reminders above.
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
                void setBirthdayReminderOverride({ ...override, reminders: null }).then(
                  () => setOverrideFailure(null),
                  (error: unknown) => setOverrideFailure(String(error)),
                )
              }
              actionLabel="Reset"
              actionTestID={`birthday-override-reset-${String(index)}`}
              key={`${override.displayName}:${String(override.month)}-${String(override.day)}`}
              // Below the name, where it can wrap: a list with times is
              // longer than a row's value column.
              subtitle={birthdayRemindersSummary(override.reminders)}
              testID={`birthday-override-row-${String(index)}`}
              title={override.displayName}
            />
          ))}
        </Section>
      ) : null}

      <Footer testID="notifications-device-only">{DEVICE_ONLY_SETTING_COPY}</Footer>
    </>
  );
}
