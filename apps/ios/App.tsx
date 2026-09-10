import {
  BackendProvider,
  useGuardedMutations,
  makeBackendAtoms,
  useBackendInvalidations,
  useCalendarNavigation,
  useCalendars,
  useEventsInRangeStable,
  useListColorLookup,
  useTaskLists,
  useTasksInRangeStable,
} from '@calendar/app-state';
import {
  DAY_SWIPE_BUFFER,
  makeColorLookup,
  type TaskRecord,
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
import { makeFindSlots } from '@calendar/ai';
import { DayTimeline } from './src/ui/DayTimeline.tsx';

import { QuickAddBar } from './src/ui/QuickAddBar.tsx';
import { MonthGrid } from './src/ui/MonthGrid.tsx';
import { EventEditSheet, type EditSeed } from './src/ui/EventEditSheet.tsx';
import { SettingsSheet } from './src/ui/SettingsSheet.tsx';
import { ConflictToast, DroppedToast, MutationNoticeToast } from './src/ui/Toast.tsx';
import { ErrorBoundary } from './src/ui/ErrorBoundary.tsx';
import { palette } from './src/ui/theme.ts';
import { WeekStrip } from './src/ui/WeekStrip.tsx';

const backendAtoms = makeBackendAtoms(backendClient);

function CalendarScreen() {
  const timeZone = Temporal.Now.timeZoneId();
  const { focused, goToday, range, setFocused, step, switchView, title, view } =
    useCalendarNavigation({
      dayBuffer: DAY_SWIPE_BUFFER,
      initialView: 'day',
      timeZone,
      titleStyle: 'compact',
    });
  const [showSettings, setShowSettings] = useState(false);
  const [editSeed, setEditSeed] = useState<EditSeed | null>(null);
  const [editTask, setEditTask] = useState<TaskRecord | null>(null);

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

  // Stable variant: keeps the previous days' events while a new range loads,
  // so swiping never flashes an empty grid.
  const events = useEventsInRangeStable(range.startUtc, range.endUtc);
  // Tasks are date-only; the same fetched window expressed as day strings.
  const tasks = useTasksInRangeStable(
    utcMsToPlainDate(range.startUtc),
    utcMsToPlainDate(range.endUtc),
  );
  const mutations = useGuardedMutations();
  const taskLists = useTaskLists();
  const listColorOf = useListColorLookup();
  const findSlots = useMemo(
    () => makeFindSlots(appleLanguageModel, backendClient, timeZone),
    [timeZone],
  );
  const calendars = useCalendars();

  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);

  const weekDays = useMemo(() => {
    const start = weekStart(focused);
    return Array.from({ length: 7 }, (_, index) => start.add({ days: index }));
  }, [focused]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.title} testID="day-title">
          {title}
        </Text>
        <View style={styles.headerActions}>
          {/* Icon-only buttons: VoiceOver read the glyphs ("‹", "＋") without labels. */}
          <Pressable
            accessibilityLabel={view === 'month' ? 'Previous month' : 'Previous day'}
            accessibilityRole="button"
            onPress={() => step(-1)}
            style={styles.navButton}
            testID="nav-prev"
          >
            <Text style={styles.navLabel}>‹</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={goToday} style={styles.navButton}>
            <Text style={styles.todayLabel}>Today</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={view === 'month' ? 'Next month' : 'Next day'}
            accessibilityRole="button"
            onPress={() => step(1)}
            style={styles.navButton}
            testID="nav-next"
          >
            <Text style={styles.navLabel}>›</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="New event"
            accessibilityRole="button"
            onPress={() => setEditSeed({ initialDate: focused })}
            style={styles.navButton}
            testID="add-event"
          >
            <Text style={styles.addLabel}>＋</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Settings"
            accessibilityRole="button"
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
            accessibilityRole="button"
            accessibilityState={{ selected: view === kind }}
            key={kind}
            onPress={() => switchView(kind)}
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
            findSlots={findSlots}
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
            listColorOf={listColorOf}
            onEventPress={(event) => setEditSeed({ event, initialDate: focused })}
            onNavigate={step}
            onTaskPress={(task) => setEditTask(task)}
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
            switchView('day');
          }}
          timeZone={timeZone}
          yearMonth={Temporal.PlainYearMonth.from(focused)}
        />
      )}

      {/* Keyed + conditionally mounted: the sheet seeds its form fields from
          `seed` in useState initializers, which only run on mount. */}
      {editSeed || editTask ? (
        <EventEditSheet
          calendars={calendars}
          key={
            editTask
              ? `task:${editTask.id}`
              : (editSeed?.event?.id ?? `new:${editSeed?.initialDate.toString()}`)
          }
          onClose={() => {
            setEditSeed(null);
            setEditTask(null);
          }}
          seed={editSeed ?? { initialDate: focused }}
          task={editTask ?? undefined}
          taskLists={taskLists}
          timeZone={timeZone}
        />
      ) : null}
      <SettingsSheet onClose={() => setShowSettings(false)} visible={showSettings} />
      <ConflictToast />
      <DroppedToast />
      <MutationNoticeToast />
    </SafeAreaView>
  );
}

export function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <ErrorBoundary>
        <BackendProvider atoms={backendAtoms}>
          <CalendarScreen />
        </BackendProvider>
      </ErrorBoundary>
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
