import { isSearchFilterPhrase } from '@calendar/ai';
import { type SearchState, type useSearchThread, useToday } from '@calendar/app-state';
import {
  type CalendarInfo,
  type EventRecord,
  type EventSearchHit,
  hasSearchFilters,
  isBlankSearchQuery,
  makeColorLookup,
  SEARCH_WINDOW_YEARS,
  searchEventWhen,
  searchQuerySentence,
  searchTaskWhen,
  type TaskListInfo,
  type TaskRecord,
} from '@calendar/core';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { IconButton } from '../../ui/IconButton.tsx';
import { RepeatIcon, SearchIcon, SparkleIcon, SpinnerIcon, XIcon } from '../../ui/icons.tsx';
import { TaskCheckMark } from '../TaskCheck.tsx';
import { ThreadTurns } from '../ThreadTurns.tsx';
import { useTint } from '../tint.ts';
import { SearchFilterChips } from './SearchFilterChips.tsx';

/** What a search cannot find: the window the backend reads. */
const WINDOW_NOTE = `Events from ${SEARCH_WINDOW_YEARS} years back to ${SEARCH_WINDOW_YEARS} years ahead.`;

/** The result buttons, in list order: the arrow keys walk them. */
const RESULT_SELECTOR = '[data-search-result]';

const ROW_CLASS =
  'flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left outline-none hover:bg-fill focus-visible:bg-fill focus-visible:ring-2 focus-visible:ring-focus';

/** One group of results under its heading; a cut-short group says so. */
function ResultGroup({
  id,
  label,
  rows,
  total,
}: {
  id: string;
  label: string;
  rows: ReadonlyArray<ReactNode>;
  total: number;
}) {
  return rows.length === 0 ? null : (
    <section className="mb-2" data-testid={`search-group-${id}`}>
      <h3 className="px-2 pb-0.5 text-[11px] font-semibold tracking-wide text-ink-secondary uppercase">
        {label}
      </h3>
      <ul>{rows}</ul>
      {total > rows.length ? (
        <p className="px-2 pt-1 text-[11px] text-ink-secondary" data-testid="search-more">
          The first {rows.length} of {total}. Add a word to narrow the search.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The side panel's search: a field at the top, the filters as chips under
 * it, the turns a sentence made, and what matches below — upcoming
 * events, past ones, then tasks, a series once. An event opens its
 * inspector (with a way back here), a task its editor. The app owns the
 * thread and the search (`useSearchThread`, `useSearch`), so going back
 * from a result finds the same query, chips and results, and the list
 * where it was scrolled.
 *
 * Enter opens the top result of plain words, as Spotlight does; words
 * with a filter in them ("lunch with Anna last month" — the router is
 * code, `isSearchFilterPhrase`) are read into filters by the model when
 * it is ready. ⌘↩ and the ✦ button always read them.
 */
export function SearchPanel({
  calendars,
  focusSignal,
  modelReady,
  onClose,
  onOpenEvent,
  onOpenTask,
  readScrollTop,
  saveScrollTop,
  search,
  selectText,
  taskLists,
  thread,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  /** Changes each time ⌘F or the toolbar asks for the field, which then takes focus. */
  focusSignal: number;
  /** A model can read a sentence into filters. */
  modelReady: boolean;
  onClose: () => void;
  onOpenEvent: (event: EventRecord) => void;
  onOpenTask: (task: TaskRecord) => void;
  /** Where the list was scrolled, kept by the app across a visit to a result. */
  readScrollTop: () => number;
  saveScrollTop: (top: number) => void;
  search: SearchState;
  /** Opened by ⌘F or the toolbar: the text is selected, so typing replaces it. */
  selectText: boolean;
  taskLists: ReadonlyArray<TaskListInfo>;
  thread: ReturnType<typeof useSearchThread>;
  timeZone: string;
}) {
  const { text } = thread.state;
  // Back from a result, the turns stand where they were; only new ones ease in.
  const [restingTurns] = useState(() => new Set(thread.state.turns.map((turn) => turn.id)));
  const blank = isBlankSearchQuery(thread.state.query);
  const [threadError, setThreadError] = useState<string | null>(null);
  const asks = modelReady && isSearchFilterPhrase(text);
  /** The sentence in the field, read into filters: a turn. */
  const ask = async () => {
    if (!modelReady || text.trim() === '' || thread.busy) {
      return;
    }
    setThreadError(null);
    setThreadError((await thread.phrase()) ?? null);
  };
  const today = useToday(timeZone);
  const tint = useTint();
  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);
  const lists = useMemo(
    () => new Map(taskLists.map((list) => [`${list.accountId}:${list.id}`, list])),
    [taskLists],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // On open and on every ⌘F; back from a result, the caret goes to the end.
  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    if (selectText) {
      input?.select();
    } else {
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }, [focusSignal, selectText]);

  // Back from a result: the list where it was. A new query starts at the top.
  useLayoutEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = readScrollTop();
    }
  }, [readScrollTop]);
  const listedQuery = useRef(search.key);
  useLayoutEffect(() => {
    if (listedQuery.current !== search.key) {
      listedQuery.current = search.key;
      saveScrollTop(0);
      if (listRef.current) {
        listRef.current.scrollTop = 0;
      }
    }
  }, [saveScrollTop, search.key]);

  // Enter pressed while the rows still answer an earlier text (the
  // debounce, the lookup) opens the top result of what was typed once its
  // results are in; typing on cancels it.
  const enterWaits = useRef(false);
  useEffect(() => {
    if (enterWaits.current && !search.stale) {
      enterWaits.current = false;
      listRef.current?.querySelector<HTMLElement>(RESULT_SELECTOR)?.click();
    }
  }, [search.results, search.stale]);

  /** ArrowDown and ArrowUp walk from the field through the results and back. */
  const onArrow = (key: KeyboardEvent) => {
    if (key.key !== 'ArrowDown' && key.key !== 'ArrowUp') {
      return;
    }
    key.preventDefault();
    const results = [...(listRef.current?.querySelectorAll<HTMLElement>(RESULT_SELECTOR) ?? [])];
    const next =
      results.indexOf(document.activeElement as HTMLElement) + (key.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) {
      inputRef.current?.focus();
    } else {
      results[Math.min(next, results.length - 1)]?.focus();
    }
  };

  const eventRow = (hit: EventSearchHit) => {
    const { event } = hit;
    return (
      <li key={`${event.accountId}:${event.calendarId}:${event.id}`}>
        <button
          className={ROW_CLASS}
          data-search-result
          data-testid="search-event"
          onClick={() => onOpenEvent(event)}
          type="button"
        >
          <span
            aria-hidden
            className="mt-1.5 size-2 shrink-0 rounded-full"
            data-color={colorOf(event)}
            style={{ backgroundColor: tint(colorOf(event)).edge }}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1">
              <span className="truncate text-sm font-medium" data-testid="search-title">
                {event.title}
              </span>
              {hit.repeating ? (
                <span className="shrink-0 text-ink-secondary" data-testid="search-repeats">
                  <RepeatIcon size={12} />
                  <span className="sr-only">, repeats</span>
                </span>
              ) : null}
            </span>
            <span className="block truncate text-xs text-ink-secondary" data-testid="search-when">
              {searchEventWhen(event, timeZone, today)}
            </span>
            {event.location ? (
              <span className="block truncate text-xs text-ink-secondary">{event.location}</span>
            ) : null}
          </span>
        </button>
      </li>
    );
  };

  const taskRow = (task: TaskRecord) => {
    const done = task.status === 'completed';
    const list = lists.get(`${task.accountId}:${task.listId}`);
    return (
      <li key={`${task.accountId}:${task.listId}:${task.id}`}>
        <button
          className={ROW_CLASS}
          data-search-result
          data-testid="search-task"
          onClick={() => onOpenTask(task)}
          type="button"
        >
          {/* Wrapped, so the row's hover does not preview a tick: the row opens the task. */}
          <span className="mt-px shrink-0">
            <TaskCheckMark checked={done} listColor={list?.colorHex} size="row" />
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-sm ${done ? 'text-ink-secondary line-through' : ''}`}
              data-testid="search-title"
            >
              {task.title}
            </span>
            {done ? <span className="sr-only">Done.</span> : null}
            <span className="block truncate text-xs text-ink-secondary" data-testid="search-when">
              {[searchTaskWhen(task, today), list?.title].filter(Boolean).join(' · ')}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const { results } = search;
  const found =
    results === null ? 0 : results.upcoming.total + results.past.total + results.tasks.total;
  // Read out once the latest query's results are in.
  // A sentence being read shows as the ✦ turning into a spinner, so
  // nothing under the field moves; a screen reader hears it here.
  const status = thread.busy
    ? 'Reading the filters…'
    : blank || results === null || search.stale
      ? ''
      : found === 0
        ? 'No results'
        : `${String(found)} ${found === 1 ? 'result' : 'results'}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="search-panel">
      <div className="flex items-start gap-2 px-3 pt-3 pb-2">
        {/* One card: the field, the turns its sentences made, and why the
            last one was not read — hung under it as part of it. */}
        <div className="min-w-0 flex-1 overflow-hidden rounded-control bg-fill has-[input:focus]:ring-2 has-[input:focus]:ring-focus">
          <div className="relative flex items-center">
            <SearchIcon
              className="pointer-events-none absolute left-2.5 text-ink-secondary"
              size={14}
            />
            <input
              aria-label="Search events and tasks"
              autoComplete="off"
              className="w-full bg-transparent py-1.5 pr-3 pl-8 text-sm text-ink outline-none placeholder:text-ink-secondary"
              data-routes={asks ? 'ask' : 'open'}
              data-testid="search-input"
              onChange={(event) => {
                enterWaits.current = false;
                setThreadError(null);
                thread.setText(event.target.value);
              }}
              onKeyDown={(key) => {
                // Enter opens the top result, as Spotlight does (not while an
                // input method is still composing) — of the text typed, not
                // of the rows an earlier text left on screen. Words with a
                // filter in them, or ⌘↩, go to the model instead.
                if (key.key === 'Enter' && !key.nativeEvent.isComposing) {
                  key.preventDefault();
                  if (key.metaKey || asks) {
                    enterWaits.current = false;
                    void ask();
                  } else if (search.stale) {
                    enterWaits.current = true;
                  } else {
                    listRef.current?.querySelector<HTMLElement>(RESULT_SELECTOR)?.click();
                  }
                } else if (search.stale && (key.key === 'ArrowDown' || key.key === 'ArrowUp')) {
                  // Nor do the arrows walk into those rows.
                  key.preventDefault();
                } else {
                  onArrow(key);
                }
              }}
              placeholder="Search events and tasks"
              ref={inputRef}
              spellCheck={false}
              type="text"
              value={text}
            />
          </div>
          {thread.state.turns.length > 0 ? (
            <ThreadTurns
              // The header does not scroll: an opened list scrolls in itself.
              listClassName="max-h-48 overflow-y-auto"
              onUndo={() => {
                setThreadError(null);
                thread.undo();
              }}
              resting={restingTurns}
              testIdPrefix="search"
              turns={thread.state.turns}
              undoDisabled={thread.busy}
            />
          ) : null}
          {threadError ? (
            <p
              className="border-t border-ink/10 py-1.5 pr-1 pl-2.5 text-xs text-danger"
              data-testid="search-thread-status"
            >
              {threadError}
            </p>
          ) : null}
        </div>
        <div className="flex h-8 shrink-0 items-center gap-2">
          {modelReady && text.trim() !== '' ? (
            // While a sentence is read the ✦ turns into a spinner in its place
            // (`ask` ignores a press then; not `disabled`, which would fade it).
            <IconButton
              aria-busy={thread.busy}
              className={asks || thread.busy ? 'text-primary' : ''}
              data-testid="search-ask"
              label={thread.busy ? 'Reading the filters…' : 'Read filters from the words (⌘↩)'}
              onClick={() => void ask()}
              size="sm"
            >
              {thread.busy ? (
                <SpinnerIcon size={14} strokeWidth={2.25} />
              ) : (
                <SparkleIcon size={14} />
              )}
            </IconButton>
          ) : null}
          <IconButton data-testid="search-close" label="Close search" onClick={onClose} size="sm">
            <XIcon size={14} />
          </IconButton>
        </div>
        <p aria-live="polite" className="sr-only">
          {status}
        </p>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-2">
        <SearchFilterChips
          calendars={calendars}
          flash={thread.flash}
          names={thread.names}
          onChange={thread.setQuery}
          onClear={() => {
            setThreadError(null);
            thread.clear();
            inputRef.current?.focus();
          }}
          query={thread.state.query}
          showClear={
            !blank || hasSearchFilters(thread.state.query) || thread.state.turns.length > 0
          }
          taskLists={taskLists}
        />
      </div>
      <div
        aria-busy={search.stale}
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-3"
        data-testid="search-results"
        onKeyDown={onArrow}
        onScroll={(event) => saveScrollTop(event.currentTarget.scrollTop)}
        ref={listRef}
      >
        {blank ? (
          <div className="px-3 py-4 text-sm text-ink-secondary" data-testid="search-hint">
            <p>Search event titles, places, notes and guests, and task titles and notes.</p>
            {modelReady ? (
              <p className="mt-2 text-xs">
                Or say what you want: “lunch with Anna last month”, “only tasks”, then Enter.
              </p>
            ) : null}
            <p className="mt-2 text-xs">{WINDOW_NOTE}</p>
          </div>
        ) : search.failed ? (
          <p className="px-3 py-4 text-sm text-danger" data-testid="search-failed">
            The search did not go through. Change the text to try again.
          </p>
        ) : results === null || (found === 0 && search.stale) ? (
          <p className="px-3 py-4 text-sm text-ink-secondary">Searching…</p>
        ) : found === 0 ? (
          <div className="px-3 py-4 text-sm text-ink-secondary" data-testid="search-empty">
            <p>Nothing matches {searchQuerySentence(search.query, thread.names)}.</p>
            <p className="mt-2 text-xs">{WINDOW_NOTE}</p>
          </div>
        ) : (
          <>
            <ResultGroup
              id="upcoming"
              label="Upcoming"
              rows={results.upcoming.hits.map(eventRow)}
              total={results.upcoming.total}
            />
            <ResultGroup
              id="past"
              label="Past"
              rows={results.past.hits.map(eventRow)}
              total={results.past.total}
            />
            <ResultGroup
              id="tasks"
              label="Tasks"
              rows={results.tasks.tasks.map(taskRow)}
              total={results.tasks.total}
            />
          </>
        )}
      </div>
    </div>
  );
}
