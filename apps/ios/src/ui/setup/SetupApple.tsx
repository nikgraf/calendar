import { appleCalendarStatusCopy, remindersStatusCopy } from '@calendar/app-state';
import { StyleSheet, Text, View } from 'react-native';
import { Footer } from '../GroupedList.tsx';
import { IOS_SETTINGS_PATH, useSettingsConnections } from '../settings/SettingsContext.tsx';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { useSetup } from './SetupContext.tsx';
import { SetupButton, SetupNote, SetupPoint, SetupScreen } from './SetupScreen.tsx';

/** Statuses iOS will not ask about again: the step says where to allow, and moves on. */
const BLOCKED = ['denied', 'restricted', 'unavailable', 'writeOnly'];

const PREVIEW: Record<
  'calendar' | 'reminders',
  ReadonlyArray<{ readonly detail: string; readonly tint: string; readonly title: string }>
> = {
  calendar: [
    { detail: 'iCloud', tint: 'event-blue-edge', title: 'Home' },
    { detail: 'Exchange', tint: 'event-mint-edge', title: 'Work' },
    { detail: 'Subscribed', tint: 'event-blush-edge', title: 'Holidays' },
  ],
  reminders: [
    { detail: 'Tomorrow', tint: 'event-blue-edge', title: 'Olive oil' },
    { detail: '', tint: 'event-blue-edge', title: 'Call the dentist' },
    { detail: 'Fri', tint: 'event-blue-edge', title: 'Return the library books' },
  ],
};

/**
 * The Apple Calendar and Reminders steps, one shape: a preview of what
 * arrives, three points, the note about the one-time prompt, and the
 * ask. A grant moves on by itself; "Not now" moves on without one; a
 * refusal says where to allow it later and leaves Continue.
 */
export function SetupApple({ provider }: { provider: 'calendar' | 'reminders' }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { finish, next, stepPosition } = useSetup();
  const { busy, calendar, connectDevice, connecting, error, reminders } = useSettingsConnections();
  const step = provider === 'calendar' ? 'apple-calendar' : 'reminders';
  const status = provider === 'calendar' ? calendar : reminders;
  const blocked = BLOCKED.includes(status);
  const name = provider === 'calendar' ? 'Calendar' : 'Reminders';
  const allow = async () => {
    const granted = await connectDevice(provider);
    if (granted) {
      next(step);
    }
  };
  return (
    <SetupScreen
      actions={
        blocked ? (
          <SetupButton label="Continue" onPress={() => next(step)} testID="setup-continue" />
        ) : (
          <>
            <SetupButton
              disabled={busy}
              label={connecting === provider ? 'Asking iOS…' : `Allow access to ${name}`}
              onPress={() => void allow()}
              testID={`setup-allow-${provider}`}
            />
            <SetupButton
              disabled={busy}
              label="Not now"
              onPress={() => next(step)}
              testID="setup-not-now"
              variant="quiet"
            />
          </>
        )
      }
      lead={
        provider === 'calendar'
          ? 'The calendars in this iPhone’s Calendar app, beside your Google ones.'
          : 'Your Reminders lists as task lists, edited from either app.'
      }
      onSkip={() => finish('skipped')}
      step={stepPosition(step)}
      testID={`setup-${step}`}
      title={provider === 'calendar' ? 'Apple Calendar' : 'Reminders'}
    >
      <View style={styles.preview}>
        {provider === 'reminders' ? (
          <Text style={styles.previewHeader}>Groceries · Reminders</Text>
        ) : null}
        {PREVIEW[provider].map((row) => (
          <View key={row.title} style={styles.previewRow}>
            <View
              style={[
                styles.previewDot,
                { backgroundColor: colors[row.tint as keyof ThemeColors] },
              ]}
            />
            <Text style={styles.previewTitle}>{row.title}</Text>
            <Text style={styles.previewDetail}>{row.detail}</Text>
          </View>
        ))}
      </View>
      <View style={styles.points}>
        {provider === 'calendar' ? (
          <>
            <SetupPoint>iCloud, Exchange and subscribed calendars appear as they are</SetupPoint>
            <SetupPoint>Edits here write back to the Calendar app</SetupPoint>
            <SetupPoint>Read on this iPhone; nothing is copied or uploaded</SetupPoint>
          </>
        ) : (
          <>
            <SetupPoint>Each list becomes a task list</SetupPoint>
            <SetupPoint>Due dates land on the calendar</SetupPoint>
            <SetupPoint>Done here is done in Reminders, and the other way round</SetupPoint>
          </>
        )}
      </View>
      {error ? <Footer tone="danger">{error}</Footer> : null}
      <SetupNote testID="setup-apple-note">
        {blocked
          ? `${name}: ${
              provider === 'calendar'
                ? appleCalendarStatusCopy(status, IOS_SETTINGS_PATH)
                : remindersStatusCopy(status, IOS_SETTINGS_PATH)
            }`
          : 'iOS asks once. Change your mind any time in Settings › On This iPhone.'}
      </SetupNote>
    </SetupScreen>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    points: {
      gap: 8,
    },
    preview: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      gap: 10,
      padding: 16,
    },
    previewDetail: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    previewDot: {
      borderRadius: 5,
      height: 10,
      width: 10,
    },
    previewHeader: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '600',
    },
    previewRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
    },
    previewTitle: {
      color: colors.text,
      flex: 1,
      fontSize: 15,
    },
  });
