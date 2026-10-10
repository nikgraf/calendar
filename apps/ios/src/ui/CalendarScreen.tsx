import {
  useGuardedMutations,
  useBackendInvalidations,
  useCalendarNavigation,
  useCalendars,
  useEventsInRangeStable,
  useListColorLookup,
  useOverdueTasksStable,
  useBirthdaysInRangeStable,
  useEventReadOnlyLookup,
  useTaskReadOnlyLookup,
  useTasksInRangeStable,
  useTimeZones,
  useToday,
  useUpdateViewPreferences,
  useViewPreferences,
  type CalendarViewKind,
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
import { useEffect, useMemo } from 'react';
import { MenuView } from '@expo/ui/community/menu';
import { StatusBar } from 'expo-status-bar';
import { AppState, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { kickSync, runLocalNotifications, startSync, subscribeInvalidations } from '../backend.ts';
import { registerBackgroundRefresh } from '../backgroundTask.ts';
import { AccountButton } from './AccountButton.tsx';
import { ADD_BUTTON_CLEARANCE, AddButton } from './AddButton.tsx';
import { AgendaView } from './AgendaView.tsx';
import { DayTimeline } from './DayTimeline.tsx';
import { useEditorHost } from './EditorHost.tsx';
import { MonthGrid } from './MonthGrid.tsx';
import {
  ConflictBanner,
  DroppedToast,
  MutationNoticeToast,
  NOTICE_GAP,
  NoticeStack,
} from './Toast.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';
import { WeekStrip } from './WeekStrip.tsx';

/** The view menu's entries, in order. */
const VIEWS: ReadonlyArray<{ readonly id: CalendarViewKind; readonly label: string }> = [
  { id: 'day', label: 'Day' },
  { id: 'twoDay', label: '2 Days' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'agenda', label: 'Agenda' },
];
const isViewKind = (value: string): value is CalendarViewKind =>
  VIEWS.some((entry) => entry.id === value);

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
  const prefs = useViewPreferences();
  if (!zones.loaded || prefs === null) {
    return <SafeAreaView style={styles.safeArea} />;
  }
  return (
    <CalendarBody
      initialView={prefs.lastView ?? 'day'}
      primary={zones.primary}
      secondary={zones.secondary}
    />
  );
}

function CalendarBody({
  initialView,
  primary: timeZone,
  secondary: secondaryZones,
}: {
  initialView: CalendarViewKind;
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
    initialView,
    timeZone,
    titleStyle: 'compact',
    twoDayBuffer: TWO_DAY_SWIPE_BUFFER,
    weekBuffer: WEEK_SWIPE_BUFFER,
  });
  const host = useEditorHost();
  const updatePrefs = useUpdateViewPreferences();
  /** The view is device taste: it persists, and the app reopens on it. */
  const changeView = (next: CalendarViewKind) => {
    switchView(next);
    updatePrefs({ lastView: next });
  };

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
    view === 'month'
      ? 'month'
      : view === 'week'
        ? 'week'
        : view === 'twoDay'
          ? '2 days'
          : view === 'agenda'
            ? '2 weeks'
            : 'day';
  const viewLabel = VIEWS.find((entry) => entry.id === view)?.label ?? 'Day';

  return (
    <SafeAreaView style={styles.safeArea} testID="calendar-screen">
      <StatusBar style="auto" />
      <View style={styles.header}>
        <Text
          maxFontSizeMultiplier={BOX_FONT_SCALE}
          numberOfLines={1}
          style={styles.title}
          testID="day-title"
        >
          {title}
        </Text>
        <View style={styles.headerActions}>
          {/* The view menu: Day · 2 Days · Week · Month · Agenda, the current one checked. */}
          <MenuView
            actions={VIEWS.map((entry) => ({
              id: entry.id,
              state: view === entry.id ? 'on' : 'off',
              title: entry.label,
            }))}
            onPressAction={({ nativeEvent }) => {
              if (isViewKind(nativeEvent.event)) {
                changeView(nativeEvent.event);
              }
            }}
            title="View"
          >
            <Pressable
              accessibilityLabel={`View: ${viewLabel}`}
              accessibilityRole="button"
              style={styles.viewButton}
              testID="view-menu"
            >
              <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.viewButtonLabel}>
                {viewLabel} ▾
              </Text>
            </Pressable>
          </MenuView>
          {/* Icon-only buttons: VoiceOver read the glyphs ("‹") without labels.
              The header is a bar: its text stops at BOX_FONT_SCALE, and at
              the accessibility sizes a long press shows a button enlarged
              in the Large Content Viewer, as on the system's bars. */}
          <Pressable
            accessibilityLabel={`Previous ${unit}`}
            accessibilityLargeContentTitle={`Previous ${unit}`}
            accessibilityRole="button"
            accessibilityShowsLargeContentViewer
            onPress={() => step(-1)}
            style={styles.navButton}
            testID="nav-prev"
          >
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.navLabel}>
              ‹
            </Text>
          </Pressable>
          <Pressable
            accessibilityLargeContentTitle="Today"
            accessibilityRole="button"
            accessibilityShowsLargeContentViewer
            onPress={goToday}
            style={styles.navButton}
            testID="today"
          >
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.todayLabel}>
              Today
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel={`Next ${unit}`}
            accessibilityLargeContentTitle={`Next ${unit}`}
            accessibilityRole="button"
            accessibilityShowsLargeContentViewer
            onPress={() => step(1)}
            style={styles.navButton}
            testID="nav-next"
          >
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.navLabel}>
              ›
            </Text>
          </Pressable>
          {/* Settings, with the unsynced count as its badge (the ambient
              counterpart of the desktop sidebar's SyncStatus). */}
          <AccountButton />
        </View>
      </View>

      {view === 'month' ? (
        <MonthGrid
          birthdays={birthdays}
          colorOf={colorOf}
          events={events}
          listColorOf={listColorOf}
          onSelectDay={(date) => {
            setFocused(date);
            changeView('day');
          }}
          overdue={overdue}
          tasks={tasks}
          timeZone={timeZone}
          today={today}
          yearMonth={Temporal.PlainYearMonth.from(focused)}
        />
      ) : view === 'agenda' ? (
        <AgendaView
          birthdays={birthdays}
          colorOf={colorOf}
          days={days}
          events={events}
          onBirthdayPress={host.openBirthday}
          onEventPress={host.openEvent}
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
          tasks={tasks}
          timeZone={timeZone}
          today={today}
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
              changeView('day');
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

      {/* A new event on the day being viewed. */}
      <AddButton onPress={() => host.openNew({ focused, kind: 'event' })} />
      {/* The notices stand on the same row: above the tab bar on iOS 26,
          where "+" hangs into the bar, and above the floating "+" before. */}
      <NoticeStack offset={ADD_BUTTON_CLEARANCE + NOTICE_GAP}>
        <MutationNoticeToast />
        <DroppedToast />
        <ConflictBanner />
      </NoticeStack>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
    safeArea: {
      backgroundColor: colors.canvas,
      flex: 1,
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
    viewButton: {
      backgroundColor: colors.fill,
      borderRadius: 8,
      marginRight: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    viewButtonLabel: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
    },
  });
