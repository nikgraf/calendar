import {
  bufferedRange,
  monthGridRange,
  PAN_BUFFER_DAYS,
  Temporal,
  utcMsToPlainDate,
  type UtcRange,
  weekStart,
} from '@calendar/core';
import {
  useAccounts,
  useBackendMutations,
  useCalendars,
  useEventsInRangeStable,
  useTasksInRangeStable,
} from '@calendar/app-state';
import { useMemo, useState } from 'react';
import { AccountsView } from '../AccountsView.tsx';
import { EventEditor, type EditorSeed } from './EventEditor.tsx';
import { makeColorLookup } from './colors.ts';
import { MonthView } from './MonthView.tsx';
import { Sidebar } from './Sidebar.tsx';
import { WeekView } from './WeekView.tsx';

type ViewKind = 'day' | 'month' | 'week';

const rangeFor = (
  view: ViewKind,
  focused: Temporal.PlainDate,
  windowStart: Temporal.PlainDate,
  timeZone: string,
): UtcRange => {
  switch (view) {
    // Day/week ranges include the pan buffer columns so panning reveals
    // already-loaded days.
    case 'day': {
      return bufferedRange(focused, 1, PAN_BUFFER_DAYS, timeZone);
    }
    case 'month': {
      return monthGridRange(
        Temporal.PlainYearMonth.from(focused),
        Temporal.Now.plainDateISO(timeZone),
        timeZone,
      );
    }
    case 'week': {
      return bufferedRange(windowStart, 7, PAN_BUFFER_DAYS, timeZone);
    }
  }
};

const titleFor = (
  view: ViewKind,
  focused: Temporal.PlainDate,
  windowStart: Temporal.PlainDate,
): string => {
  if (view === 'month') {
    return focused.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }
  if (view === 'day') {
    return focused.toLocaleString('en-US', {
      day: 'numeric',
      month: 'long',
      weekday: 'long',
      year: 'numeric',
    });
  }
  const start = windowStart;
  const end = start.add({ days: 6 });
  const sameMonth = start.month === end.month;
  return sameMonth
    ? `${start.toLocaleString('en-US', { month: 'long' })} ${start.day} – ${end.day}, ${start.year}`
    : `${start.toLocaleString('en-US', { day: 'numeric', month: 'short' })} – ${end.toLocaleString('en-US', { day: 'numeric', month: 'short' })}, ${end.year}`;
};

export function CalendarApp() {
  const timeZone = Temporal.Now.timeZoneId();
  const [view, setView] = useState<ViewKind>('week');
  const [focused, setFocused] = useState(() => Temporal.Now.plainDateISO(timeZone));
  // Week view's rolling window anchor; null = Monday-snapped week (default).
  // Only wheel navigation sets it — Today and view switches reset it.
  const [weekWindowStart, setWeekWindowStart] = useState<Temporal.PlainDate | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null);

  const windowStart = useMemo(
    () => weekWindowStart ?? weekStart(focused),
    [weekWindowStart, focused],
  );
  const range = useMemo(
    () => rangeFor(view, focused, windowStart, timeZone),
    [view, focused, windowStart, timeZone],
  );
  const events = useEventsInRangeStable(range.startUtc, range.endUtc);
  // Tasks are date-only; the same fetched window expressed as day strings.
  const tasks = useTasksInRangeStable(
    utcMsToPlainDate(range.startUtc),
    utcMsToPlainDate(range.endUtc),
  );
  const { completeTask } = useBackendMutations();
  const calendars = useCalendars();
  const accounts = useAccounts();
  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);

  const step = (direction: 1 | -1) => {
    setFocused((current) =>
      view === 'month'
        ? current.add({ months: direction })
        : current.add({ days: direction * (view === 'week' ? 7 : 1) }),
    );
    if (view === 'week') {
      setWeekWindowStart((current) => current?.add({ days: 7 * direction }) ?? null);
    }
  };

  // Pan commits: whole days crossed while wheel-panning. In week view the
  // rolling window and `focused` shift together, keeping focused inside
  // the visible days.
  const panByDays = (dayCount: number) => {
    if (view === 'week') {
      setWeekWindowStart(windowStart.add({ days: dayCount }));
    }
    setFocused((current) => current.add({ days: dayCount }));
  };

  const switchView = (kind: ViewKind) => {
    setWeekWindowStart(null);
    setView(kind);
  };

  const days = useMemo(() => {
    if (view === 'day') {
      return [focused];
    }
    return Array.from({ length: 7 }, (_, index) => windowStart.add({ days: index }));
  }, [view, focused, windowStart]);

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
          <h1 className="min-w-56 text-lg font-semibold">{titleFor(view, focused, windowStart)}</h1>
          <div
            className="flex items-center gap-1"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              className="rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100"
              onClick={() => step(-1)}
              type="button"
            >
              ‹
            </button>
            <button
              className="rounded-md px-2 py-1 text-sm hover:bg-neutral-100"
              onClick={() => {
                setFocused(Temporal.Now.plainDateISO(timeZone));
                setWeekWindowStart(null);
              }}
              type="button"
            >
              Today
            </button>
            <button
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
            className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-500"
            onClick={() => setEditorSeed({ initialDate: focused, initialHour: 9 })}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            type="button"
          >
            +
          </button>
          <button
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
            onEventClick={(event) => setEditorSeed({ event, initialDate: focused })}
            onNavigate={panByDays}
            onSlotClick={(date, hour) => setEditorSeed({ initialDate: date, initialHour: hour })}
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

      {editorSeed ? (
        <EventEditor
          calendars={calendars}
          onClose={() => setEditorSeed(null)}
          seed={editorSeed}
          timeZone={timeZone}
        />
      ) : null}

      {showSettings ? (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/30"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="max-h-[80vh] w-[540px] overflow-y-auto rounded-2xl bg-neutral-50 p-8 shadow-2xl"
            onClick={(clickEvent) => clickEvent.stopPropagation()}
          >
            <AccountsView />
          </div>
        </div>
      ) : null}
    </div>
  );
}
