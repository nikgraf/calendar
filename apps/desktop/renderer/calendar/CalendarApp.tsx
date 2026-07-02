import {
  dayRange,
  monthGridRange,
  Temporal,
  weekRange,
  weekStart,
  type UtcRange,
} from '@calendar/core';
import { useAccounts, useCalendars, useEventsInRange } from '@calendar/app-state';
import { useMemo, useState } from 'react';
import { AccountsView } from '../AccountsView.tsx';
import { EventEditor, type EditorSeed } from './EventEditor.tsx';
import { makeColorLookup } from './colors.ts';
import { MonthView } from './MonthView.tsx';
import { Sidebar } from './Sidebar.tsx';
import { WeekView } from './WeekView.tsx';

type ViewKind = 'day' | 'month' | 'week';

const rangeFor = (view: ViewKind, focused: Temporal.PlainDate, timeZone: string): UtcRange => {
  switch (view) {
    case 'day': {
      return dayRange(focused, timeZone);
    }
    case 'month': {
      return monthGridRange(
        Temporal.PlainYearMonth.from(focused),
        Temporal.Now.plainDateISO(timeZone),
        timeZone,
      );
    }
    case 'week': {
      return weekRange(focused, timeZone);
    }
  }
};

const titleFor = (view: ViewKind, focused: Temporal.PlainDate): string => {
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
  const start = weekStart(focused);
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
  const [showSettings, setShowSettings] = useState(false);
  const [editorSeed, setEditorSeed] = useState<EditorSeed | null>(null);

  const range = useMemo(() => rangeFor(view, focused, timeZone), [view, focused, timeZone]);
  const events = useEventsInRange(range.startUtc, range.endUtc);
  const calendars = useCalendars();
  const accounts = useAccounts();
  const colorOf = useMemo(() => makeColorLookup(calendars), [calendars]);

  const step = (direction: 1 | -1) => {
    setFocused((current) =>
      view === 'month'
        ? current.add({ months: direction })
        : current.add({ days: direction * (view === 'week' ? 7 : 1) }),
    );
  };

  const days = useMemo(() => {
    if (view === 'day') {
      return [focused];
    }
    const start = weekStart(focused);
    return Array.from({ length: 7 }, (_, index) => start.add({ days: index }));
  }, [view, focused]);

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
          <h1 className="min-w-56 text-lg font-semibold">{titleFor(view, focused)}</h1>
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
              onClick={() => setFocused(Temporal.Now.plainDateISO(timeZone))}
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
                onClick={() => setView(kind)}
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
              setView('day');
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
            onSlotClick={(date, hour) => setEditorSeed({ initialDate: date, initialHour: hour })}
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
