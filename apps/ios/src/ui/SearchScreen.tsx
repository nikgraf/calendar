import {
  type SearchState,
  useCalendars,
  useSearch,
  useTaskLists,
  useTimeZones,
  useToday,
} from '@calendar/app-state';
import {
  type EventSearchHit,
  makeColorLookup,
  REPEAT_MARKER,
  SEARCH_WINDOW_YEARS,
  searchEventWhen,
  searchTaskWhen,
  type TaskListInfo,
  type TaskRecord,
  Temporal,
} from '@calendar/core';
import { Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEditorHost } from './EditorHost.tsx';
import { type ThemeColors, useEventTint, useStyles, useTheme } from './theme.ts';
import { MutationNoticeToast } from './Toast.tsx';

/**
 * UIKit's tab bar: 49pt above the bottom safe area on every iPhone, a frame
 * iOS 26's floating bar keeps. The Calendar and Tasks tabs get it as their
 * safe area; a stack inside the search tab does not (measured on iOS 26.5),
 * so the toast's container ends there itself.
 */
const TAB_BAR_HEIGHT = 49;

/** What a search cannot find: the window the backend reads. */
const WINDOW_NOTE = `Events from ${SEARCH_WINDOW_YEARS} years back to ${SEARCH_WINDOW_YEARS} years ahead.`;

type Row =
  | { readonly hit: EventSearchHit; readonly kind: 'event' }
  | { readonly kind: 'task'; readonly task: TaskRecord };

interface Section {
  readonly data: ReadonlyArray<Row>;
  readonly key: 'past' | 'tasks' | 'upcoming';
  readonly title: string;
  readonly total: number;
}

/**
 * The Search tab: the system search field (the tab's stack header, which
 * iOS 26 moves into the tab bar for the search role) over the results —
 * upcoming events, past ones, then tasks, a series once. An event opens
 * its detail sheet, a task its editor; both come from the editor host, so
 * an edit or a delete there updates the list (`useSearch` re-runs on it).
 */
export function SearchScreen() {
  const zones = useTimeZones();
  const timeZone = zones.loaded ? zones.primary : Temporal.Now.timeZoneId();
  const [text, setText] = useState('');
  const search = useSearch(text, timeZone);
  const { colors } = useTheme();
  return (
    <>
      <Stack.SearchBar
        autoCapitalize="none"
        hideWhenScrolling={false}
        onCancelButtonPress={() => setText('')}
        onChangeText={(event) => setText(event.nativeEvent.text)}
        placeholder="Events and tasks"
        textColor={colors.text}
        tintColor={colors.primary}
      />
      <SearchResultsList search={search} text={text} timeZone={timeZone} />
    </>
  );
}

function SearchResultsList({
  search,
  text,
  timeZone,
}: {
  search: SearchState;
  text: string;
  timeZone: string;
}) {
  const styles = useStyles(makeStyles);
  const host = useEditorHost();
  const insets = useSafeAreaInsets();
  const today = useToday(timeZone);
  const calendars = useCalendars();
  const taskLists = useTaskLists();
  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);
  const lists = useMemo(
    () => new Map(taskLists.map((list) => [`${list.accountId}:${list.id}`, list])),
    [taskLists],
  );
  const { results } = search;
  const sections = useMemo((): ReadonlyArray<Section> => {
    if (results === null) {
      return [];
    }
    const all: ReadonlyArray<Section> = [
      {
        data: results.upcoming.hits.map((hit) => ({ hit, kind: 'event' as const })),
        key: 'upcoming',
        title: 'Upcoming',
        total: results.upcoming.total,
      },
      {
        data: results.past.hits.map((hit) => ({ hit, kind: 'event' as const })),
        key: 'past',
        title: 'Past',
        total: results.past.total,
      },
      {
        data: results.tasks.tasks.map((task) => ({ kind: 'task' as const, task })),
        key: 'tasks',
        title: 'Tasks',
        total: results.tasks.total,
      },
    ];
    return all.filter((section) => section.data.length > 0);
  }, [results]);

  const empty =
    text.trim() === '' ? (
      <View style={styles.note} testID="search-hint">
        <Text style={styles.noteText}>
          Search event titles, places, notes and guests, and task titles and notes.
        </Text>
        <Text style={styles.noteSmall}>{WINDOW_NOTE}</Text>
      </View>
    ) : search.failed ? (
      <View style={styles.note} testID="search-failed">
        <Text style={[styles.noteText, styles.failed]}>
          The search did not go through. Change the text to try again.
        </Text>
      </View>
    ) : results === null || search.stale ? (
      <View style={styles.note}>
        <Text style={styles.noteText}>Searching…</Text>
      </View>
    ) : (
      <View style={styles.note} testID="search-empty">
        <Text style={styles.noteText}>Nothing matches “{search.query}”.</Text>
        <Text style={styles.noteSmall}>{WINDOW_NOTE}</Text>
      </View>
    );

  return (
    <View style={styles.screen} testID="search-screen">
      <SectionList<Row, Section>
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(row) =>
          row.kind === 'event'
            ? `event:${row.hit.event.accountId}:${row.hit.event.calendarId}:${row.hit.event.id}`
            : `task:${row.task.accountId}:${row.task.listId}:${row.task.id}`
        }
        ListEmptyComponent={empty}
        renderItem={({ item }) =>
          item.kind === 'event' ? (
            <EventRow
              color={colorOf(item.hit.event)}
              hit={item.hit}
              onPress={() => host.openEvent(item.hit.event)}
              timeZone={timeZone}
              today={today}
            />
          ) : (
            <TaskRow
              list={lists.get(`${item.task.accountId}:${item.task.listId}`)}
              onPress={() => host.editTask(item.task)}
              task={item.task}
              today={today}
            />
          )
        }
        renderSectionFooter={({ section }) =>
          section.total > section.data.length ? (
            <Text style={styles.more} testID="search-more">
              The first {section.data.length} of {section.total}. Add a word to narrow the search.
            </Text>
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <Text
            accessibilityRole="header"
            style={styles.sectionLabel}
            testID={`search-section-${section.key}`}
          >
            {section.title}
          </Text>
        )}
        sections={sections as Array<Section>}
        stickySectionHeadersEnabled={false}
        testID="search-list"
      />
      {/* A failed write from a result's sheet is told here, above the tab bar. */}
      <View
        pointerEvents="box-none"
        style={[
          StyleSheet.absoluteFill,
          styles.toastArea,
          { bottom: insets.bottom + TAB_BAR_HEIGHT },
        ]}
      >
        <MutationNoticeToast />
      </View>
    </View>
  );
}

function EventRow({
  color,
  hit,
  onPress,
  timeZone,
  today,
}: {
  color: string;
  hit: EventSearchHit;
  onPress: () => void;
  timeZone: string;
  today: string;
}) {
  const styles = useStyles(makeStyles);
  const tint = useEventTint(color);
  const { event } = hit;
  const when = searchEventWhen(event, timeZone, today);
  const label = [event.title, when, event.location, hit.repeating ? 'repeats' : undefined]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID="search-event"
    >
      <View style={[styles.dot, { backgroundColor: tint.edge }]} />
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={styles.title}>
          {event.title}
          {hit.repeating ? <Text style={styles.repeat}> {REPEAT_MARKER}</Text> : null}
        </Text>
        <Text numberOfLines={1} style={styles.meta}>
          {when}
        </Text>
        {event.location ? (
          <Text numberOfLines={1} style={styles.meta}>
            {event.location}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function TaskRow({
  list,
  onPress,
  task,
  today,
}: {
  list: TaskListInfo | undefined;
  onPress: () => void;
  task: TaskRecord;
  today: string;
}) {
  const styles = useStyles(makeStyles);
  const done = task.status === 'completed';
  const meta = [searchTaskWhen(task, today), list?.title].filter(Boolean).join(' · ');
  return (
    <Pressable
      accessibilityLabel={[task.title, done ? 'done' : undefined, meta].filter(Boolean).join(', ')}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      testID="search-task"
    >
      <Text style={[styles.checkbox, !done && list?.colorHex ? { color: list.colorHex } : null]}>
        {done ? '☑' : '☐'}
      </Text>
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.title, done && styles.done]}>
          {task.title}
        </Text>
        <Text numberOfLines={1} style={styles.meta}>
          {meta}
        </Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    checkbox: {
      color: colors['text-secondary'],
      fontSize: 18,
      lineHeight: 22,
    },
    content: {
      paddingBottom: 24,
      paddingHorizontal: 16,
    },
    done: {
      color: colors['text-secondary'],
      textDecorationLine: 'line-through',
    },
    dot: {
      borderRadius: 5,
      height: 10,
      marginTop: 6,
      width: 10,
    },
    failed: {
      color: colors.danger,
    },
    meta: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    more: {
      color: colors['text-secondary'],
      fontSize: 12,
      paddingBottom: 8,
      paddingTop: 4,
    },
    note: {
      gap: 8,
      paddingHorizontal: 4,
      paddingVertical: 24,
    },
    noteSmall: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    noteText: {
      color: colors['text-secondary'],
      fontSize: 15,
    },
    repeat: {
      color: colors['text-secondary'],
    },
    row: {
      alignItems: 'flex-start',
      borderRadius: 10,
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 4,
      paddingVertical: 8,
    },
    rowBody: {
      flex: 1,
      gap: 1,
    },
    rowPressed: {
      backgroundColor: colors.fill,
    },
    screen: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    sectionLabel: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.4,
      paddingBottom: 4,
      paddingTop: 16,
      textTransform: 'uppercase',
    },
    title: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '500',
    },
    // The toast stands on this area's bottom edge: the tab bar's top.
    toastArea: {
      justifyContent: 'flex-end',
    },
  });
