import { useAccounts, useMirrors, usePendingOps, useSyncStatus } from '@calendar/app-state';
import {
  type Account,
  EXPERIMENTAL_COPY,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
} from '@calendar/core';
import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { type ThemeColors, useTheme } from '../theme.ts';
import {
  ActionRow,
  Avatar,
  Footer,
  IconTile,
  LeadingSymbol,
  NavRow,
  Section,
  SettingsPage,
} from './GroupedList.tsx';
import { useSettingsConnections } from './SettingsContext.tsx';

/** The avatar tints, one per Google account in turn. */
const AVATAR_TINTS = ['mint', 'blue', 'lilac', 'blush'] as const;

/** An account's initial for its avatar. */
const initialOf = (account: Account): string =>
  (account.displayName ?? account.email).trim().charAt(0).toUpperCase() || '?';

/** The line under a Google account: what it syncs, or why it does not. */
export const accountSubtitle = (account: Account): string => {
  if (account.status === 'reauth_required') {
    // No name yet: an account an import listed, never signed in on this phone.
    return account.displayName ? 'Sign in again to keep syncing' : 'Sign in to connect';
  }
  return account.tasksEnabled ? 'Google · Calendar and Tasks' : 'Google · Calendar';
};

/** "Calendar, Reminders and Contacts" — what this iPhone has connected. */
const joinNames = (names: ReadonlyArray<string>): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export const avatarColors = (
  colors: ThemeColors,
  index: number,
): { background: string; foreground: string } => {
  const tint = AVATAR_TINTS[index % AVATAR_TINTS.length]!;
  return { background: colors[`event-${tint}`], foreground: colors[`on-event-${tint}`] };
};

/**
 * The Settings root: unsynced changes when there are any, the accounts,
 * then one row per pane — the experimental ones last, under their own
 * header (each page says what that means at its top). Its reads
 * (accounts, sync status, mirrors) stay mounted under every pushed page,
 * which keeps their data from being dropped and fetched again on each
 * push.
 */
export function SettingsRoot() {
  const router = useRouter();
  const { colors } = useTheme();
  const accounts = useAccounts();
  const pendingOps = usePendingOps();
  const mirrors = useMirrors();
  useSyncStatus();
  const { addAccount, busy, connecting, contacts, error } = useSettingsConnections();
  const google = accounts.filter((account) => account.provider === 'google');
  const connected = [
    accounts.some(isAppleCalendarAccount) ? 'Calendar' : null,
    accounts.some(isAppleRemindersAccount) ? 'Reminders' : null,
    contacts === 'authorized' || contacts === 'limited' ? 'Contacts' : null,
  ].filter((name) => name !== null);
  const mirrorsOn = mirrors.filter((view) => view.enabled).length;

  return (
    <>
      <SettingsPage testID="settings-root">
        {error ? (
          <Footer testID="settings-error" tone="danger">
            {error}
          </Footer>
        ) : null}
        {pendingOps.length > 0 ? (
          <Section>
            <NavRow
              badge={pendingOps.length}
              href="/settings/unsynced"
              leading={
                <IconTile
                  color={colors.warning}
                  foreground={colors['on-warning']}
                  name="arrow.triangle.2.circlepath"
                />
              }
              testID="settings-row-unsynced"
              title="Unsynced Changes"
            />
          </Section>
        ) : null}

        <Section
          footer="Open an account to show or hide its calendars and task lists, or change their colors."
          header="Accounts"
        >
          {google.map((account, index) => {
            const tint = avatarColors(colors, index);
            return (
              <NavRow
                href={{ params: { id: account.id }, pathname: '/settings/account' }}
                key={account.id}
                leading={
                  <Avatar
                    background={tint.background}
                    foreground={tint.foreground}
                    label={initialOf(account)}
                  />
                }
                subtitle={accountSubtitle(account)}
                subtitleTone={account.status === 'reauth_required' ? 'warning' : 'secondary'}
                testID={`settings-row-account-${account.id}`}
                title={account.email}
              />
            );
          })}
          <NavRow
            href="/settings/device"
            leading={<IconTile color={colors['border-strong']} name="iphone" />}
            subtitle={connected.length > 0 ? joinNames(connected) : 'Calendar, Reminders, Contacts'}
            testID="settings-row-device"
            title="On This iPhone"
          />
          <ActionRow
            disabled={busy}
            leading={<LeadingSymbol color={colors.primary} name="plus" />}
            onPress={() => void addAccount()}
            testID="add-google-account"
            title={connecting === 'google' ? 'Waiting for Google…' : 'Add Google Account'}
          />
        </Section>

        <Section>
          <NavRow
            href="/settings/general"
            leading={<IconTile color={colors['border-strong']} name="gearshape.fill" />}
            testID="settings-row-general"
            title="General"
          />
          <NavRow
            href="/settings/notifications"
            leading={<IconTile color={colors['event-blush-edge']} name="bell.fill" />}
            testID="settings-row-notifications"
            title="Notifications"
          />
        </Section>

        <Section>
          <NavRow
            href="/settings/advanced"
            leading={<IconTile color={colors['text-secondary']} name="slider.horizontal.3" />}
            testID="settings-row-advanced"
            title="Advanced"
          />
        </Section>

        <Section
          footer={
            <Footer testID="settings-version">
              {`Solunivo ${Constants.expoConfig?.version ?? ''}`.trim()}
            </Footer>
          }
          header={EXPERIMENTAL_COPY.label}
        >
          <NavRow
            href="/settings/mirrors"
            leading={<IconTile color={colors['event-mint-edge']} name="rectangle.on.rectangle" />}
            testID="settings-row-mirrors"
            title="Mirrors"
            value={mirrors.length > 0 ? `${String(mirrorsOn)} On` : undefined}
          />
        </Section>
      </SettingsPage>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          accessibilityLabel="Done"
          icon="checkmark"
          onPress={() => router.back()}
          tintColor={colors.primary}
          variant="done"
        />
      </Stack.Toolbar>
    </>
  );
}
