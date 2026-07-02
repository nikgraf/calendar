import { appName, Temporal } from '@calendar/core';
import { Effect, Schedule } from 'effect';
import { useEffect, useState } from 'react';
import { RRuleTemporal } from 'rrule-temporal';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

// M0 Hermes spikes: Temporal + rrule-temporal expansion and a minimal effect v4
// program must run on-device before the real sync/recurrence code is built.
const spike = (label: string, run: () => string): string => {
  try {
    return `✅ ${label}: ${run()}`;
  } catch (error) {
    return `❌ ${label}: ${String(error)}`;
  }
};

const spikes = [
  spike('Intl.resolvedOptions', () => JSON.stringify(new Intl.DateTimeFormat().resolvedOptions())),
  spike('Now.plainDateISO', () => Temporal.Now.plainDateISO().toString()),
  spike('Now.zonedDateTimeISO', () => Temporal.Now.zonedDateTimeISO().toString()),
  spike('PlainDate.toLocaleString', () =>
    Temporal.Now.plainDateISO().toLocaleString('en-US', {
      day: 'numeric',
      month: 'long',
      weekday: 'long',
      year: 'numeric',
    }),
  ),
  spike('ZonedDateTime.with', () =>
    Temporal.Now.zonedDateTimeISO().with({ minute: 0, second: 0 }).toString(),
  ),
  spike('rrule-temporal weekly', () => {
    const rule = new RRuleTemporal({
      dtstart: Temporal.ZonedDateTime.from('2026-03-03T09:00:00[America/Los_Angeles]'),
      rruleString: 'FREQ=WEEKLY;BYDAY=TU;COUNT=3',
    });
    return rule
      .all()
      .map((occurrence) => occurrence.toString())
      .join(' | ');
  }),
];

const effectSpike = Effect.retry(
  Effect.sync(() => 'effect v4 runs on Hermes'),
  Schedule.recurs(1),
);

export function App() {
  const [effectResult, setEffectResult] = useState('running…');

  useEffect(() => {
    Effect.runPromise(effectSpike).then(setEffectResult, (error) =>
      setEffectResult(`failed: ${String(error)}`),
    );
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{appName}</Text>
        {spikes.map((result) => (
          <Text key={result.slice(0, 40)} style={styles.spike}>
            {result}
          </Text>
        ))}
        <Text style={styles.spike}>{effectResult}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#fafafa',
    flex: 1,
  },
  content: {
    gap: 12,
    padding: 24,
    paddingTop: 80,
  },
  spike: {
    color: '#525252',
    fontSize: 13,
  },
  title: {
    fontSize: 28,
    fontWeight: '600',
  },
});
