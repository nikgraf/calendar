import {
  useGuardedMutations,
  useBackendInvalidations,
  useCalendarNavigation,
  useCalendars,
  useEventsInRangeStable,
  useListColorLookup,
  useOverdueTasksStable,
  usePendingOps,
  useBirthdaysInRangeStable,
  useEventReadOnlyLookup,
  useTaskReadOnlyLookup,
  useTasksInRangeStable,
  useTimeZones,
  useToday,
} from '@calendar/app-state';
import {
  DAY_SWIPE_BUFFER,
  makeColorLookup,
  Temporal,
  TWO_DAY_SWIPE_BUFFER,
  utcMsToPlainDate,
  WEEK_SWIPE_BUFFER,
  weekStart,
} from '@calendar/core';
import { useEffect, useMemo, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { kickSync, runLocalNotifications, startSync, subscribeInvalidations } from '../backend.ts';
import { registerBackgroundRefresh } from '../backgroundTask.ts';
import { DayTimeline } from './DayTimeline.tsx';
import { useEditorHost } from './EditorHost.tsx';
import { MonthGrid } from './MonthGrid.tsx';
import { SettingsSheet } from './SettingsSheet.tsx';
import { ConflictBanner, DroppedToast, MutationNoticeToast } from './Toast.tsx';
import { type ThemeColors, useStyles } from './theme.ts';
import { WeekStrip } from './WeekStrip.tsx';

const SEGMENT_LABELS = { day: 'Day', month: 'Month', twoDay: '2 Days', week: 'Week' } as const;

/**
 * Sync, invalidations and background refresh start here, whatever the
 * zones; the calendar itself waits for the device-local time zones so its
 * first frame is already in the primary zone (a frame in the device zone
 * followed by a re-layout would, near midnight with a distant primary,
 * also seed the focused day and "today" with the wrong date).
 */
export function CalendarScreen() {
  const styles = useStyles(makeStyles);
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
  const styles = useStyles(makeStyles);
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
  const host = useEditorHost();

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
  const isTaskReadOnly = useTaskReadOnlyLookup();
  const isEventReadOnly = useEventReadOnlyLookup();
  const pendingOps = usePendingOps();
  const listColorOf = useListColorLookup();
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
      <StatusBar style="auto" />
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
            isEventReadOnly={isEventReadOnly}
            isTaskReadOnly={isTaskReadOnly}
            listColorOf={listColorOf}
            onBirthdayPress={host.openBirthday}
            onCreateSlot={(date, times) =>
              host.editEvent({ initialDate: date, initialTimes: times })
            }
            onEventPress={host.openEvent}
            onNavigate={panByDays}
            onSelectDay={(day) => {
              setFocused(day);
              switchView('day');
            }}
            onTaskPress={host.editTask}
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

      <Pressable
        accessibilityLabel="Add"
        accessibilityRole="button"
        onPress={host.openQuickAdd}
        style={styles.fab}
        testID="add"
      >
        <Text style={styles.fabLabel}>＋</Text>
      </Pressable>
      <SettingsSheet onClose={() => setShowSettings(false)} visible={showSettings} />
      <ConflictBanner />
      <DroppedToast />
      <MutationNoticeToast />
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Above the floating tab bar: iOS 26 draws the Search tab as its own
    // circle at the bottom right, exactly where a bottom-aligned FAB sat.
    fab: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 28,
      bottom: 104,
      elevation: 4,
      height: 56,
      justifyContent: 'center',
      position: 'absolute',
      right: 20,
      shadowColor: '#000000',
      shadowOffset: { height: 4, width: 0 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
      width: 56,
    },
    fabLabel: {
      color: colors['on-primary'],
      fontSize: 28,
      fontWeight: '600',
      lineHeight: 32,
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
      color: colors['text-secondary'],
      fontSize: 18,
    },
    pendingBadge: {
      backgroundColor: colors.warning,
      borderRadius: 10,
      marginRight: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    pendingBadgeLabel: {
      color: colors['on-warning'],
      fontSize: 12,
      fontWeight: '600',
    },
    safeArea: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    segment: {
      alignSelf: 'center',
      backgroundColor: colors.border,
      borderRadius: 9,
      flexDirection: 'row',
      marginBottom: 8,
      padding: 2,
    },
    segmentActive: {
      backgroundColor: colors.surface,
    },
    segmentItem: {
      borderRadius: 7,
      paddingHorizontal: 16,
      paddingVertical: 4,
    },
    segmentLabel: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '500',
    },
    segmentLabelActive: {
      color: colors.text,
      fontWeight: '600',
    },
    title: {
      color: colors.text,
      flex: 1,
      fontSize: 20,
      fontWeight: '700',
    },
    todayLabel: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
  });
