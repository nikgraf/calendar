import { useAccounts } from '@calendar/app-state';
import { StyleSheet, Text, View } from 'react-native';
import { ActionRow, Avatar, Footer, LeadingSymbol, Row, Rows } from '../GroupedList.tsx';
import { accountSubtitle, avatarColors, initialOf } from '../settings/SettingsRoot.tsx';
import { useSettingsConnections } from '../settings/SettingsContext.tsx';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { useSetup } from './SetupContext.tsx';
import { SetupButton, SetupNote, SetupPoint, SetupScreen } from './SetupScreen.tsx';

/**
 * The Google step: every account signed in so far, and "Add another
 * account" for the next — several before Continue. The sign-in asks for
 * Calendar, and for Tasks only when it was ticked (`tasks`); the sheet
 * comes straight back here.
 */
export function SetupGoogle() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { finish, next, sources, stepPosition } = useSetup();
  const { addAccount, busy, connecting, error } = useSettingsConnections();
  const google = useAccounts().filter((account) => account.provider === 'google');
  const tasks = sources.googleTasks;
  return (
    <SetupScreen
      actions={
        <SetupButton label="Continue" onPress={() => next('google')} testID="setup-continue" />
      }
      lead="Sign in to each Google account you use. They all show in one calendar."
      onSkip={() => finish('skipped')}
      step={stepPosition('google')}
      testID="setup-google"
      title="Google"
    >
      <View style={styles.points}>
        <SetupPoint>Every account in one calendar</SetupPoint>
        {tasks ? <SetupPoint>Tasks beside your events, with due dates</SetupPoint> : null}
        <SetupPoint>Invite people by name</SetupPoint>
      </View>
      {google.length > 0 ? <Text style={styles.header}>Connected</Text> : null}
      <View style={styles.card}>
        <Rows first>
          {google.map((account, index) => {
            const tint = avatarColors(colors, index);
            return (
              <Row
                key={account.id}
                leading={
                  <Avatar
                    background={tint.background}
                    foreground={tint.foreground}
                    label={initialOf(account)}
                    uri={account.avatarUrl}
                  />
                }
                subtitle={accountSubtitle(account)}
                testID={`setup-account-${account.id}`}
                title={account.email}
              />
            );
          })}
          <ActionRow
            disabled={busy}
            leading={<LeadingSymbol color={colors.primary} name="plus" />}
            onPress={() => void addAccount({ tasks })}
            testID="setup-add-google"
            title={
              connecting === 'google'
                ? 'Waiting for Google…'
                : google.length > 0
                  ? 'Add another account'
                  : 'Add a Google account'
            }
          />
        </Rows>
      </View>
      {error ? <Footer tone="danger">{error}</Footer> : null}
      <SetupNote>
        {tasks
          ? 'Google asks for Calendar — and Tasks, because you ticked it. The sign-in sheet comes straight back here. Nothing leaves this iPhone except to Google.'
          : 'Google asks for Calendar. The sign-in sheet comes straight back here. Nothing leaves this iPhone except to Google.'}
      </SetupNote>
    </SetupScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: 20,
      overflow: 'hidden',
    },
    header: {
      color: colors['text-secondary'],
      fontSize: 13,
      marginBottom: -8,
      textTransform: 'uppercase',
    },
    points: {
      gap: 8,
    },
  });
