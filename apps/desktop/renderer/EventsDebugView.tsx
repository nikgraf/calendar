import { Temporal, type EventRecord } from '@calendar/core';
import { Effect } from 'effect';
import { useCallback, useEffect, useState } from 'react';
import { backend } from './backend.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Interim M3 view: the next 7 days as a flat list, live-updated on sync. */
export function EventsDebugView() {
  const [events, setEvents] = useState<ReadonlyArray<EventRecord>>([]);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    const startOfToday = Temporal.Now.zonedDateTimeISO().startOfDay().toInstant().epochMilliseconds;
    try {
      setEvents(
        await Effect.runPromise(
          backend.getEventsInRange({
            rangeEndUtc: startOfToday + 7 * DAY_MS,
            rangeStartUtc: startOfToday,
          }),
        ),
      );
    } catch {
      // Errors are surfaced by the accounts view; keep the list as-is.
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks-js/set-state-in-effect
    void refresh();
    return window.calendarBridge.onChanged?.(() => void refresh());
  }, [refresh]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      await Effect.runPromise(backend.syncNow(undefined));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Next 7 days</h2>
        <button
          className="text-sm text-blue-600 hover:underline disabled:opacity-50"
          disabled={syncing}
          onClick={() => void syncNow()}
          type="button"
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      <ul className="mt-3 space-y-1 text-sm">
        {events.length === 0 ? <li className="text-neutral-400">No events in range.</li> : null}
        {events.map((event) => (
          <li className="flex gap-2" key={`${event.calendarId}:${event.id}`}>
            <span className="w-40 shrink-0 text-neutral-500">
              {event.isAllDay
                ? `${event.startDate} (all day)`
                : Temporal.Instant.fromEpochMilliseconds(event.startUtc)
                    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
                    .toPlainDateTime()
                    .toLocaleString('en-US', {
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      month: 'short',
                    })}
            </span>
            <span>{event.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
