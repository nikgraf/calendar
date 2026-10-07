import {
  type BirthdayOccurrence,
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
import { isDialogOpen } from '../Dialog.tsx';
import { EventEditor, type EditorSeed } from './EventEditor.tsx';
import { CaptureDialog } from './CaptureDialog.tsx';
import { captureSourceOf, isCapturable, readPaste } from './captureClipboard.ts';
import { makeColorLookup } from './colors.ts';
import { MonthView } from './MonthView.tsx';
import { Sidebar } from './sidebar/Sidebar.tsx';
import { Toolbar } from './Toolbar.tsx';
import { WeekView } from './WeekView.tsx';

type MainView = 'day' | 'month' | 'week';

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

  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null);
  const [editTask, setEditTask] = useState<TaskRecord | null>(null);
  /** A quick-add phrase understood as a task: the task editor opens with it. */
  const [taskSeed, setTaskSeed] = useState<TaskEditorSeed | null>(null);
  const [viewBirthday, setViewBirthday] = useState<BirthdayOccurrence | null>(null);
  /** The capture row whose editor is open, so a save can mark it added. */
  const [captureRow, setCaptureRow] = useState<string | null>(null);
  const quickAddRef = useRef<HTMLInputElement>(null);

  // A parsed prefill (quick-add, or a single captured event) opens the
  // editor on its day: the user reviews it before anything is written.
  const openPrefill = (prefill: EventEditorPrefill) => {
    setEditorSeed({ initialDate: Temporal.PlainDate.from(prefill.date), prefill });
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
  const editorOpen = editorSeed !== null || editTask !== null || taskSeed !== null;
  const dialogOpen = captureOpen || editorOpen || viewBirthday !== null;
  useEffect(() => {
    const onKeyDown = (key: KeyboardEvent) => {
      const command = key.metaKey || key.ctrlKey;
      // Any dialog of this window counts — the agent approval dialog too,
      // which App opens over the calendar without it knowing.
      const anyDialog = dialogOpen || isDialogOpen();
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
      // dialog is open (they close on Escape themselves) or while typing.
      if (anyDialog || isTyping(key.target) || key.altKey) {
        return;
      }
      if (command && key.key.toLowerCase() === 'n') {
        key.preventDefault();
        setEditorSeed({ initialDate: focused, initialHour: 9 });
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
  }, [dialogOpen, focused, goToday, step]);

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

  const closeEditor = () => {
    setEditorSeed(null);
    setEditTask(null);
    setTaskSeed(null);
    setViewBirthday(null);
    setCaptureRow(null);
  };

  return (
    <div className="flex h-screen flex-col bg-canvas text-ink">
      <Toolbar
        focused={focused}
        onCapture={capture.start}
        onNew={() => setEditorSeed({ initialDate: focused, initialHour: 9 })}
        onParsed={openPrefill}
        onStep={step}
        onSwitchView={changeView}
        onTaskParsed={setTaskSeed}
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
              onEventClick={(event) => setEditorSeed({ event, initialDate: focused })}
              onNavigate={panByDays}
              onSlotClick={(date, hour) => setEditorSeed({ initialDate: date, initialHour: hour })}
              onSlotDrag={(date, times) =>
                setEditorSeed({ initialDate: date, initialTimes: times })
              }
              onTaskClick={(task) => setEditTask(task)}
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
      </div>

      {/* Hidden while a row's editor is open: two dialogs would both close on one Escape. */}
      {capture.state.kind !== 'idle' && !editorSeed ? (
        <CaptureDialog
          onClose={capture.dismiss}
          onOpenRow={(row) => {
            setCaptureRow(row.id);
            openPrefill(row.prefill);
          }}
          state={capture.state}
        />
      ) : null}

      {editorOpen || viewBirthday ? (
        <EventEditor
          birthday={viewBirthday ?? undefined}
          calendars={calendars}
          key={
            viewBirthday
              ? `birthday:${viewBirthday.record.id}:${viewBirthday.date}`
              : editTask
                ? `task:${editTask.id}`
                : taskSeed
                  ? 'new-task'
                  : (editorSeed?.event?.id ?? 'new')
          }
          onClose={closeEditor}
          onSaved={captureRow ? () => capture.markAdded(captureRow) : undefined}
          seed={
            editorSeed ??
            (taskSeed ? { initialDate: Temporal.PlainDate.from(taskSeed.initialDate) } : null) ?? {
              initialDate: focused,
            }
          }
          task={editTask ?? undefined}
          taskLists={taskLists}
          taskPrefill={taskSeed ?? undefined}
          timeZone={timeZone}
        />
      ) : null}
    </div>
  );
}
