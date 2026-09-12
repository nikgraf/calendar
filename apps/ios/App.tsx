import {
  BackendProvider,
  useGuardedMutations,
  makeBackendAtoms,
  useBackendInvalidations,
  useCalendarNavigation,
  useCalendars,
  useEventsInRangeStable,
  useListColorLookup,
  usePendingOps,
  useTaskLists,
  useBirthdaysInRangeStable,
  useTasksInRangeStable,
} from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  DAY_SWIPE_BUFFER,
  makeColorLookup,
  type TaskRecord,
  Temporal,
  utcMsToPlainDate,
  WEEK_SWIPE_BUFFER,
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
import { EDGE_INSET, GUTTER_WIDTH } from './src/ui/timelineLayout.ts';
import { WeekStrip } from './src/ui/WeekStrip.tsx';

const backendAtoms = makeBackendAtoms(backendClient);

const SEGMENT_LABELS = { day: 'Day', month: 'Month', week: 'Week' } as const;

function CalendarScreen() {
  const timeZone = Temporal.Now.timeZoneId();
  const { buffer, days, focused, goToday, range, setFocused, step, switchView, title, view } =
    useCalendarNavigation({
      dayBuffer: DAY_SWIPE_BUFFER,
      initialView: 'day',
      timeZone,
      titleStyle: 'compact',
      weekBuffer: WEEK_SWIPE_BUFFER,
    });
  const [showSettings, setShowSettings] = useState(false);
  const [editSeed, setEditSeed] = useState<EditSeed | null>(null);
  const [editTask, setEditTask] = useState<TaskRecord | null>(null);
  const [viewBirthday, setViewBirthday] = useState<BirthdayOccurrence | null>(null);

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
  const birthdays = useBirthdaysInRangeStable(
    utcMsToPlainDate(range.startUtc),
    utcMsToPlainDate(range.endUtc),
  );
  const mutations = useGuardedMutations();
  const taskLists = useTaskLists();
  const pendingOps = usePendingOps();
  const listColorOf = useListColorLookup();
  const findSlots = useMemo(
    () => makeFindSlots(appleLanguageModel, backendClient, timeZone),
    [timeZone],
  );
  const calendars = useCalendars();

  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);

  // Day view: the focused day's Monday week. Week view: the rolling window
  // itself, so the strip doubles as the column headers.
  const stripDays = useMemo(() => {
    if (view === 'week') {
      return days;
    }
    const start = weekStart(focused);
    return Array.from({ length: 7 }, (_, index) => start.add({ days: index }));
  }, [days, focused, view]);
  const unit = view === 'month' ? 'month' : view === 'week' ? 'week' : 'day';

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.title} testID="day-title">
          {title}
        </Text>
        <View style={styles.headerActions}>
          {/* Ambient counterpart of the desktop sidebar's SyncStatus; the
              list itself (with Discard) lives in Settings. */}
          {pendingOps.length > 0 ? (
            <Pressable
              accessibilityLabel={`${String(pendingOps.length)} unsynced ${pendingOps.length === 1 ? 'change' : 'changes'}, open settings`}
              accessibilityRole="button"
              onPress={() => setShowSettings(true)}
              style={styles.pendingBadge}
              testID="pending-badge"
            >
              <Text style={styles.pendingBadgeLabel}>{pendingOps.length} unsynced</Text>
            </Pressable>
          ) : null}
          {/* Icon-only buttons: VoiceOver read the glyphs ("‹", "＋") without labels. */}
          <Pressable
            accessibilityLabel={`Previous ${unit}`}
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
            accessibilityLabel={`Next ${unit}`}
            accessibilityRole="button"
            onPress={() => step(1)}
            style={styles.navButton}
            testID="nav-next"
          >
            <Text style={styles.navLabel}>›</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Add event"
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
        {(['day', 'week', 'month'] as const).map((kind) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: view === kind }}
            key={kind}
            onPress={() => switchView(kind)}
            style={[styles.segmentItem, view === kind && styles.segmentActive]}
          >
            <Text style={[styles.segmentLabel, view === kind && styles.segmentLabelActive]}>
              {SEGMENT_LABELS[kind]}
            </Text>
          </Pressable>
        ))}
      </View>

      {view === 'month' ? (
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
      ) : (
        <>
          <QuickAddBar
            findSlots={findSlots}
            focusedDate={focused}
            model={appleLanguageModel}
            onParsed={(prefill) => setEditSeed({ initialDate: focused, prefill })}
            speech={appleSpeech}
            timeZone={timeZone}
          />
          <WeekStrip
            days={stripDays}
            leadingInset={view === 'week' ? GUTTER_WIDTH : 0}
            onSelect={(day) => {
              setFocused(day);
              if (view === 'week') {
                switchView('day');
              }
            }}
            selected={focused}
            timeZone={timeZone}
            trailingInset={view === 'week' ? EDGE_INSET : 0}
          />
          <DayTimeline
            birthdays={birthdays}
            buffer={buffer}
            colorOf={colorOf}
            days={days}
            events={events}
            listColorOf={listColorOf}
            onBirthdayPress={(birthday) => setViewBirthday(birthday)}
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
      )}

      {/* Keyed + conditionally mounted: the sheet seeds its form fields from
          `seed` in useState initializers, which only run on mount. */}
      {editSeed || editTask || viewBirthday ? (
        <EventEditSheet
          birthday={viewBirthday ?? undefined}
          calendars={calendars}
          key={
            viewBirthday
              ? `birthday:${viewBirthday.record.id}:${viewBirthday.date}`
              : editTask
                ? `task:${editTask.id}`
                : (editSeed?.event?.id ?? `new:${editSeed?.initialDate.toString()}`)
          }
          onClose={() => {
            setEditSeed(null);
            setEditTask(null);
            setViewBirthday(null);
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
  pendingBadge: {
    backgroundColor: '#fef3c7',
    borderRadius: 10,
    marginRight: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pendingBadgeLabel: {
    color: '#92400e',
    fontSize: 12,
    fontWeight: '600',
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
