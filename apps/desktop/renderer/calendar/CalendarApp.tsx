import {
  type BirthdayOccurrence,
  eventIdentity,
  type EventRecord,
  findSameEvent,
  type ItemKind,
  type NotificationTarget,
  PAN_BUFFER_DAYS,
  parseNotificationTarget,
  type TaskRecord,
  Temporal,
  toZonedDateTime,
  utcMsToPlainDate,
} from '@calendar/core';
import {
  defaultTodoKind,
  eventStartDay,
  findCurrentEvent,
  findNotificationEvent,
  useAccounts,
  useCalendarNavigation,
  useCalendars,
  useCaptureModel,
  useEventReadOnlyLookup,
  useEventsInRangeStable,
  useGuardedMutations,
  useListColorLookup,
  useOverdueTasksStable,
  useSearch,
  useTaskLists,
  useBirthdaysInRangeStable,
  useTaskReadOnlyLookup,
  useTasksInRangeStable,
  useTimeZones,
  useToday,
  useUpdateViewPreferences,
  useViewPreferences,
  type EventEditorPrefill,
} from '@calendar/app-state';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { backend } from '../backend.ts';
import { desktopTextRecognizer } from '../ai/desktopTextRecognizer.ts';
import { Dialog, isDialogOpen } from '../Dialog.tsx';
import { NoticeStack } from '../NoticeStack.tsx';
import { useMediaQuery } from '../useMediaQuery.ts';
import { BirthdayDetail } from './BirthdayDetail.tsx';
import { CaptureDialog } from './CaptureDialog.tsx';
import { captureSourceOf, isCapturable, readPaste } from './captureClipboard.ts';
import { makeColorLookup } from './colors.ts';
import { MonthView } from './MonthView.tsx';
import { DragGhost } from './panel/DragGhost.tsx';
import { EditorPanel, type EditorSeed } from './panel/EditorPanel.tsx';
import { EventInspector } from './panel/EventInspector.tsx';
import { SearchPanel } from './panel/SearchPanel.tsx';
import { TodayRail } from './panel/TodayRail.tsx';
import { Sidebar } from './sidebar/Sidebar.tsx';
import { Toolbar } from './Toolbar.tsx';
import { useEventDrag } from './useEventDrag.ts';
import { HOUR_HEIGHT, useWeekStrip, WeekView } from './WeekView.tsx';

type MainView = 'day' | 'month' | 'week';

/**
 * What the side panel shows: the Today rail at rest, search (⌘F), an
 * event's inspector after a click on the grid or a search result, or an
 * inline editor (Edit, a slot, New, a task chip or result). A panel
 * opened from a search result goes back to the results when it closes
 * (`fromSearch`). The inspector's `event` is kept current (see
 * CalendarBody); an editor's seed is the draft's start and stays put.
 */
type PanelState =
  | { readonly kind: 'rail' }
  | {
      readonly kind: 'search';
      /** Opened by ⌘F or the toolbar: the field's text is selected (typing replaces it). */
      readonly selectText: boolean;
    }
  | {
      readonly event: EventRecord;
      readonly fromSearch?: boolean | undefined;
      readonly kind: 'inspector';
    }
  | {
      /** The capture row this editor came from, so a save can mark it added. */
      readonly captureRow?: string | undefined;
      readonly fromSearch?: boolean | undefined;
      readonly kind: 'editEvent';
      /** Convert from the inspector: the to-do kind to switch to on open. */
      readonly mode?: ItemKind | undefined;
      /** Distinct per opening: a second slot click must not reuse the first draft. */
      readonly opening: number;
      readonly seed: EditorSeed;
    }
  | {
      readonly fromSearch?: boolean | undefined;
      readonly kind: 'editTask';
      readonly opening: number;
      readonly task: TaskRecord;
    };

const RAIL: PanelState = { kind: 'rail' };
/** Back from a search result: the same results, the text left as it was. */
const RESULTS: PanelState = { kind: 'search', selectText: false };

/** Whether the panel is search or something opened from its results. */
const isSearching = (panel: PanelState): boolean =>
  panel.kind === 'search' || (panel.kind !== 'rail' && panel.fromSearch === true);

/** Where closing a panel leads: from a search result back to the results, else the rail. */
const backFrom = (panel: PanelState): PanelState =>
  panel.kind !== 'search' && isSearching(panel) ? RESULTS : RAIL;

let openings = 0;
/** A fresh identity for an editor opening; the panel is keyed by it. */
const nextOpening = (): number => {
  openings += 1;
  return openings;
};

/** Keys and pastes inside a field belong to the field, not the calendar. */
const isTyping = (target: EventTarget | null) => {
  const element = target as { isContentEditable?: boolean; tagName?: string } | null;
  return Boolean(
    element?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(element?.tagName ?? ''),
  );
};

/** The desktop draws day, week and month; an iOS-only view falls back to the week. */
const mainViewOf = (view: string | undefined): MainView =>
  view === 'day' || view === 'month' ? view : 'week';

/**
 * Waits for the device-local time zones before drawing anything: a first
 * frame in the device zone followed by a re-layout in the primary zone
 * would, near midnight with a distant primary, also seed the focused day
 * and "today" with the wrong date. The view preferences resolve with the
 * same initial atoms, so the gate never shows — and the last view opens
 * without a flash of the default.
 */
export function CalendarApp() {
  const zones = useTimeZones();
  const prefs = useViewPreferences();
  if (!zones.loaded || prefs === null) {
    return <div className="flex h-screen bg-canvas" />;
  }
  return (
    <CalendarBody
      initialView={mainViewOf(prefs.lastView)}
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
  initialView: MainView;
  primary: string;
  secondary: ReadonlyArray<string>;
}) {
  const {
    days,
    endSlide,
    focused,
    goToDay,
    goToday,
    panByDays,
    range,
    scrollToDay,
    setFocused,
    slide,
    step,
    switchView,
    title,
    view,
  } = useCalendarNavigation({
    dayBuffer: PAN_BUFFER_DAYS,
    initialView,
    timeZone,
    titleStyle: 'long',
  });
  const prefs = useViewPreferences();
  const updatePrefs = useUpdateViewPreferences();
  const sidebarCollapsed = prefs?.sidebarCollapsed ?? false;
  // The Today rail yields on a narrow window (a 1024px laptop window with
  // the sidebar open leaves the week ~60px a column with it) unless asked
  // for; the inspector and the editors always get the panel.
  const wide = useMediaQuery('(min-width: 1180px)');
  const [railOpen, setRailOpen] = useState<boolean | null>(null);
  const railShown = railOpen ?? wide;
  const changeView = (next: MainView) => {
    switchView(next);
    updatePrefs({ lastView: next });
  };

  const [panel, setPanel] = useState<PanelState>(RAIL);
  const searching = isSearching(panel);
  // Search lives here, not in its panel: it stays current while a result
  // is open (an edit or a delete made there updates it) and is there at
  // once on the way back. Closed, it searches nothing; the text is kept
  // for the next ⌘F.
  const [searchText, setSearchText] = useState('');
  const search = useSearch(searching ? searchText : '', timeZone);
  const [searchFocus, setSearchFocus] = useState(0);
  const searchScroll = useRef(0);
  const readSearchScroll = useCallback(() => searchScroll.current, []);
  const saveSearchScroll = useCallback((top: number) => {
    searchScroll.current = top;
  }, []);
  const [viewBirthday, setViewBirthday] = useState<BirthdayOccurrence | null>(null);
  // ⌘K: bumped per press, so an open new-item editor refocuses its field.
  const [quickAddFocus, setQuickAddFocus] = useState(0);
  const editing = panel.kind === 'editEvent' || panel.kind === 'editTask';
  const openEditor = (seed: EditorSeed) =>
    setPanel({ kind: 'editEvent', opening: nextOpening(), seed });
  /** A new item on the focused day: "+ New", ⌘N, and ⌘K into its quick-add field. */
  const openNew = useCallback(
    () =>
      setPanel({
        kind: 'editEvent',
        opening: nextOpening(),
        seed: { initialDate: focused, initialHour: 9 },
      }),
    [focused],
  );

  // A parsed prefill (quick-add, or a single captured event) opens the
  // editor on its day: the user reviews it before anything is written.
  const openPrefill = (prefill: EventEditorPrefill, captureRow?: string) => {
    setPanel({
      captureRow,
      kind: 'editEvent',
      opening: nextOpening(),
      seed: { initialDate: Temporal.PlainDate.from(prefill.date), prefill },
    });
  };
  const capture = useCaptureModel({
    model: desktopLanguageModel,
    onSingle: openPrefill,
    recognizer: desktopTextRecognizer,
    timeZone,
  });

  // A clicked event reminder: the occurrence's day, with it in the
  // inspector. An event deleted since opens nothing. A capture under way
  // is dismissed, as on iOS: its dialog would cover the event, and a parse
  // still running would replace the inspector with its editor.
  const openNotificationTarget = useEffectEvent((target: NotificationTarget) => {
    void findNotificationEvent(backend, target).then((event) => {
      if (event) {
        capture.dismiss();
        goToDay(eventStartDay(event, timeZone));
        setPanel({ event, kind: 'inspector' });
      }
    });
  });
  useEffect(
    () =>
      window.calendarBridge.onNotificationOpen((value) => {
        const target = parseNotificationTarget(value);
        if (target) {
          openNotificationTarget(target);
        }
      }),
    [],
  );

  const events = useEventsInRangeStable(range.startUtc, range.endUtc);
  // The inspector follows its event: it shows the row the grid has now,
  // not the one that was clicked — a refresh landing after it opened (the
  // write it was opened right after, a sync pass, an agent's edit) shows
  // there, and Edit and Convert start from it. While the grid has no such
  // row (another week, a range still loading, a deleted event) the last
  // version seen stays up, and the backend is asked where the event is
  // now: an edit made since shows, and an event that is gone closes the
  // inspector — back to the results when it was opened from one, as its
  // own Delete does.
  const inspected = panel.kind === 'inspector' ? findSameEvent(events, panel.event) : undefined;
  if (panel.kind === 'inspector' && inspected !== undefined && inspected !== panel.event) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setPanel({ ...panel, event: inspected });
  }
  const unlisted =
    panel.kind === 'inspector' && inspected === undefined ? eventIdentity(panel.event) : undefined;
  const lookUpInspected = useEffectEvent((isCurrent: () => boolean) => {
    if (panel.kind !== 'inspector') {
      return;
    }
    const identity = eventIdentity(panel.event);
    void findCurrentEvent(backend, panel.event).then(
      (found) => {
        if (!isCurrent()) {
          return;
        }
        setPanel((current) =>
          current.kind !== 'inspector' || eventIdentity(current.event) !== identity
            ? current
            : found === null
              ? backFrom(current)
              : { ...current, event: found },
        );
      },
      // The backend could not say: the last version seen stays up.
      () => {},
    );
  });
  useEffect(() => {
    if (unlisted === undefined) {
      return;
    }
    // Asked again with every list the grid gets while the row is missing;
    // an answer overtaken by a newer list (or by the row's return) is dropped.
    let current = true;
    lookUpInspected(() => current);
    return () => {
      current = false;
    };
  }, [events, unlisted]);
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
  const { completeTask } = useGuardedMutations();
  const toggleTask = (task: TaskRecord) =>
    void completeTask({
      accountId: task.accountId,
      status: task.status === 'completed' ? 'needsAction' : 'completed',
      taskId: task.id,
      taskListId: task.listId,
    });
  const taskLists = useTaskLists();
  const listColorOf = useListColorLookup();
  const isTaskReadOnly = useTaskReadOnlyLookup();
  const isEventReadOnly = useEventReadOnlyLookup();
  const calendars = useCalendars();
  const accounts = useAccounts();
  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);

  // The drag hook lives here, not in the week view: the panel's task rows
  // drag onto the grid and lane too, and the hook reads their rects.
  const gridRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const strip = useWeekStrip(days, slide);
  const drag = useEventDrag({
    gridRef,
    hourHeight: HOUR_HEIGHT,
    isEventReadOnly,
    laneRef,
    onEventClick: (event) => setPanel({ event, kind: 'inspector' }),
    onTaskClick: (task) => setPanel({ kind: 'editTask', opening: nextOpening(), task }),
    scrollerRef: scrollRef,
    strip,
  });

  const captureOpen = capture.state.kind !== 'idle';
  // The window's own modal dialogs; the panel's editors are not dialogs
  // (they never join the dialog stack, so a real dialog over them — the
  // agent approval, a capture — keeps Escape and Enter).
  const dialogOpen = captureOpen || viewBirthday !== null;
  useEffect(() => {
    const onKeyDown = (key: KeyboardEvent) => {
      const command = key.metaKey || key.ctrlKey;
      // Any dialog of this window counts — the agent approval dialog too,
      // which App opens over the calendar without it knowing.
      const anyDialog = dialogOpen || isDialogOpen();
      if (key.key === 'Escape') {
        // Escape leaves the panel's inspector, editor or search, from
        // anywhere in the window but a dialog (which takes its own Escape
        // first); a result opened from search goes back to the results.
        if (!anyDialog && panel.kind !== 'rail') {
          setPanel(backFrom(panel));
        }
        return;
      }
      if (command && key.key.toLowerCase() === 'f') {
        key.preventDefault();
        // ⌘F opens search, or takes it back to its field — not from under
        // a dialog, and not over an open editor, whose draft it would drop.
        if (!anyDialog && !editing) {
          setPanel({ kind: 'search', selectText: true });
          setSearchFocus((count) => count + 1);
        }
        return;
      }
      if (command && key.key.toLowerCase() === 'k') {
        key.preventDefault();
        // ⌘K goes to a new item's quick-add field: the open new-item
        // editor's, else a fresh one — not from under a dialog, whose
        // Escape and Enter the field would otherwise take, and not over
        // another editor, whose draft it would drop.
        if (anyDialog) {
          return;
        }
        const newItem =
          panel.kind === 'editEvent' && panel.seed.event === undefined && panel.mode === undefined;
        if (newItem) {
          setQuickAddFocus((count) => count + 1);
        } else if (!editing) {
          openNew();
        }
        return;
      }
      // The rest are single keys for the calendar itself: not while a
      // dialog or an editor is open, or while typing.
      if (anyDialog || editing || isTyping(key.target) || key.altKey) {
        return;
      }
      if (command && key.key.toLowerCase() === 'n') {
        key.preventDefault();
        openNew();
      } else if (!command && key.key.toLowerCase() === 't') {
        goToday();
      } else if (!command && key.key === 'ArrowLeft') {
        step(-1);
      } else if (!command && key.key === 'ArrowRight') {
        step(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialogOpen, editing, goToday, openNew, panel, step]);

  // ⌘V on the calendar itself: an email or a screenshot becomes events to
  // review. Not while a dialog is open or a field has focus — those pastes
  // are theirs. The stock Edit › Paste menu role fires the same event.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (dialogOpen || isDialogOpen() || isTyping(event.target)) {
        return;
      }
      const pasted = readPaste(event.clipboardData);
      if (!isCapturable(pasted)) {
        return;
      }
      event.preventDefault();
      void captureSourceOf(pasted).then((source) => {
        if (source) {
          capture.start(source);
        }
      });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [capture, dialogOpen]);

  const closePanel = () => setPanel(backFrom(panel));
  const openSearch = () => {
    setPanel({ kind: 'search', selectText: true });
    setSearchFocus((count) => count + 1);
  };
  // A result: its day in the grid (its own week, even after a pan rolled
  // the window elsewhere), and the occurrence in the inspector. A timed one
  // out of the time grid's view is scrolled into it, so its outlined block
  // shows (the grid rests on the morning).
  const openSearchEvent = (event: EventRecord) => {
    goToDay(eventStartDay(event, timeZone));
    setPanel({ event, fromSearch: true, kind: 'inspector' });
    const scroller = scrollRef.current;
    if (scroller && !event.isAllDay && view !== 'month') {
      const start = toZonedDateTime(event.startUtc, timeZone);
      const top = (start.hour + start.minute / 60) * HOUR_HEIGHT;
      if (
        top < scroller.scrollTop ||
        top + HOUR_HEIGHT > scroller.scrollTop + scroller.clientHeight
      ) {
        scroller.scrollTo({ top: Math.max(0, top - HOUR_HEIGHT) });
      }
    }
  };
  /** The event open in the panel: its block carries the grid's one outline. */
  const selectedEvent =
    panel.kind === 'inspector'
      ? panel.event
      : panel.kind === 'editEvent'
        ? panel.seed.event
        : undefined;
  const selectedKey = selectedEvent ? `${selectedEvent.calendarId}:${selectedEvent.id}` : undefined;
  const panelKey =
    panel.kind === 'inspector'
      ? // By identity: an occurrence edited on its own keeps its inspector.
        `inspect:${eventIdentity(panel.event)}`
      : panel.kind === 'editEvent'
        ? `event:${panel.seed.event?.id ?? 'new'}:${String(panel.opening)}`
        : panel.kind === 'editTask'
          ? `task:${panel.task?.id ?? 'new'}:${String(panel.opening)}`
          : panel.kind;

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink">
      <Toolbar
        onNew={openNew}
        onSearch={() => (panel.kind === 'search' ? setPanel(RAIL) : openSearch())}
        onStep={step}
        onSwitchView={changeView}
        onToday={goToday}
        onTogglePanel={() => setRailOpen(!railShown)}
        onToggleSidebar={() => updatePrefs({ sidebarCollapsed: !sidebarCollapsed })}
        panelShown={railShown}
        searchActive={searching}
        sidebarCollapsed={sidebarCollapsed}
        title={title}
        view={view}
      />

      <div className="flex min-h-0 flex-1">
        {sidebarCollapsed ? null : (
          <Sidebar
            accounts={accounts}
            calendars={calendars}
            focused={focused}
            onManageAccounts={() => void window.calendarBridge.openSettings('accounts')}
            onPickDay={scrollToDay}
            today={Temporal.PlainDate.from(today)}
            visible={view === 'month' ? null : { end: days.at(-1)!, start: days[0]! }}
          />
        )}

        {/* Positioned for the notice stack: toasts and the conflict banner
            stay over the grid, clear of the sidebar and the panel. */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {view === 'month' ? (
            <MonthView
              birthdays={birthdays}
              colorOf={colorOf}
              events={events}
              listColorOf={listColorOf}
              onBirthdayClick={(birthday) => setViewBirthday(birthday)}
              onEventClick={(event) => setPanel({ event, kind: 'inspector' })}
              onSelectDay={(date) => {
                setFocused(date);
                changeView('day');
              }}
              onTaskClick={(task) => setPanel({ kind: 'editTask', opening: nextOpening(), task })}
              onToggleTask={toggleTask}
              overdue={overdue}
              selectedKey={selectedKey}
              tasks={tasks}
              timeZone={timeZone}
              today={today}
              yearMonth={Temporal.PlainYearMonth.from(focused)}
            />
          ) : (
            <WeekView
              birthdays={birthdays}
              colorOf={colorOf}
              days={days}
              drag={drag}
              events={events}
              gridRef={gridRef}
              isEventReadOnly={isEventReadOnly}
              isTaskReadOnly={isTaskReadOnly}
              laneRef={laneRef}
              listColorOf={listColorOf}
              onBirthdayClick={(birthday) => setViewBirthday(birthday)}
              onEventClick={(event) => setPanel({ event, kind: 'inspector' })}
              onNavigate={panByDays}
              onSlideEnd={endSlide}
              onSlotClick={(date, hour) => openEditor({ initialDate: date, initialHour: hour })}
              onSlotDrag={(date, times) => openEditor({ initialDate: date, initialTimes: times })}
              onTaskClick={(task) => setPanel({ kind: 'editTask', opening: nextOpening(), task })}
              onToggleTask={toggleTask}
              overdue={overdue}
              scrollRef={scrollRef}
              secondaryZones={secondaryZones}
              selectedKey={selectedKey}
              slide={slide}
              tasks={tasks}
              timeZone={timeZone}
              today={today}
            />
          )}
          <NoticeStack conflicts dropped placement="column" />
        </div>

        {panel.kind === 'rail' && !railShown ? null : (
          <aside
            className={`flex shrink-0 flex-col border-l border-hairline bg-surface-subtle ${
              editing ? 'w-[360px]' : 'w-[300px]'
            }`}
            data-panel-kind={panel.kind}
            data-testid="panel"
            key={panelKey}
          >
            {panel.kind === 'rail' ? (
              <TodayRail
                drag={drag}
                onEditTask={(task) => setPanel({ kind: 'editTask', opening: nextOpening(), task })}
                onOpenEvent={(event) => setPanel({ event, kind: 'inspector' })}
                timeZone={timeZone}
              />
            ) : panel.kind === 'search' ? (
              <SearchPanel
                calendars={calendars}
                focusSignal={searchFocus}
                onClose={() => setPanel(RAIL)}
                onOpenEvent={openSearchEvent}
                onOpenTask={(task) =>
                  setPanel({ fromSearch: true, kind: 'editTask', opening: nextOpening(), task })
                }
                onTextChange={setSearchText}
                readScrollTop={readSearchScroll}
                saveScrollTop={saveSearchScroll}
                search={search}
                selectText={panel.selectText}
                taskLists={taskLists}
                text={searchText}
                timeZone={timeZone}
              />
            ) : panel.kind === 'inspector' ? (
              <EventInspector
                calendars={calendars}
                event={panel.event}
                onBack={panel.fromSearch ? () => setPanel(RESULTS) : undefined}
                onClose={() => setPanel(RAIL)}
                onConvert={() =>
                  setPanel({
                    fromSearch: panel.fromSearch,
                    kind: 'editEvent',
                    mode: defaultTodoKind(taskLists),
                    opening: nextOpening(),
                    seed: { event: panel.event, initialDate: focused, initialScope: 'series' },
                  })
                }
                onEdit={() =>
                  setPanel({
                    fromSearch: panel.fromSearch,
                    kind: 'editEvent',
                    opening: nextOpening(),
                    seed: { event: panel.event, initialDate: focused },
                  })
                }
                timeZone={timeZone}
              />
            ) : panel.kind === 'editEvent' ? (
              <EditorPanel
                calendars={calendars}
                initialKind={panel.mode}
                onCapture={capture.start}
                onClose={closePanel}
                onSaved={
                  panel.captureRow === undefined
                    ? undefined
                    : () => capture.markAdded(panel.captureRow!)
                }
                quickAddFocus={quickAddFocus}
                seed={panel.seed}
                taskLists={taskLists}
                timeZone={timeZone}
              />
            ) : (
              <EditorPanel
                calendars={calendars}
                onCapture={capture.start}
                onClose={closePanel}
                seed={{ initialDate: focused }}
                task={panel.task}
                taskLists={taskLists}
                timeZone={timeZone}
              />
            )}
          </aside>
        )}
      </div>

      <DragGhost drag={drag} />

      {/* Hidden while a row's editor is open: the editor is the capture's next step. */}
      {capture.state.kind !== 'idle' &&
      !(panel.kind === 'editEvent' && panel.captureRow !== undefined) ? (
        <CaptureDialog
          onClose={capture.dismiss}
          onOpenRow={(row) => openPrefill(row.prefill, row.id)}
          state={capture.state}
        />
      ) : null}

      {viewBirthday ? (
        <Dialog
          key={`birthday:${viewBirthday.record.id}:${viewBirthday.date}`}
          label="Birthday"
          onClose={() => setViewBirthday(null)}
          panelClassName="w-[420px] rounded-popover bg-surface-raised p-6 shadow-2xl"
          zIndex={30}
        >
          <h2 className="mb-4 text-lg font-semibold">Birthday</h2>
          <BirthdayDetail
            occurrence={viewBirthday}
            onClose={() => setViewBirthday(null)}
            timeZone={timeZone}
          />
        </Dialog>
      ) : null}
    </div>
  );
}
