import {
  type BirthdayOccurrence,
  type EventRecord,
  PAN_BUFFER_DAYS,
  type TaskRecord,
  Temporal,
  utcMsToPlainDate,
} from '@calendar/core';
import {
  useAccounts,
  useCalendarNavigation,
  useCalendars,
  useCaptureModel,
  useEventReadOnlyLookup,
  useEventsInRangeStable,
  useGuardedMutations,
  useListColorLookup,
  useOverdueTasksStable,
  useTaskLists,
  useBirthdaysInRangeStable,
  useTaskReadOnlyLookup,
  useTasksInRangeStable,
  useTimeZones,
  useToday,
  useUpdateViewPreferences,
  useViewPreferences,
  type EventEditorPrefill,
  type TaskEditorSeed,
} from '@calendar/app-state';
import { useEffect, useMemo, useRef, useState } from 'react';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { desktopTextRecognizer } from '../ai/desktopTextRecognizer.ts';
import { Dialog, isDialogOpen } from '../Dialog.tsx';
import { BirthdayDetail } from './BirthdayDetail.tsx';
import { CaptureDialog } from './CaptureDialog.tsx';
import { captureSourceOf, isCapturable, readPaste } from './captureClipboard.ts';
import { makeColorLookup } from './colors.ts';
import { MonthView } from './MonthView.tsx';
import { EditorPanel, type EditorSeed } from './panel/EditorPanel.tsx';
import { EventInspector } from './panel/EventInspector.tsx';
import { TodayRail } from './panel/TodayRail.tsx';
import { Sidebar } from './sidebar/Sidebar.tsx';
import { Toolbar } from './Toolbar.tsx';
import { WeekView } from './WeekView.tsx';

type MainView = 'day' | 'month' | 'week';

/**
 * What the side panel shows: the Today rail at rest, an event's inspector
 * after a click on the grid, or an inline editor (Edit, a slot, New, a
 * task chip, a quick-add phrase).
 */
type PanelState =
  | { readonly kind: 'rail' }
  | { readonly event: EventRecord; readonly kind: 'inspector' }
  | {
      /** The capture row this editor came from, so a save can mark it added. */
      readonly captureRow?: string | undefined;
      readonly kind: 'editEvent';
      readonly mode?: 'task' | undefined;
      readonly seed: EditorSeed;
    }
  | {
      readonly kind: 'editTask';
      readonly prefill?: TaskEditorSeed | undefined;
      readonly task?: TaskRecord | undefined;
    };

const RAIL: PanelState = { kind: 'rail' };

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
  const { days, focused, goToday, panByDays, range, setFocused, step, switchView, title, view } =
    useCalendarNavigation({
      dayBuffer: PAN_BUFFER_DAYS,
      initialView,
      timeZone,
      titleStyle: 'long',
    });
  const prefs = useViewPreferences();
  const updatePrefs = useUpdateViewPreferences();
  const sidebarCollapsed = prefs?.sidebarCollapsed ?? false;
  const changeView = (next: MainView) => {
    switchView(next);
    updatePrefs({ lastView: next });
  };

  const [panel, setPanel] = useState<PanelState>(RAIL);
  const [viewBirthday, setViewBirthday] = useState<BirthdayOccurrence | null>(null);
  const quickAddRef = useRef<HTMLInputElement>(null);
  const editing = panel.kind === 'editEvent' || panel.kind === 'editTask';
  const openEditor = (seed: EditorSeed) => setPanel({ kind: 'editEvent', seed });

  // A parsed prefill (quick-add, or a single captured event) opens the
  // editor on its day: the user reviews it before anything is written.
  const openPrefill = (prefill: EventEditorPrefill, captureRow?: string) => {
    setPanel({
      captureRow,
      kind: 'editEvent',
      seed: { initialDate: Temporal.PlainDate.from(prefill.date), prefill },
    });
  };
  const capture = useCaptureModel({
    model: desktopLanguageModel,
    onSingle: openPrefill,
    recognizer: desktopTextRecognizer,
    timeZone,
  });

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
  const { completeTask } = useGuardedMutations();
  const taskLists = useTaskLists();
  const listColorOf = useListColorLookup();
  const isTaskReadOnly = useTaskReadOnlyLookup();
  const isEventReadOnly = useEventReadOnlyLookup();
  const calendars = useCalendars();
  const accounts = useAccounts();
  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);

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
        // Escape leaves the panel's inspector or editor, from anywhere in
        // the window but a dialog (which takes its own Escape first).
        if (!anyDialog && panel.kind !== 'rail') {
          setPanel(RAIL);
        }
        return;
      }
      if (command && key.key.toLowerCase() === 'k') {
        key.preventDefault();
        // ⌘K goes to the quick-add field — not from under a dialog, whose
        // Escape and Enter the field would otherwise take.
        if (!anyDialog) {
          quickAddRef.current?.focus();
          quickAddRef.current?.select();
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
        openEditor({ initialDate: focused, initialHour: 9 });
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
  }, [dialogOpen, editing, focused, goToday, panel.kind, step]);

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

  const closePanel = () => setPanel(RAIL);
  const panelKey =
    panel.kind === 'inspector'
      ? `inspect:${panel.event.id}`
      : panel.kind === 'editEvent'
        ? `event:${panel.seed.event?.id ?? 'new'}`
        : panel.kind === 'editTask'
          ? `task:${panel.task?.id ?? 'new'}`
          : 'rail';

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink">
      <Toolbar
        focused={focused}
        onCapture={capture.start}
        onNew={() => openEditor({ initialDate: focused, initialHour: 9 })}
        onParsed={openPrefill}
        onStep={step}
        onSwitchView={changeView}
        onTaskParsed={(prefill) => setPanel({ kind: 'editTask', prefill })}
        onToday={goToday}
        onToggleSidebar={() => updatePrefs({ sidebarCollapsed: !sidebarCollapsed })}
        quickAddRef={quickAddRef}
        sidebarCollapsed={sidebarCollapsed}
        timeZone={timeZone}
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
            onPickDay={setFocused}
            today={Temporal.PlainDate.from(today)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {view === 'month' ? (
            <MonthView
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
          ) : (
            <WeekView
              birthdays={birthdays}
              colorOf={colorOf}
              days={days}
              events={events}
              isEventReadOnly={isEventReadOnly}
              isTaskReadOnly={isTaskReadOnly}
              listColorOf={listColorOf}
              onBirthdayClick={(birthday) => setViewBirthday(birthday)}
              onEventClick={(event) => setPanel({ event, kind: 'inspector' })}
              onNavigate={panByDays}
              onSlotClick={(date, hour) => openEditor({ initialDate: date, initialHour: hour })}
              onSlotDrag={(date, times) => openEditor({ initialDate: date, initialTimes: times })}
              onTaskClick={(task) => setPanel({ kind: 'editTask', task })}
              onToggleTask={(task) =>
                void completeTask({
                  accountId: task.accountId,
                  status: task.status === 'completed' ? 'needsAction' : 'completed',
                  taskId: task.id,
                  taskListId: task.listId,
                })
              }
              overdue={overdue}
              secondaryZones={secondaryZones}
              tasks={tasks}
              timeZone={timeZone}
              today={today}
            />
          )}
        </div>

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
              onEditTask={(task) => setPanel({ kind: 'editTask', task })}
              onOpenEvent={(event) => setPanel({ event, kind: 'inspector' })}
              timeZone={timeZone}
            />
          ) : panel.kind === 'inspector' ? (
            <EventInspector
              calendars={calendars}
              event={panel.event}
              onClose={closePanel}
              onConvert={() =>
                setPanel({
                  kind: 'editEvent',
                  mode: 'task',
                  seed: { event: panel.event, initialDate: focused },
                })
              }
              onEdit={() =>
                setPanel({ kind: 'editEvent', seed: { event: panel.event, initialDate: focused } })
              }
              timeZone={timeZone}
            />
          ) : panel.kind === 'editEvent' ? (
            <EditorPanel
              calendars={calendars}
              initialMode={panel.mode}
              onClose={closePanel}
              onSaved={
                panel.captureRow === undefined
                  ? undefined
                  : () => capture.markAdded(panel.captureRow!)
              }
              seed={panel.seed}
              taskLists={taskLists}
              timeZone={timeZone}
            />
          ) : (
            <EditorPanel
              calendars={calendars}
              onClose={closePanel}
              seed={{
                initialDate: panel.prefill
                  ? Temporal.PlainDate.from(panel.prefill.initialDate)
                  : focused,
              }}
              task={panel.task}
              taskLists={taskLists}
              taskPrefill={panel.prefill}
              timeZone={timeZone}
            />
          )}
        </aside>
      </div>

      {/* Hidden while a row's editor is open: the editor is the capture's next step. */}
      {capture.state.kind !== 'idle' && panel.kind !== 'editEvent' ? (
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
