import {
  BackendProvider,
  makeBackendAtoms,
  useBackendInvalidations,
  useCalendars,
  useEventsInRange,
} from '@calendar/app-state';
import { dayRange, monthGridRange, Temporal, weekStart, type EventRecord } from '@calendar/core';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { backendClient, startSync, subscribeInvalidations } from './src/backend.ts';
import { DayTimeline } from './src/ui/DayTimeline.tsx';
import { MonthGrid } from './src/ui/MonthGrid.tsx';
import { EventEditSheet, type EditSeed } from './src/ui/EventEditSheet.tsx';
import { SettingsSheet } from './src/ui/SettingsSheet.tsx';
import { palette } from './src/ui/theme.ts';
import { WeekStrip } from './src/ui/WeekStrip.tsx';

const backendAtoms = makeBackendAtoms(backendClient);

type ViewKind = 'day' | 'month';

function CalendarScreen() {
  const timeZone = Temporal.Now.timeZoneId();
  const [view, setView] = useState<ViewKind>('day');
  const [focused, setFocused] = useState(() => Temporal.Now.plainDateISO(timeZone));
  const [showSettings, setShowSettings] = useState(false);
  const [editSeed, setEditSeed] = useState<EditSeed | null>(null);

  useBackendInvalidations(subscribeInvalidations);
  useEffect(() => {
    startSync();
  }, []);

  const range = useMemo(
    () =>
      view === 'day'
        ? dayRange(focused, timeZone)
        : monthGridRange(
            Temporal.PlainYearMonth.from(focused),
            Temporal.Now.plainDateISO(timeZone),
            timeZone,
          ),
    [view, focused, timeZone],
  );
  const events = useEventsInRange(range.startUtc, range.endUtc);
  const calendars = useCalendars();

  const colorOf = useMemo(() => {
    const byKey = new Map(
      calendars.map((calendar) => [`${calendar.accountId}:${calendar.id}`, calendar.colorHex]),
    );
    return (event: EventRecord) => byKey.get(`${event.accountId}:${event.calendarId}`) ?? '#4285f4';
  }, [calendars]);

  const weekDays = useMemo(() => {
    const start = weekStart(focused);
    return Array.from({ length: 7 }, (_, index) => start.add({ days: index }));
  }, [focused]);

  const title =
    view === 'month'
      ? focused.toLocaleString('en-US', { month: 'long', year: 'numeric' })
      : focused.toLocaleString('en-US', {
          day: 'numeric',
          month: 'long',
          weekday: 'short',
        });

  const step = (direction: 1 | -1) => {
    setFocused((current) =>
      view === 'month' ? current.add({ months: direction }) : current.add({ days: direction }),
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <View style={styles.headerActions}>
          <Pressable onPress={() => step(-1)} style={styles.navButton}>
            <Text style={styles.navLabel}>‹</Text>
          </Pressable>
          <Pressable
            onPress={() => setFocused(Temporal.Now.plainDateISO(timeZone))}
            style={styles.navButton}
          >
            <Text style={styles.todayLabel}>Today</Text>
          </Pressable>
          <Pressable onPress={() => step(1)} style={styles.navButton}>
            <Text style={styles.navLabel}>›</Text>
          </Pressable>
          <Pressable onPress={() => setEditSeed({ initialDate: focused })} style={styles.navButton}>
            <Text style={styles.addLabel}>＋</Text>
          </Pressable>
          <Pressable onPress={() => setShowSettings(true)} style={styles.navButton}>
            <Text style={styles.navLabel}>⚙</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.segment}>
        {(['day', 'month'] as const).map((kind) => (
          <Pressable
            key={kind}
            onPress={() => setView(kind)}
            style={[styles.segmentItem, view === kind && styles.segmentActive]}
          >
            <Text style={[styles.segmentLabel, view === kind && styles.segmentLabelActive]}>
              {kind === 'day' ? 'Day' : 'Month'}
            </Text>
          </Pressable>
        ))}
      </View>

      {view === 'day' ? (
        <>
          <WeekStrip days={weekDays} onSelect={setFocused} selected={focused} timeZone={timeZone} />
          <DayTimeline
            colorOf={colorOf}
            date={focused}
            events={events}
            onEventPress={(event) => setEditSeed({ event, initialDate: focused })}
            timeZone={timeZone}
          />
        </>
      ) : (
        <MonthGrid
          colorOf={colorOf}
          events={events}
          onSelectDay={(date) => {
            setFocused(date);
            setView('day');
          }}
          timeZone={timeZone}
          yearMonth={Temporal.PlainYearMonth.from(focused)}
        />
      )}

      <EventEditSheet
        calendars={calendars}
        onClose={() => setEditSeed(null)}
        seed={editSeed}
        timeZone={timeZone}
      />
      <SettingsSheet onClose={() => setShowSettings(false)} visible={showSettings} />
    </SafeAreaView>
  );
}

export function App() {
  return (
    <BackendProvider atoms={backendAtoms}>
      <CalendarScreen />
    </BackendProvider>
  );
}

const styles = StyleSheet.create({
  addLabel: {
    color: '#2563eb',
    fontSize: 18,
    fontWeight: '600',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerActions: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  navButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  navLabel: {
    color: palette.textMuted,
    fontSize: 18,
  },
  safeArea: {
    backgroundColor: palette.background,
    flex: 1,
  },
  segment: {
    alignSelf: 'center',
    backgroundColor: '#e5e5e5',
    borderRadius: 9,
    flexDirection: 'row',
    marginBottom: 8,
    padding: 2,
  },
  segmentActive: {
    backgroundColor: '#ffffff',
  },
  segmentItem: {
    borderRadius: 7,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  segmentLabel: {
    color: palette.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },
  segmentLabelActive: {
    color: palette.text,
    fontWeight: '600',
  },
  title: {
    color: palette.text,
    flex: 1,
    fontSize: 20,
    fontWeight: '700',
  },
  todayLabel: {
    color: palette.textMuted,
    fontSize: 14,
  },
});
