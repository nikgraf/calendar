import {
  BackendProvider,
  useGuardedMutations,
  makeBackendAtoms,
  useBackendInvalidations,
  useCalendarNavigation,
  useCalendars,
  useCaptureModel,
  useEventsInRangeStable,
  useListColorLookup,
  useOverdueTasksStable,
  usePendingOps,
  useTaskLists,
  useBirthdaysInRangeStable,
  useTaskReadOnlyLookup,
  useTasksInRangeStable,
  useTimeZones,
  useToday,
  type EventEditorPrefill,
} from '@calendar/app-state';
import {
  type BirthdayOccurrence,
  DAY_SWIPE_BUFFER,
  makeColorLookup,
  type TaskRecord,
  Temporal,
  TWO_DAY_SWIPE_BUFFER,
  utcMsToPlainDate,
  WEEK_SWIPE_BUFFER,
  weekStart,
} from '@calendar/core';
import { useEffect, useMemo, useState } from 'react';
import {
  AppState,
  Linking,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  backendClient,
  kickSync,
  runLocalNotifications,
  startSync,
  subscribeInvalidations,
} from './src/backend.ts';
import { registerBackgroundRefresh } from './src/backgroundTask.ts';
import { appleSpeech } from './src/appleSpeech.ts';
import {
  discardingAfterRead,
  fixtureShareFromUrl,
  takeIncomingShare,
} from './src/incomingShare.ts';
import { languageModel, modelFixture, textRecognizer } from './src/model.ts';
import { makeFindSlots, type CaptureSource } from '@calendar/ai';
import { CaptureBanner } from './src/ui/CaptureBanner.tsx';
import { CaptureSheet } from './src/ui/CaptureSheet.tsx';
import { DayTimeline } from './src/ui/DayTimeline.tsx';

import { QuickAddBar } from './src/ui/QuickAddBar.tsx';
import { MonthGrid } from './src/ui/MonthGrid.tsx';
import { EventEditSheet, type EditSeed } from './src/ui/EventEditSheet.tsx';
import { SettingsSheet } from './src/ui/SettingsSheet.tsx';
import { ConflictBanner, DroppedToast, MutationNoticeToast } from './src/ui/Toast.tsx';
import { ErrorBoundary } from './src/ui/ErrorBoundary.tsx';
import { palette } from './src/ui/theme.ts';
import { WeekStrip } from './src/ui/WeekStrip.tsx';

const backendAtoms = makeBackendAtoms(backendClient);

const SEGMENT_LABELS = { day: 'Day', month: 'Month', twoDay: '2 Days', week: 'Week' } as const;

/** The share extension opens the app at `<scheme>://expo-sharing` once the payload is stored. */
const isShareUrl = (url: string) => /^[a-z-]+:\/\/expo-sharing/i.test(url);
/** Images shared into the app are deleted once read; see incomingShare.ts. */
const recognizer = discardingAfterRead(textRecognizer);

/**
 * Sync, invalidations and background refresh start here, whatever the
 * zones; the calendar itself waits for the device-local time zones so its
 * first frame is already in the primary zone (a frame in the device zone
 * followed by a re-layout would, near midnight with a distant primary,
 * also seed the focused day and "today" with the wrong date).
 */
function CalendarScreen() {
  useBackendInvalidations(subscribeInvalidations);
  useEffect(() => {
    startSync();
    registerBackgroundRefresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        kickSync();
        runLocalNotifications();
      }
    });
    return () => subscription.remove();
  }, []);
  const zones = useTimeZones();
  if (!zones.loaded) {
    return <SafeAreaView style={styles.safeArea} />;
  }
  return <CalendarBody primary={zones.primary} secondary={zones.secondary} />;
}

function CalendarBody({
  primary: timeZone,
  secondary: secondaryZones,
}: {
  primary: string;
  secondary: ReadonlyArray<string>;
}) {
  const {
    buffer,
    days,
    focused,
    goToday,
    panByDays,
    range,
    setFocused,
    step,
    switchView,
    title,
    view,
  } = useCalendarNavigation({
    dayBuffer: DAY_SWIPE_BUFFER,
    initialView: 'day',
    timeZone,
    titleStyle: 'compact',
    twoDayBuffer: TWO_DAY_SWIPE_BUFFER,
    weekBuffer: WEEK_SWIPE_BUFFER,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [editSeed, setEditSeed] = useState<EditSeed | null>(null);
  const [editTask, setEditTask] = useState<TaskRecord | null>(null);
  const [viewBirthday, setViewBirthday] = useState<BirthdayOccurrence | null>(null);
  /** The capture row whose edit sheet is open, so a save can mark it added. */
  const [captureRow, setCaptureRow] = useState<string | null>(null);

  // A parsed prefill (quick-add, or a single captured event) opens the
  // editor: the user reviews it before anything is written.
  const openPrefill = (prefill: EventEditorPrefill) => {
    setEditSeed({ initialDate: Temporal.PlainDate.from(prefill.date), prefill });
  };
  const capture = useCaptureModel({
    model: languageModel,
    onSingle: openPrefill,
    recognizer,
    timeZone,
  });

  // Something shared into the app (the share sheet, or the e2e flows' deep
  // link under the fixture model) starts a capture — over whatever sheet was
  // open, since the share is what the user is doing now. The extension
  // stores the payload and opens the app, so it is picked up on that URL and
  // again whenever the app comes to the foreground; a store read twice is
  // empty the second time.
  const startCapture = (source: CaptureSource) => {
    setShowSettings(false);
    setEditSeed(null);
    setEditTask(null);
    setViewBirthday(null);
    setCaptureRow(null);
    capture.start(source);
  };
  useEffect(() => {
    const pickUpShare = () => {
      const source = takeIncomingShare();
      if (source) {
        startCapture(source);
      }
    };
    const onUrl = (url: string | null) => {
      if (!url) {
        return;
      }
      if (isShareUrl(url)) {
        pickUpShare();
        return;
      }
      const fixtureSource = modelFixture ? fixtureShareFromUrl(url) : undefined;
      if (fixtureSource) {
        startCapture(fixtureSource);
      }
    };
    pickUpShare();
    void Linking.getInitialURL().then(onUrl);
    const urlSubscription = Linking.addEventListener('url', ({ url }) => onUrl(url));
    const stateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        pickUpShare();
      }
    });
    return () => {
      urlSubscription.remove();
      stateSubscription.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once; the handlers read fresh state through the hook's refs
  }, []);

  // Stable variant: keeps the previous days' events while a new range loads,
  // so swiping never flashes an empty grid.
  const events = useEventsInRangeStable(range.startUtc, range.endUtc);
  // Tasks use date bounds even when a reminder also carries a due time.
  const tasks = useTasksInRangeStable(
    utcMsToPlainDate(range.startUtc),
    utcMsToPlainDate(range.endUtc),
  );
  const birthdays = useBirthdaysInRangeStable(
    utcMsToPlainDate(range.startUtc),
    utcMsToPlainDate(range.endUtc),
  );
  // Open tasks due before today are drawn on today, whatever the window.
  const today = useToday(timeZone);
  const overdue = useOverdueTasksStable(today);
  const mutations = useGuardedMutations();
  const taskLists = useTaskLists();
  const isTaskReadOnly = useTaskReadOnlyLookup();
  const pendingOps = usePendingOps();
  const listColorOf = useListColorLookup();
  const findSlots = useMemo(
    () => makeFindSlots(languageModel, backendClient, timeZone),
    [timeZone],
  );
  const calendars = useCalendars();

  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);

  // Day view: the focused day's Monday week as a date picker. The two-day
  // and week views draw their own headers inside the timeline, panning
  // with the columns.
  const stripDays = useMemo(() => {
    const start = weekStart(focused);
    return Array.from({ length: 7 }, (_, index) => start.add({ days: index }));
  }, [focused]);
  const unit =
    view === 'month' ? 'month' : view === 'week' ? 'week' : view === 'twoDay' ? '2 days' : 'day';

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
        {(['day', 'twoDay', 'week', 'month'] as const).map((kind) => (
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
          birthdays={birthdays}
          colorOf={colorOf}
          events={events}
          listColorOf={listColorOf}
          onSelectDay={(date) => {
            setFocused(date);
            switchView('day');
          }}
          overdue={overdue}
          tasks={tasks}
          timeZone={timeZone}
          today={today}
          yearMonth={Temporal.PlainYearMonth.from(focused)}
        />
      ) : (
        <>
          <QuickAddBar
            findSlots={findSlots}
            focusedDate={focused}
            model={languageModel}
            onParsed={(prefill) => setEditSeed({ initialDate: focused, prefill })}
            speech={appleSpeech}
            timeZone={timeZone}
          />
          {view === 'day' ? (
            <WeekStrip
              days={stripDays}
              onSelect={setFocused}
              selected={focused}
              timeZone={timeZone}
            />
          ) : null}
          <DayTimeline
            birthdays={birthdays}
            buffer={buffer}
            colorOf={colorOf}
            days={days}
            events={events}
            isTaskReadOnly={isTaskReadOnly}
            listColorOf={listColorOf}
            onBirthdayPress={(birthday) => setViewBirthday(birthday)}
            onCreateSlot={(date, times) => setEditSeed({ initialDate: date, initialTimes: times })}
            onEventPress={(event) => setEditSeed({ event, initialDate: focused })}
            onNavigate={panByDays}
            onSelectDay={(day) => {
              setFocused(day);
              switchView('day');
            }}
            onTaskPress={(task) => setEditTask(task)}
            onToggleTask={(task) =>
              void mutations.completeTask({
                accountId: task.accountId,
                status: task.status === 'completed' ? 'needsAction' : 'completed',
                taskId: task.id,
                taskListId: task.listId,
              })
            }
            overdue={overdue}
            secondaryZones={secondaryZones}
            selected={focused}
            tasks={tasks}
            timeZone={timeZone}
            today={today}
          />
        </>
      )}

      {/* Keyed + conditionally mounted: the sheet seeds its form fields from
          `seed` in useState initializers, which only run on mount. Under a
          capture review it renders inside that sheet: two sibling Modals
          never present together on iOS. */}
      {(() => {
        const editSheet =
          editSeed || editTask || viewBirthday ? (
            <EventEditSheet
              birthday={viewBirthday ?? undefined}
              calendars={calendars}
              key={
                viewBirthday
                  ? `birthday:${viewBirthday.record.id}:${viewBirthday.date}`
                  : editTask
                    ? `task:${editTask.id}`
                    : (editSeed?.event?.id ??
                      `new:${editSeed?.initialDate.toString()}:${editSeed?.initialTimes?.startTime ?? ''}`)
              }
              onClose={() => {
                setEditSeed(null);
                setEditTask(null);
                setViewBirthday(null);
                setCaptureRow(null);
              }}
              onSaved={captureRow ? () => capture.markAdded(captureRow) : undefined}
              seed={editSeed ?? { initialDate: focused }}
              task={editTask ?? undefined}
              taskLists={taskLists}
              timeZone={timeZone}
            />
          ) : null;
        return capture.state.kind === 'review' ? (
          <CaptureSheet
            onClose={capture.dismiss}
            onOpenRow={(row) => {
              setCaptureRow(row.id);
              openPrefill(row.prefill);
            }}
            rows={capture.state.rows}
            truncated={capture.state.truncated}
          >
            {editSheet}
          </CaptureSheet>
        ) : (
          editSheet
        );
      })()}
      <SettingsSheet onClose={() => setShowSettings(false)} visible={showSettings} />
      <ConflictBanner />
      <DroppedToast />
      <MutationNoticeToast />
      <CaptureBanner onDismiss={capture.dismiss} state={capture.state} />
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
