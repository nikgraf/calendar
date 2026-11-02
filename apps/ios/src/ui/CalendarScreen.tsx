import {
  draftOccurrences,
  useGuardedMutations,
  useBackendInvalidations,
  useCalendarNavigation,
  useCalendars,
  useDraftPreviews,
  useEventsInRangeStable,
  useListColorLookup,
  useOnDraftReveal,
  useOverdueTasksStable,
  useRequestDraftFocus,
  useSetupNeeded,
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
import { useEffect, useMemo, useRef } from 'react';
import { MenuView } from '@expo/ui/community/menu';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppState, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { kickSync, runLocalNotifications, startSync, subscribeInvalidations } from '../backend.ts';
import { registerBackgroundRefresh } from '../backgroundTask.ts';
import { useOnboardingEnabled } from '../onboarding.ts';
import { setSetupPhase } from '../settingsCodeInbox.ts';
import { AccountButton } from './AccountButton.tsx';
import { ADD_BUTTON_CLEARANCE, AddButton } from './AddButton.tsx';
import { AgendaView } from './AgendaView.tsx';
import { DayTimeline } from './DayTimeline.tsx';
import { useEditorHost } from './EditorHost.tsx';
import { GettingStartedCard } from './GettingStartedCard.tsx';
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
  useFirstRun();
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

/**
 * The first run, decided once per launch from the first read of the
 * accounts and the onboarding state: nothing connected and the setup
 * never ran puts the setup modal up over the calendar. Decided then and
 * only then — a Skip is not met again on the next read, and removing the
 * last account later (in Settings, on an install from before the setup
 * existed) does not bring it up mid-session. Off under
 * EXPO_PUBLIC_CALENDAR_ONBOARDING=off.
 */
const useFirstRun = () => {
  const router = useRouter();
  const enabled = useOnboardingEnabled();
  const due = useSetupNeeded();
  const decided = useRef(false);
  useEffect(() => {
    // No setup on the way: a settings code waiting in the inbox (opened
    // from the Camera app at launch) goes to Settings › Read Code now.
    if (!enabled) {
      setSetupPhase('closed', router);
      return;
    }
    if (due === null || decided.current) {
      return;
    }
    decided.current = true;
    if (due) {
      setSetupPhase('opening');
      router.push('/setup');
    } else {
      setSetupPhase('closed', router);
    }
  }, [due, enabled, router]);
};

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
    goToDay,
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

  // The open editor's drafts, drawn dashed in the timeline, the lane and
  // the month grid (the free slots beside the focused one fainter); the
  // editor asks for its focused draft's day, and a tap on a draft
  // focuses it there (the draft atoms, shared with the desktop).
  const draftPreviews = useDraftPreviews();
  const drafts = useMemo(
    () => draftOccurrences(draftPreviews, range.startUtc, range.endUtc, timeZone),
    [draftPreviews, range.startUtc, range.endUtc, timeZone],
  );
  const requestDraftFocus = useRequestDraftFocus();
  useOnDraftReveal(goToDay);
  // The focused timed draft's start, for the grid to scroll to — read off
  // the draft itself, not an occurrence in the loaded range: a repeating
  // draft's first loaded occurrence moves as the calendar pages.
  const focusedDraft = draftPreviews.find(
    (draft) => draft.focused && !draft.isAllDay && draft.candidate === undefined,
  );
  const revealMinute =
    focusedDraft === undefined
      ? undefined
      : Number(focusedDraft.startTime.slice(0, 2)) * 60 +
        Number(focusedDraft.startTime.slice(3, 5));
  const revealKey =
    focusedDraft === undefined
      ? undefined
      : `${focusedDraft.id}|${focusedDraft.date}|${focusedDraft.startTime}`;

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

      {/* Getting started, between the header and the view, until it leaves. */}
      <GettingStartedCard timeZone={timeZone} />

      {view === 'month' ? (
        <MonthGrid
          birthdays={birthdays}
          colorOf={colorOf}
          drafts={drafts}
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
            drafts={drafts}
            events={events}
            isEventReadOnly={isEventReadOnly}
            isTaskReadOnly={isTaskReadOnly}
            listColorOf={listColorOf}
            onBirthdayPress={host.openBirthday}
            onCreateSlot={(date, times) =>
              host.editEvent({ initialDate: date, initialTimes: times })
            }
            onDraftPress={requestDraftFocus}
            onEventPress={host.openEvent}
            onFoldPress={host.openTaskFold}
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
            revealKey={revealKey}
            revealMinute={revealMinute}
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
    // No margin: SDK 57's menu sized itself to the trigger and dropped the
    // trigger's margin, and @expo/ui 58 takes it off the trigger's own width
    // instead, which cut "▾" short. The gap to "‹" is that button's padding.
    viewButton: {
      backgroundColor: colors.fill,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    viewButtonLabel: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
    },
  });
