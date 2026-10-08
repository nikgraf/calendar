import {
  appleCalendarStatusCopy,
  contactsStatusCopy,
  remindersStatusCopy,
  useAccounts,
  useCalendars,
  useGuardedMutations,
  useTaskLists,
} from '@calendar/app-state';
import { isAppleCalendarAccount, isAppleRemindersAccount } from '@calendar/core';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme.ts';
import {
  ActionRow,
  CapsuleButton,
  Footer,
  IconTile,
  LeadingSpace,
  Row,
  Section,
  SettingsPage,
  VisibilityRow,
} from './GroupedList.tsx';
import { IOS_SETTINGS_PATH, useSettingsConnections } from './SettingsContext.tsx';

/** Statuses that keep a connection from working until the user changes it in iOS Settings. */
const BLOCKED = ['denied', 'restricted', 'unavailable', 'writeOnly'];

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/**
 * What Solunivo reads on this iPhone: Calendar, Reminders and Contacts
 * access (connect, or why not and where to fix it), the Apple calendars
 * and reminder lists to show or hide, and disconnecting either account.
 * A connect stays offered while iOS has not been asked — a privacy reset
 * keeps the account in our database, and its presence must not hide the
 * action that asks again.
 */
export function DevicePage() {
  const { colors } = useTheme();
  const router = useRouter();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const taskLists = useTaskLists();
  const guarded = useGuardedMutations();
  const {
    busy,
    calendar,
    connectDevice,
    connecting,
    contacts,
    contactsConnectionFailed,
    error,
    openSettings,
    reminders,
  } = useSettingsConnections();
  const calendarAccount = accounts.find(isAppleCalendarAccount);
  const remindersAccount = accounts.find(isAppleRemindersAccount);
  const appleCalendars = calendarAccount
    ? calendars.filter((entry) => entry.accountId === calendarAccount.id)
    : [];
  const reminderLists = remindersAccount
    ? taskLists.filter((list) => list.accountId === remindersAccount.id)
    : [];
  const contactsConnected =
    (contacts === 'authorized' || contacts === 'limited') && !contactsConnectionFailed;
  const offerCalendar =
    !calendarAccount || calendar === 'notDetermined' || calendar === 'writeOnly';
  const offerReminders =
    !remindersAccount || reminders === 'notDetermined' || reminders === 'writeOnly';
  const needsSettings =
    contacts === 'denied' ||
    reminders === 'denied' ||
    reminders === 'writeOnly' ||
    calendar === 'denied' ||
    calendar === 'writeOnly';

  const notes = [
    BLOCKED.includes(calendar)
      ? `Calendar: ${appleCalendarStatusCopy(calendar, IOS_SETTINGS_PATH)}`
      : calendarAccount?.status === 'reauth_required'
        ? 'Calendar access is off — allow it in Settings › Privacy & Security › Calendars; it reconnects on its own.'
        : null,
    BLOCKED.includes(reminders)
      ? `Reminders: ${remindersStatusCopy(reminders, IOS_SETTINGS_PATH)}`
      : remindersAccount?.status === 'reauth_required'
        ? 'Reminders access is off — allow it in Settings › Privacy & Security › Reminders; it reconnects on its own.'
        : null,
    ['denied', 'restricted', 'unavailable'].includes(contacts)
      ? `Contacts: ${contactsStatusCopy(contacts, IOS_SETTINGS_PATH)}`
      : null,
  ].filter((note) => note !== null);

  return (
    <SettingsPage testID="settings-page-device">
      {error ? <Footer tone="danger">{error}</Footer> : null}
      <Section
        footer={
          <>
            {notes.map((note) => (
              <Footer key={note}>{note}</Footer>
            ))}
            <Footer>Contacts feed invitee suggestions and birthday reminders.</Footer>
          </>
        }
        header="Access"
      >
        <Row
          accessory={
            offerCalendar ? (
              <CapsuleButton
                disabled={busy}
                label={
                  connecting === 'calendar'
                    ? 'Connecting…'
                    : calendarAccount
                      ? 'Reconnect'
                      : 'Connect'
                }
                onPress={() => void connectDevice('calendar')}
                testID="connect-apple-calendar"
              />
            ) : undefined
          }
          leading={<IconTile color={colors['event-blush-edge']} name="calendar" />}
          subtitle={
            calendarAccount
              ? calendarAccount.status === 'reauth_required'
                ? 'Access off'
                : plural(appleCalendars.length, 'calendar')
              : 'Not connected'
          }
          subtitleTestID={calendarAccount ? 'apple-calendar-account' : undefined}
          title="Calendar"
          value={offerCalendar ? undefined : BLOCKED.includes(calendar) ? 'Off' : 'Connected'}
        />
        <Row
          accessory={
            offerReminders ? (
              <CapsuleButton
                disabled={busy}
                label={
                  connecting === 'reminders'
                    ? 'Connecting…'
                    : remindersAccount
                      ? 'Reconnect'
                      : 'Connect'
                }
                onPress={() => void connectDevice('reminders')}
                testID="connect-reminders"
              />
            ) : undefined
          }
          leading={<IconTile color={colors['event-blue-edge']} name="checklist" />}
          subtitle={
            remindersAccount
              ? remindersAccount.status === 'reauth_required'
                ? 'Access off'
                : plural(reminderLists.length, 'list')
              : 'Not connected'
          }
          subtitleTestID={remindersAccount ? 'apple-reminders-account' : undefined}
          title="Reminders"
          value={offerReminders ? undefined : BLOCKED.includes(reminders) ? 'Off' : 'Connected'}
        />
        <Row
          accessory={
            contactsConnected ? undefined : (
              <CapsuleButton
                disabled={busy}
                label={connecting === 'contacts' ? 'Connecting…' : 'Allow Access'}
                onPress={() => void connectDevice('contacts')}
                testID="connect-contacts"
              />
            )
          }
          leading={<IconTile color={colors['border-strong']} name="person.fill" />}
          title="Contacts"
          value={
            contactsConnected
              ? contacts === 'limited'
                ? 'Selected Contacts'
                : 'Allowed'
              : undefined
          }
          valueTestID={contactsConnected ? 'contacts-connected' : undefined}
        />
        {needsSettings ? (
          <ActionRow
            disabled={busy}
            leading={<LeadingSpace />}
            onPress={() => void openSettings()}
            testID="open-device-settings"
            title="Open Settings"
          />
        ) : null}
      </Section>

      {appleCalendars.length > 0 ? (
        <Section header="Calendars">
          {appleCalendars.map((entry) => (
            <VisibilityRow
              color={entry.colorHex}
              infoLabel={`${entry.summary}: color`}
              infoTestID={`calendar-color-${entry.id}`}
              key={entry.id}
              onInfo={() =>
                router.push({
                  params: { accountId: entry.accountId, calendarId: entry.id },
                  pathname: '/settings/calendar',
                })
              }
              onToggle={() =>
                void guarded.setCalendarVisible({
                  accountId: entry.accountId,
                  calendarId: entry.id,
                  isVisible: !entry.isVisible,
                })
              }
              subtitle={entry.sourceTitle}
              testID={`calendar-visible-${entry.id}`}
              title={entry.summary}
              visible={entry.isVisible}
            />
          ))}
        </Section>
      ) : null}

      {reminderLists.length > 0 ? (
        <Section
          footer="Tap a calendar or list to show or hide it in Solunivo."
          header="Reminder Lists"
        >
          {reminderLists.map((list) => (
            <VisibilityRow
              color={list.colorHex ?? colors.primary}
              key={list.id}
              onToggle={() =>
                void guarded.setTaskListVisible({
                  accountId: list.accountId,
                  isVisible: !list.isVisible,
                  taskListId: list.id,
                })
              }
              testID={`task-list-${list.id}`}
              title={list.title}
              visible={list.isVisible}
            />
          ))}
        </Section>
      ) : null}

      {calendarAccount || remindersAccount ? (
        <Section footer="Disconnecting removes nothing from this iPhone: your calendars and reminders stay in the Calendar and Reminders apps.">
          {calendarAccount ? (
            <ActionRow
              onPress={() => void guarded.removeAccount({ accountId: calendarAccount.id })}
              testID={`remove-account-${calendarAccount.id}`}
              title="Disconnect Apple Calendar"
              tone="destructive"
            />
          ) : null}
          {remindersAccount ? (
            <ActionRow
              onPress={() => void guarded.removeAccount({ accountId: remindersAccount.id })}
              testID={`remove-account-${remindersAccount.id}`}
              title="Disconnect Apple Reminders"
              tone="destructive"
            />
          ) : null}
        </Section>
      ) : null}
    </SettingsPage>
  );
}
