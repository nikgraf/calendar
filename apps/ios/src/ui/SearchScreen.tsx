import { isSearchFilterPhrase } from '@calendar/ai';
import {
  type SearchState,
  useCalendars,
  useMarkLesson,
  useModelAvailability,
  useSearch,
  useSearchThread,
  useTaskLists,
  useTimeZones,
  useToday,
} from '@calendar/app-state';
import {
  type EventSearchHit,
  isBlankSearchQuery,
  makeColorLookup,
  REPEAT_MARKER,
  SEARCH_WINDOW_YEARS,
  searchEventWhen,
  searchFilterChips,
  type SearchNames,
  type SearchQuery,
  searchQueryKey,
  searchQuerySentence,
  searchTaskWhen,
  type TaskListInfo,
  type TaskRecord,
  Temporal,
  withoutSearchFilter,
} from '@calendar/core';
import { Stack, useLocalSearchParams } from 'expo-router';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SearchBarCommands } from 'react-native-screens';
import { languageModel } from '../model.ts';
import { useEditorHost } from './EditorHost.tsx';
import { LessonBanner } from './lesson/LessonBanner.tsx';
import { onAppActive } from './QuickAddBar.tsx';
import { SearchFilterChips } from './SearchFilterChips.tsx';
import { SearchFiltersSheet } from './SearchFiltersSheet.tsx';
import { TaskCheck } from './TaskCheck.tsx';
import { ThreadTurnList } from './ThreadTurnList.tsx';
import { type ThemeColors, useEventTint, useStyles, useTheme } from './theme.ts';
import { MutationNoticeToast } from './Toast.tsx';

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
  const calendars = useCalendars();
  const taskLists = useTaskLists();
  const thread = useSearchThread({ calendars, model: languageModel, taskLists, timeZone });
  const search = useSearch(thread.state.query, timeZone);
  const { status } = useModelAvailability(languageModel, onAppActive);
  const modelReady = status === 'ready';
  const { colors } = useTheme();
  const searchBar = useRef<SearchBarCommands>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const lesson = useSearchLesson(thread, status, (text) => searchBar.current?.setText(text));

  // A turn, an Undo or Clear: the native field takes the thread's text
  // over (it is not controlled; typing never moves the version).
  const { text, version } = thread.state;
  useEffect(() => {
    if (version > 0) {
      searchBar.current?.setText(text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a moved version rewrites the field
  }, [version]);

  /** The sentence in the field, read into filters: a turn. */
  const ask = async () => {
    if (!modelReady || text.trim() === '' || thread.busy) {
      return;
    }
    setThreadError(null);
    setThreadError((await thread.phrase()) ?? null);
  };

  return (
    <>
      <Stack.SearchBar
        autoCapitalize="none"
        hideWhenScrolling={false}
        onCancelButtonPress={() => {
          setThreadError(null);
          thread.clear();
        }}
        onChangeText={(event) => {
          setThreadError(null);
          thread.setText(event.nativeEvent.text);
        }}
        // The keyboard's Search key reads a sentence with a filter in it;
        // plain words are searched as typed already.
        onSearchButtonPress={() => {
          if (modelReady && isSearchFilterPhrase(text)) {
            void ask();
          }
        }}
        placeholder="Events and tasks"
        ref={searchBar}
        textColor={colors.text}
        tintColor={colors.primary}
      />
      <SearchResultsList
        header={
          <SearchThreadHeader
            banner={
              lesson.open ? (
                <LessonBanner
                  id="search"
                  note={
                    modelReady
                      ? undefined
                      : 'Reading a sentence needs Apple Intelligence, which is not ready on this iPhone — plain words still search.'
                  }
                  onSkip={lesson.skip}
                />
              ) : null
            }
            error={threadError}
            onClear={() => {
              setThreadError(null);
              thread.clear();
            }}
            onOpenFilters={() => setFiltersOpen(true)}
            onUndo={() => {
              setThreadError(null);
              thread.undo();
            }}
            thread={thread}
          />
        }
        modelReady={modelReady}
        names={thread.names}
        query={thread.state.query}
        search={search}
        timeZone={timeZone}
      />
      {filtersOpen ? (
        <SearchFiltersSheet
          calendars={calendars}
          onChange={thread.setQuery}
          onClose={() => setFiltersOpen(false)}
          query={thread.state.query}
          taskLists={taskLists}
          timeZone={timeZone}
          today={thread.names.today}
        />
      ) : null}
    </>
  );
}

/**
 * The Search with AI lesson, opened from the Getting started card with a
 * sentence (`phrase`, `lesson` and a fresh `at` per opening, as route
 * params): the sentence goes into the field and, with the model ready,
 * is read into chips. Once that settled, the person's first change (a
 * sentence, a chip, Undo, typing) ticks the lesson as done; Skip ticks it
 * as skipped.
 */
const useSearchLesson = (
  thread: ReturnType<typeof useSearchThread>,
  status: string | null,
  /** The native field is not controlled: the sentence is put into it directly. */
  showText: (text: string) => void,
): { readonly open: boolean; readonly skip: () => void } => {
  const params = useLocalSearchParams<{ at?: string; lesson?: string; phrase?: string }>();
  const markLesson = useMarkLesson();
  const [open, setOpen] = useState(false);
  const taken = useRef<string | undefined>(undefined);
  const baseline = useRef<string | null>(null);
  const threadKey = `${String(thread.state.version)}|${searchQueryKey(thread.state.query)}`;
  const { phrase: sentence } = params;
  useEffect(() => {
    if (params.lesson !== '1' || !sentence || status === null || taken.current === params.at) {
      return;
    }
    taken.current = params.at;
    thread.clear();
    thread.setText(sentence);
    showText(sentence);
    if (status === 'ready') {
      void thread.phrase(sentence);
    }
    baseline.current = null;
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one opening per `at`
  }, [params.at, params.lesson, sentence, status]);
  useEffect(() => {
    if (!open || thread.busy) {
      return;
    }
    if (baseline.current === null) {
      baseline.current = threadKey;
    } else if (baseline.current !== threadKey) {
      setOpen(false);
      void markLesson('search', 'done');
    }
  }, [markLesson, open, thread.busy, threadKey]);
  return {
    open,
    skip: () => {
      setOpen(false);
      void markLesson('search', 'skipped');
    },
  };
};

/** The chips ("Filters" a spinner while a sentence is read), the turns newest first with Undo, and why a sentence was not read. */
function SearchThreadHeader({
  banner,
  error,
  onClear,
  onOpenFilters,
  onUndo,
  thread,
}: {
  /** The Search lesson's frame, above the chips while it runs. */
  banner: ReactElement | null;
  error: string | null;
  onClear: () => void;
  onOpenFilters: () => void;
  onUndo: () => void;
  thread: ReturnType<typeof useSearchThread>;
}) {
  const styles = useStyles(makeStyles);
  const { query, turns } = thread.state;
  return (
    <View style={styles.threadHeader}>
      {banner}
      <SearchFilterChips
        busy={thread.busy}
        chips={searchFilterChips(query, thread.names)}
        flash={thread.flash}
        onClear={onClear}
        onOpenFilters={onOpenFilters}
        onRemove={(chip) => thread.setQuery(withoutSearchFilter(query, chip.field, chip.key))}
        showClear={!isBlankSearchQuery(query) || turns.length > 0}
      />
      <ThreadTurnList
        onUndo={onUndo}
        testIDPrefix="search"
        turns={turns}
        undoDisabled={thread.busy}
      />
      {error ? (
        <Text style={[styles.meta, styles.failed]} testID="search-thread-status">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function SearchResultsList({
  header,
  modelReady,
  names,
  query,
  search,
  timeZone,
}: {
  header: ReactElement;
  modelReady: boolean;
  names: SearchNames;
  query: SearchQuery;
  search: SearchState;
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

  const empty = isBlankSearchQuery(query) ? (
    <View style={styles.note} testID="search-hint">
      <Text style={styles.noteText}>
        Search event titles, places, notes and guests, and task titles and notes.
      </Text>
      {modelReady ? (
        <Text style={styles.noteSmall}>
          Or say what you want — “lunch with Anna last month”, “only tasks” — and tap Search.
        </Text>
      ) : null}
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
      <Text style={styles.noteText}>
        Nothing matches {searchQuerySentence(search.query, names)}.
      </Text>
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
        ListHeaderComponent={header}
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
      {/* A failed write from a result's sheet is told here, above the tab bar:
          the screen runs under the bar, and its bottom inset already holds
          the bar (83 pt on an iPhone 17 Pro, iOS 26.5), so the area ends at
          the bar's top edge. */}
      <View
        pointerEvents="box-none"
        style={[StyleSheet.absoluteFill, styles.toastArea, { bottom: insets.bottom }]}
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
      <View style={styles.check}>
        <TaskCheck checked={done} listColor={list?.colorHex} size="agenda" />
      </View>
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
    // Centered on the title's first line.
    check: {
      paddingTop: 1,
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
    threadHeader: {
      gap: 6,
      paddingBottom: 4,
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
