import {
  BackendProvider,
  makeBackendAtoms,
  useBackendInvalidations,
  useBackendMutations,
  useCalendars,
  useEventsInRangeStable,
  useTasksInRangeStable,
} from '@calendar/app-state';
import {
  bufferedRange,
  DAY_SWIPE_BUFFER,
  makeColorLookup,
  monthGridRange,
  Temporal,
  utcMsToPlainDate,
  weekStart,
} from '@calendar/core';
import { useEffect, useMemo, useState } from 'react';
import { AppState, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { backendClient, kickSync, startSync, subscribeInvalidations } from './src/backend.ts';
import { appleLanguageModel } from './src/appleModel.ts';
import { appleSpeech } from './src/appleSpeech.ts';
import { DayTimeline } from './src/ui/DayTimeline.tsx';
import { QuickAddBar } from './src/ui/QuickAddBar.tsx';
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
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        kickSync();
      }
    });
    return () => subscription.remove();
  }, []);

  const range = useMemo(
    () =>
      view === 'day'
        ? // Matches the strip DayTimeline renders, so a swipe reveals loaded days.
          bufferedRange(focused, 1, DAY_SWIPE_BUFFER, timeZone)
        : monthGridRange(
            Temporal.PlainYearMonth.from(focused),
            Temporal.Now.plainDateISO(timeZone),
            timeZone,
          ),
    [view, focused, timeZone],
  );
  // Stable variant: keeps the previous days' events while a new range loads,
  // so swiping never flashes an empty grid.
  const events = useEventsInRangeStable(range.startUtc, range.endUtc);
  // Tasks are date-only; the same fetched window expressed as day strings.
  const tasks = useTasksInRangeStable(
    utcMsToPlainDate(range.startUtc),
    utcMsToPlainDate(range.endUtc),
  );
  const mutations = useBackendMutations();
  const calendars = useCalendars();

  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);

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
        <Text numberOfLines={1} style={styles.title} testID="day-title">
          {title}
        </Text>
        <View style={styles.headerActions}>
          <Pressable onPress={() => step(-1)} style={styles.navButton} testID="nav-prev">
            <Text style={styles.navLabel}>‹</Text>
          </Pressable>
          <Pressable
            onPress={() => setFocused(Temporal.Now.plainDateISO(timeZone))}
            style={styles.navButton}
          >
            <Text style={styles.todayLabel}>Today</Text>
          </Pressable>
          <Pressable onPress={() => step(1)} style={styles.navButton} testID="nav-next">
            <Text style={styles.navLabel}>›</Text>
          </Pressable>
          <Pressable
            onPress={() => setEditSeed({ initialDate: focused })}
            style={styles.navButton}
            testID="add-event"
          >
            <Text style={styles.addLabel}>＋</Text>
          </Pressable>
          <Pressable
            onPress={() => setShowSettings(true)}
            style={styles.navButton}
            testID="open-settings"
          >
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
          <QuickAddBar
            focusedDate={focused}
            model={appleLanguageModel}
            onParsed={(prefill) => setEditSeed({ initialDate: focused, prefill })}
            speech={appleSpeech}
            timeZone={timeZone}
          />
          <WeekStrip days={weekDays} onSelect={setFocused} selected={focused} timeZone={timeZone} />
          <DayTimeline
            colorOf={colorOf}
            date={focused}
            events={events}
            onEventPress={(event) => setEditSeed({ event, initialDate: focused })}
            onNavigate={step}
            onToggleTask={(task) =>
              void mutations.completeTask({
                accountId: task.accountId,
                status: task.status === 'completed' ? 'needsAction' : 'completed',
                taskId: task.id,
                taskListId: task.listId,
              })
            }
            tasks={tasks}
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

      {/* Keyed + conditionally mounted: the sheet seeds its form fields from
          `seed` in useState initializers, which only run on mount. */}
      {editSeed ? (
        <EventEditSheet
          calendars={calendars}
          key={editSeed.event?.id ?? `new:${editSeed.initialDate.toString()}`}
          onClose={() => setEditSeed(null)}
          seed={editSeed}
          timeZone={timeZone}
        />
      ) : null}
      <SettingsSheet onClose={() => setShowSettings(false)} visible={showSettings} />
    </SafeAreaView>
  );
}

export function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <BackendProvider atoms={backendAtoms}>
        <CalendarScreen />
      </BackendProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // eslint-disable-next-line perfectionist/sort-objects -- root first for clarity
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
