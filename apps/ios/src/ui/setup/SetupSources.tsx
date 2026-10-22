import { StyleSheet, View } from 'react-native';
import { CheckRow, Rows } from '../GroupedList.tsx';
import { type ThemeColors, useStyles } from '../theme.ts';
import { type SetupSources as Sources, useSetup } from './SetupContext.tsx';
import { SetupButton, SetupNote, SetupScreen } from './SetupScreen.tsx';

const ROWS: ReadonlyArray<{
  readonly key: keyof Sources;
  readonly subtitle: string;
  readonly title: string;
}> = [
  {
    key: 'googleCalendar',
    subtitle: 'Events from every Google account, in one calendar',
    title: 'Google Calendar',
  },
  {
    key: 'googleTasks',
    subtitle: 'Same sign-in as Google Calendar, one more permission',
    title: 'Google Tasks',
  },
  {
    key: 'appleCalendar',
    subtitle: 'The Calendar app’s calendars: iCloud, Exchange, subscriptions',
    title: 'Apple Calendar',
  },
  {
    key: 'reminders',
    subtitle: 'Your lists as tasks, both ways',
    title: 'Apple Reminders',
  },
];

/**
 * "What do you use?": four check rows, one short screen per tick after
 * it. Nothing ticked goes straight to the calendar; the Getting started
 * card's first row brings a person back here.
 */
export function SetupSources() {
  const styles = useStyles(makeStyles);
  const { finish, next, setSources, sources, stepPosition } = useSetup();
  const toggle = (key: keyof Sources) => setSources({ ...sources, [key]: !sources[key] });
  return (
    <SetupScreen
      actions={
        <SetupButton label="Continue" onPress={() => next('sources')} testID="setup-continue" />
      }
      lead="Tick what Solunivo should show. One short screen for each, then the calendar."
      onSkip={() => finish('skipped')}
      step={stepPosition('sources')}
      testID="setup-sources"
      title="What do you use?"
    >
      <View style={styles.card}>
        <Rows first>
          {ROWS.map((row) => (
            <CheckRow
              checked={sources[row.key]}
              key={row.key}
              kind="checkbox"
              onPress={() => toggle(row.key)}
              subtitle={row.subtitle}
              testID={`setup-source-${row.key}${sources[row.key] ? '-on' : ''}`}
              title={row.title}
            />
          ))}
        </Rows>
      </View>
      <SetupNote>
        Nothing ticked? Jump straight in — Getting started brings you back here whenever you like.
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
  });
