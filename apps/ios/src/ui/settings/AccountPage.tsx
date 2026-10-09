import {
  removeAccountQuestion,
  useAccounts,
  useCalendars,
  useGuardedMutations,
  usePendingOpsRead,
  useSyncStatus,
  useTaskLists,
} from '@calendar/app-state';
import { historyStatusLabel } from '@calendar/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActionSheetIOS, Alert } from 'react-native';
import { useTheme } from '../theme.ts';
import {
  ActionRow,
  Avatar,
  Footer,
  LeadingSpace,
  LeadingSymbol,
  PageHero,
  Row,
  Section,
  SettingsPage,
  VisibilityRow,
} from './GroupedList.tsx';
import { useSettingsConnections } from './SettingsContext.tsx';
import { avatarColors } from './SettingsRoot.tsx';

/**
 * One Google account: whether it is signed in, how far its history got,
 * its calendars and task lists (tap to show or hide, ⓘ for a calendar's
 * color), and removing it — confirmed, and refused while its unsynced
 * changes cannot be counted.
 */
export function AccountPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const taskLists = useTaskLists();
  const syncStatus = useSyncStatus();
  const guarded = useGuardedMutations();
  // Not `usePendingOps`: its empty fallback while loading would read as
  // "nothing unsynced".
  const pendingOps = usePendingOpsRead();
  const { addAccount, busy, error } = useSettingsConnections();
  const google = accounts.filter((account) => account.provider === 'google');
  const account = google.find((candidate) => candidate.id === id);

  if (!account) {
    return (
      <SettingsPage testID="settings-page-account">
        <Footer>This account is no longer on this iPhone.</Footer>
      </SettingsPage>
    );
  }

  const status = syncStatus.find((entry) => entry.accountId === account.id);
  // An account that cannot sync (re-auth pending) never finishes an
  // import, so "importing" would be a lie there; what it already holds
  // is still worth stating.
  const historyLine =
    status && !(status.importing && account.status !== 'ok') ? historyStatusLabel(status) : null;
  const tint = avatarColors(
    colors,
    google.findIndex((candidate) => candidate.id === account.id),
  );
  const ownCalendars = calendars.filter((calendar) => calendar.accountId === account.id);
  const ownLists = taskLists.filter((list) => list.accountId === account.id);

  const remove = () => {
    const removeNow = () => {
      void guarded.removeAccount({ accountId: account.id });
      router.back();
    };
    const question = removeAccountQuestion(account, pendingOps);
    if (!question) {
      removeNow();
      return;
    }
    // A shown sheet cannot update when the queue read lands, so it offers
    // Remove only with the count already in it.
    if (!question.canRemove) {
      Alert.alert(question.title, question.message, [{ style: 'cancel', text: 'OK' }]);
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      {
        cancelButtonIndex: 1,
        destructiveButtonIndex: 0,
        message: question.message,
        options: ['Remove Account', 'Cancel'],
        title: question.title,
      },
      (index) => {
        if (index === 0) {
          removeNow();
        }
      },
    );
  };

  return (
    <SettingsPage testID="settings-page-account">
      <PageHero
        icon={
          <Avatar
            background={tint.background}
            foreground={tint.foreground}
            label={(account.displayName ?? account.email).charAt(0).toUpperCase()}
            size={72}
            uri={account.avatarUrl}
          />
        }
        subtitle={account.displayName ? `${account.displayName} · Google` : 'Google Account'}
        title={account.email}
      />
      {error ? <Footer tone="danger">{error}</Footer> : null}

      {account.status === 'reauth_required' ? (
        <Section footer="Google ended this session. What you change meanwhile stays on this iPhone and syncs after you sign in.">
          <Row
            leading={<LeadingSymbol color={colors.warning} name="exclamationmark.triangle.fill" />}
            title={account.displayName ? 'Session Expired' : 'Not Signed In'}
          />
          <ActionRow
            disabled={busy}
            leading={<LeadingSpace />}
            onPress={() => void addAccount(account.email)}
            testID={`reconnect-account-${account.id}`}
            title={account.displayName ? 'Sign In Again' : 'Sign In'}
          />
        </Section>
      ) : null}

      {historyLine ? (
        <Section>
          <Row
            title="Calendar History"
            value={historyLine}
            valueTestID={`sync-history-${account.id}`}
          />
        </Section>
      ) : null}

      {ownCalendars.length > 0 ? (
        <Section header="Calendars">
          {ownCalendars.map((calendar) => (
            <VisibilityRow
              color={calendar.colorHex}
              infoLabel={`${calendar.summary}: color`}
              infoTestID={`calendar-color-${calendar.id}`}
              key={calendar.id}
              onInfo={() =>
                router.push({
                  params: { accountId: calendar.accountId, calendarId: calendar.id },
                  pathname: '/settings/calendar',
                })
              }
              onToggle={() =>
                void guarded.setCalendarVisible({
                  accountId: calendar.accountId,
                  calendarId: calendar.id,
                  isVisible: !calendar.isVisible,
                })
              }
              testID={`calendar-visible-${calendar.id}`}
              title={calendar.summary}
              visible={calendar.isVisible}
            />
          ))}
        </Section>
      ) : null}

      {account.tasksEnabled ? (
        ownLists.length > 0 ? (
          <Section
            footer="Tap a calendar or list to show or hide it in Solunivo. Tap ⓘ to change a calendar’s color."
            header="Task Lists"
          >
            {ownLists.map((list) => (
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
        ) : null
      ) : (
        // Tokens from before the tasks scope: signing in again re-consents
        // and upgrades the account in place.
        <Section
          footer="This account signed in before Solunivo used Google Tasks. Sign in once more to allow it."
          header="Task Lists"
        >
          <ActionRow
            disabled={busy}
            onPress={() => void addAccount(account.email)}
            testID={`allow-tasks-${account.id}`}
            title="Allow Google Tasks…"
          />
        </Section>
      )}

      <Section>
        <ActionRow
          onPress={remove}
          testID={`remove-account-${account.id}`}
          title="Remove Account…"
          tone="destructive"
        />
      </Section>
    </SettingsPage>
  );
}
