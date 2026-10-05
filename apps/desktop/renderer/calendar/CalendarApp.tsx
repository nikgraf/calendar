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
  type EventEditorPrefill,
} from '@calendar/app-state';
import { useEffect, useMemo, useState } from 'react';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { desktopTextRecognizer } from '../ai/desktopTextRecognizer.ts';
import { EventEditor, type EditorSeed } from './EventEditor.tsx';
import { CaptureDialog } from './CaptureDialog.tsx';
import { captureSourceOf, isCapturable, readPaste } from './captureClipboard.ts';
import { makeColorLookup } from './colors.ts';
import { MonthView } from './MonthView.tsx';
import { Sidebar } from './Sidebar.tsx';
import { CommandBar } from './CommandBar.tsx';
import { WeekView } from './WeekView.tsx';

/** Keys and pastes inside a field belong to the field, not the calendar. */
const isTyping = (target: EventTarget | null) => {
  const element = target as { isContentEditable?: boolean; tagName?: string } | null;
  return Boolean(
    element?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(element?.tagName ?? ''),
  );
};

/**
 * Waits for the device-local time zones before drawing anything: a first
 * frame in the device zone followed by a re-layout in the primary zone
 * would, near midnight with a distant primary, also seed the focused day
 * and "today" with the wrong date. The read resolves with the other
 * initial atoms, so the gate never shows.
 */
export function CalendarApp() {
  const zones = useTimeZones();
  if (!zones.loaded) {
    return <div className="flex h-screen bg-white" />;
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
  const { days, focused, goToday, panByDays, range, setFocused, step, switchView, title, view } =
    useCalendarNavigation({
      dayBuffer: PAN_BUFFER_DAYS,
      initialView: 'week',
      timeZone,
      titleStyle: 'long',
    });
  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null);
  const [editTask, setEditTask] = useState<TaskRecord | null>(null);
  const [viewBirthday, setViewBirthday] = useState<BirthdayOccurrence | null>(null);
  const [commandBarOpen, setCommandBarOpen] = useState(false);
  /** The capture row whose editor is open, so a save can mark it added. */
  const [captureRow, setCaptureRow] = useState<string | null>(null);

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
  const dialogOpen =
    commandBarOpen ||
    captureOpen ||
    editorSeed !== null ||
    editTask !== null ||
    viewBirthday !== null;
  useEffect(() => {
    const onKeyDown = (key: KeyboardEvent) => {
      const command = key.metaKey || key.ctrlKey;
      if (command && key.key.toLowerCase() === 'k') {
        key.preventDefault();
        setCommandBarOpen((open) => !open);
        return;
      }
      // The rest are single keys for the calendar itself: not while a
      // dialog is open (they close on Escape themselves) or while typing.
      if (dialogOpen || isTyping(key.target) || key.altKey) {
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
      if (dialogOpen || isTyping(event.target)) {
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

  return (
    <div className="flex h-screen bg-white text-neutral-900">
      <Sidebar
        accounts={accounts}
        calendars={calendars}
        onManageAccounts={() => void window.calendarBridge.openSettings('accounts')}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center gap-3 border-b border-neutral-200 px-4 py-2.5"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <h1 className="min-w-56 text-lg font-semibold">{title}</h1>
          <div
            className="flex items-center gap-1"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              aria-label={`Previous ${view}`}
              className="rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100"
              onClick={() => step(-1)}
              type="button"
            >
              ‹
            </button>
            <button
              className="rounded-md px-2 py-1 text-sm hover:bg-neutral-100"
              onClick={goToday}
              type="button"
            >
              Today
            </button>
            <button
              aria-label={`Next ${view}`}
              className="rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100"
              onClick={() => step(1)}
              type="button"
            >
              ›
            </button>
          </div>
          <div className="flex-1" />
          <div
            className="flex rounded-lg bg-neutral-100 p-0.5 text-sm"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {(['day', 'week', 'month'] as const).map((kind) => (
              <button
                className={`rounded-md px-3 py-1 capitalize ${
                  view === kind
                    ? 'bg-white font-medium shadow-sm'
                    : 'text-neutral-500 hover:text-neutral-800'
                }`}
                key={kind}
                onClick={() => switchView(kind)}
                type="button"
              >
                {kind}
              </button>
            ))}
          </div>
          <button
            aria-label="New event"
            className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500"
            onClick={() => setEditorSeed({ initialDate: focused, initialHour: 9 })}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            type="button"
          >
            +
          </button>
        </header>

        {view === 'month' ? (
          <MonthView
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
            onSlotDrag={(date, times) => setEditorSeed({ initialDate: date, initialTimes: times })}
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

      {commandBarOpen ? (
        <CommandBar
          focusedDate={focused}
          onCapture={capture.start}
          onClose={() => setCommandBarOpen(false)}
          onParsed={openPrefill}
          timeZone={timeZone}
        />
      ) : null}

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

      {editorSeed || editTask || viewBirthday ? (
        <EventEditor
          birthday={viewBirthday ?? undefined}
          calendars={calendars}
          key={
            viewBirthday
              ? `birthday:${viewBirthday.record.id}:${viewBirthday.date}`
              : editTask
                ? `task:${editTask.id}`
                : (editorSeed?.event?.id ?? 'new')
          }
          onClose={() => {
            setEditorSeed(null);
            setEditTask(null);
            setViewBirthday(null);
            setCaptureRow(null);
          }}
          onSaved={captureRow ? () => capture.markAdded(captureRow) : undefined}
          seed={editorSeed ?? { initialDate: focused }}
          task={editTask ?? undefined}
          taskLists={taskLists}
          timeZone={timeZone}
        />
      ) : null}
    </div>
  );
}
