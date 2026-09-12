import { PAN_BUFFER_DAYS, type TaskRecord, Temporal, utcMsToPlainDate } from '@calendar/core';
import {
  useAccounts,
  useCalendarNavigation,
  useCalendars,
  useEventsInRangeStable,
  useGuardedMutations,
  useListColorLookup,
  useTaskLists,
  useTasksInRangeStable,
} from '@calendar/app-state';
import { useEffect, useMemo, useState } from 'react';
import { AccountsView } from '../AccountsView.tsx';
import { Dialog } from '../Dialog.tsx';
import { EventEditor, type EditorSeed } from './EventEditor.tsx';
import { makeColorLookup } from './colors.ts';
import { MonthView } from './MonthView.tsx';
import { Sidebar } from './Sidebar.tsx';
import { CommandBar } from './CommandBar.tsx';
import { WeekView } from './WeekView.tsx';

export function CalendarApp() {
  const timeZone = Temporal.Now.timeZoneId();
  const { days, focused, goToday, panByDays, range, setFocused, step, switchView, title, view } =
    useCalendarNavigation({
      dayBuffer: PAN_BUFFER_DAYS,
      initialView: 'week',
      timeZone,
      titleStyle: 'long',
    });
  const [showSettings, setShowSettings] = useState(false);
  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null);
  const [editTask, setEditTask] = useState<TaskRecord | null>(null);
  const [commandBarOpen, setCommandBarOpen] = useState(false);

  const events = useEventsInRangeStable(range.startUtc, range.endUtc);
  // Tasks are date-only; the same fetched window expressed as day strings.
  const tasks = useTasksInRangeStable(
    utcMsToPlainDate(range.startUtc),
    utcMsToPlainDate(range.endUtc),
  );
  const { completeTask } = useGuardedMutations();
  const taskLists = useTaskLists();
  const listColorOf = useListColorLookup();
  const calendars = useCalendars();
  const accounts = useAccounts();
  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);

  const dialogOpen = commandBarOpen || editorSeed !== null || editTask !== null || showSettings;
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const element = target as { isContentEditable?: boolean; tagName?: string } | null;
      return Boolean(
        element?.isContentEditable ||
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(element?.tagName ?? ''),
      );
    };
    const onKeyDown = (key: KeyboardEvent) => {
      const command = key.metaKey || key.ctrlKey;
      if (command && key.key.toLowerCase() === 'k') {
        key.preventDefault();
        setCommandBarOpen((open) => !open);
        return;
      }
      if (command && key.key === ',') {
        key.preventDefault();
        setShowSettings(true);
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

  return (
    <div className="flex h-screen bg-white text-neutral-900">
      <Sidebar
        accounts={accounts}
        calendars={calendars}
        onOpenSettings={() => setShowSettings(true)}
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
          <button
            aria-label="Accounts"
            className="rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100"
            onClick={() => setShowSettings(true)}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title="Accounts"
            type="button"
          >
            ⚙
          </button>
        </header>

        {view === 'month' ? (
          <MonthView
            colorOf={colorOf}
            events={events}
            onSelectDay={(date) => {
              setFocused(date);
              switchView('day');
            }}
            timeZone={timeZone}
            yearMonth={Temporal.PlainYearMonth.from(focused)}
          />
        ) : (
          <WeekView
            colorOf={colorOf}
            days={days}
            events={events}
            listColorOf={listColorOf}
            onEventClick={(event) => setEditorSeed({ event, initialDate: focused })}
            onNavigate={panByDays}
            onSlotClick={(date, hour) => setEditorSeed({ initialDate: date, initialHour: hour })}
            onTaskClick={(task) => setEditTask(task)}
            onToggleTask={(task) =>
              void completeTask({
                accountId: task.accountId,
                status: task.status === 'completed' ? 'needsAction' : 'completed',
                taskId: task.id,
                taskListId: task.listId,
              })
            }
            tasks={tasks}
            timeZone={timeZone}
          />
        )}
      </div>

      {commandBarOpen ? (
        <CommandBar
          focusedDate={focused}
          onClose={() => setCommandBarOpen(false)}
          onParsed={(prefill) =>
            setEditorSeed({ initialDate: Temporal.PlainDate.from(prefill.date), prefill })
          }
          timeZone={timeZone}
        />
      ) : null}

      {editorSeed || editTask ? (
        <EventEditor
          calendars={calendars}
          key={editTask ? `task:${editTask.id}` : (editorSeed?.event?.id ?? 'new')}
          onClose={() => {
            setEditorSeed(null);
            setEditTask(null);
          }}
          seed={editorSeed ?? { initialDate: focused }}
          task={editTask ?? undefined}
          taskLists={taskLists}
          timeZone={timeZone}
        />
      ) : null}

      {showSettings ? (
        <Dialog
          label="Settings"
          onClose={() => setShowSettings(false)}
          panelClassName="max-h-[80vh] w-[540px] overflow-y-auto rounded-2xl bg-neutral-50 p-8 shadow-2xl"
          zIndex={20}
        >
          <AccountsView />
        </Dialog>
      ) : null}
    </div>
  );
}
