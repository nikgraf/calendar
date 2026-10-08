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
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppState, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { kickSync, runLocalNotifications, startSync, subscribeInvalidations } from '../backend.ts';
import { registerBackgroundRefresh } from '../backgroundTask.ts';
import { AgendaView } from './AgendaView.tsx';
import { DayTimeline } from './DayTimeline.tsx';
import { useEditorHost } from './EditorHost.tsx';
import { MonthGrid } from './MonthGrid.tsx';
import { ConflictBanner, DroppedToast, MutationNoticeToast } from './Toast.tsx';
import { type ThemeColors, useStyles } from './theme.ts';
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
  const router = useRouter();
  const openSettings = () => router.push('/settings');
  // Straight to the list, with the Settings root under it: a push loads the
  // stack's initialRouteName only with an anchor, and without one the page
  // opened alone — no root to go back to, no Done.
  const openUnsynced = () => router.push('/settings/unsynced', { withAnchor: true });
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
        <Text numberOfLines={1} style={styles.title} testID="day-title">
          {title}
        </Text>
        <View style={styles.headerActions}>
          {/* Ambient counterpart of the desktop sidebar's SyncStatus; the
              list itself (with Discard) is Settings › Unsynced Changes. */}
          {pendingOps.length > 0 ? (
            <Pressable
              accessibilityLabel={`${String(pendingOps.length)} unsynced ${pendingOps.length === 1 ? 'change' : 'changes'}, show them`}
              accessibilityRole="button"
              onPress={openUnsynced}
              style={styles.pendingBadge}
              testID="pending-badge"
            >
              <Text style={styles.pendingBadgeLabel}>{pendingOps.length} unsynced</Text>
            </Pressable>
          ) : null}
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
              <Text style={styles.viewButtonLabel}>{viewLabel} ▾</Text>
            </Pressable>
          </MenuView>
          {/* Icon-only buttons: VoiceOver read the glyphs ("‹") without labels. */}
          <Pressable
            accessibilityLabel={`Previous ${unit}`}
            accessibilityRole="button"
            onPress={() => step(-1)}
            style={styles.navButton}
            testID="nav-prev"
          >
            <Text style={styles.navLabel}>‹</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={goToday}
            style={styles.navButton}
            testID="today"
          >
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
            onPress={openSettings}
            style={styles.navButton}
            testID="open-settings"
          >
            <Text style={styles.navLabel}>⚙</Text>
          </Pressable>
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

      {/* The tab bar's row: the safe area ends at the native tab bar's top
          edge, so this empty row sits there. On iOS 26 "+" hangs from it
          into the bar, level with the Search tab's circle (the search role
          is drawn as its own circle at the bottom right, and the bar lets
          taps between its items through); before that it floats above. */}
      <View pointerEvents="box-none" style={styles.tabBarRow}>
        <Pressable
          accessibilityLabel="Add"
          accessibilityRole="button"
          onPress={() => host.openQuickAdd(focused)}
          style={[styles.fab, FLOATING_TAB_BAR ? styles.fabInBar : styles.fabAboveBar]}
          testID="add"
        >
          <Text style={styles.fabLabel}>＋</Text>
        </Pressable>
      </View>
      <ConflictBanner />
      <DroppedToast />
      <MutationNoticeToast />
    </SafeAreaView>
  );
}

/**
 * iOS 26 floats the tab bar's items and detaches Search; before that the
 * bar is a solid strip across the screen that would cover "+" and take its
 * taps. `Platform.Version` is a string like "26.0" on iOS.
 */
const FLOATING_TAB_BAR =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;
/**
 * iOS 26's floating tab bar on iPhone: its items are 62pt tall, top-aligned
 * with the bar's frame, and the Search circle keeps a 21pt margin to the
 * screen's right edge (the same on the SE 3, 17e, 17 Pro and 17 Pro Max
 * simulators, iOS 26.5). "+" takes the circle's size and sits 10pt to its
 * left, as drawn.
 */
const TAB_BAR_ITEM = 62;
const SEARCH_RIGHT = 21;
const FAB_GAP = 10;
/** Below iOS 26: a 56pt FAB, 20pt in from the edge and above the bar. */
const FAB = 56;
const FAB_INSET = 20;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fab: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      elevation: 4,
      justifyContent: 'center',
      position: 'absolute',
      shadowColor: '#000000',
      shadowOffset: { height: 4, width: 0 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
    },
    fabAboveBar: {
      borderRadius: FAB / 2,
      bottom: FAB_INSET,
      height: FAB,
      right: FAB_INSET,
      width: FAB,
    },
    fabInBar: {
      borderRadius: TAB_BAR_ITEM / 2,
      height: TAB_BAR_ITEM,
      right: SEARCH_RIGHT + TAB_BAR_ITEM + FAB_GAP,
      top: 0,
      width: TAB_BAR_ITEM,
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
    tabBarRow: {
      height: 0,
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
