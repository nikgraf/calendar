import {
  addDaysToPlainDate,
  changesFromSubscription,
  expandRecurringEvent,
  type StructuredRule,
  toRRuleLines,
  truncateRecurrence,
  toStructuredRules,
} from '@calendar/core';
import { Effect } from 'effect';
import {
  AppleCalendarAccessError,
  type AppleCalendarClientShape,
  AppleCalendarRequestError,
} from './client.ts';
import type {
  AppleCalendarJson,
  AppleEventJson,
  CalendarAuthorization,
  EventWrite,
  OccurrenceRef,
} from './protocol.ts';

/**
 * In-memory AppleCalendarClient for tests and the desktop e2e fixture
 * mode. It keeps series the way EventKit does — a master with rules,
 * occurrences detached by `thisEvent` edits, deleted occurrences — and
 * expands them with core's expander, so span semantics can be asserted:
 * `thisEvent` detaches one occurrence, `futureEvents` on a later
 * occurrence ends the series there and starts a new one, `futureEvents`
 * on the first occurrence rewrites the whole series.
 */
export interface FakeSeries {
  readonly deleted: Set<number>;
  readonly detached: Map<number, AppleEventJson>;
  /** The first occurrence (or the single event) — times, fields, calendar. */
  event: AppleEventJson;
  rules: Array<StructuredRule>;
}

export interface FakeAppleCalendarState {
  authorization: CalendarAuthorization;
  readonly calendars: Map<string, AppleCalendarJson>;
  readonly calls: Array<string>;
  /** Simulates EKEventStoreChanged. */
  readonly emitChange: () => void;
  nextId: number;
  readonly series: Map<string, FakeSeries>;
}

/** Seed shape: an event plus optional RRULE lines (the fake converts them). */
export interface FakeEventSeed {
  readonly event: AppleEventJson;
  readonly recurrence?: ReadonlyArray<string> | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const notFound = (what: string): never => {
  throw new Error(`notFound: ${what}`);
};

const applyWrite = (base: AppleEventJson, write: EventWrite, now: number): AppleEventJson => {
  const next: Record<string, unknown> = { ...base, updatedAt: now };
  for (const [key, value] of Object.entries(write)) {
    if (key === 'recurrence' || value === undefined) {
      continue;
    }
    if (value === null) {
      // Like the bridge: no relative alarms is an empty list, not an absent one.
      if (key === 'alarms') {
        next['alarms'] = [];
      } else {
        delete next[key];
      }
      continue;
    }
    next[key] = value;
  }
  // A changed location without coordinates drops the stale ones (the bridge does the same).
  if (write.location !== undefined && write.geo === undefined && write.location !== base.location) {
    delete next['geo'];
  }
  if (next['isAllDay'] === false) {
    delete next['startDate'];
    delete next['endDate'];
  }
  return next as unknown as AppleEventJson;
};

const zoneOf = (event: AppleEventJson): string => event.timeZone ?? 'UTC';

const isFirst = (series: FakeSeries, ref: OccurrenceRef): boolean =>
  ref.originalStartUtc === undefined ||
  series.rules.length === 0 ||
  ref.originalStartUtc === (series.event.occurrenceStartUtc ?? series.event.startUtc);

export const makeFakeAppleCalendarClient = (
  initial: {
    readonly authorization?: CalendarAuthorization;
    readonly calendars?: ReadonlyArray<AppleCalendarJson>;
    readonly events?: ReadonlyArray<FakeEventSeed>;
  } = {},
): { readonly client: AppleCalendarClientShape; readonly state: FakeAppleCalendarState } => {
  const changeListeners = new Set<() => void>();
  const state: FakeAppleCalendarState = {
    authorization: initial.authorization ?? 'fullAccess',
    calendars: new Map((initial.calendars ?? []).map((calendar) => [calendar.id, calendar])),
    calls: [],
    emitChange: () => {
      for (const listener of changeListeners) {
        listener();
      }
    },
    nextId: 1,
    series: new Map(
      (initial.events ?? []).map(({ event, recurrence }) => [
        event.id,
        {
          deleted: new Set<number>(),
          detached: new Map<number, AppleEventJson>(),
          event,
          rules: recurrence
            ? toStructuredRules(recurrence, event.isAllDay, event.timeZone ?? 'UTC').rules
            : [],
        },
      ]),
    ),
  };

  const guard = <A>(
    method: string,
    run: () => A,
  ): Effect.Effect<A, AppleCalendarAccessError | AppleCalendarRequestError> =>
    Effect.suspend((): Effect.Effect<A, AppleCalendarAccessError | AppleCalendarRequestError> => {
      state.calls.push(method);
      if (state.authorization !== 'fullAccess') {
        return Effect.fail(new AppleCalendarAccessError({ authorization: state.authorization }));
      }
      return Effect.try({
        catch: (error) =>
          new AppleCalendarRequestError({
            message: error instanceof Error ? error.message : String(error),
            method,
          }),
        try: run,
      });
    });

  /** Occurrences of one series overlapping [start, end), EventKit-shaped. */
  const occurrencesOf = (series: FakeSeries, start: number, end: number): Array<AppleEventJson> => {
    const { event } = series;
    if (series.rules.length === 0) {
      return event.startUtc < end && event.endUtc > start ? [event] : [];
    }
    const shadowed = new Set<number>([...series.deleted, ...series.detached.keys()]);
    const generated = expandRecurringEvent(
      {
        endDate: event.endDate,
        endUtc: event.endUtc,
        id: event.id,
        isAllDay: event.isAllDay,
        recurrence: toRRuleLines(series.rules, event.isAllDay),
        startDate: event.startDate,
        startTimeZone: zoneOf(event),
        startUtc: event.startUtc,
      },
      start,
      end,
      shadowed,
    ).map((instance): AppleEventJson => ({
      ...event,
      endDate: instance.endDate,
      endUtc: instance.endUtc,
      occurrenceStartUtc: instance.originalStartUtc,
      startDate: instance.startDate,
      startUtc: instance.startUtc,
    }));
    const detached = [...series.detached.values()].filter(
      (occurrence) => occurrence.startUtc < end && occurrence.endUtc > start,
    );
    return [...generated, ...detached];
  };

  const findSeries = (id: string): FakeSeries => state.series.get(id) ?? notFound(`event ${id}`);

  /** The occurrence a ref names, as it currently looks. */
  const occurrence = (series: FakeSeries, ref: OccurrenceRef): AppleEventJson => {
    if (ref.originalStartUtc === undefined || series.rules.length === 0) {
      return series.event;
    }
    const slot = ref.originalStartUtc;
    const detached = series.detached.get(slot);
    if (detached) {
      return detached;
    }
    if (series.deleted.has(slot)) {
      return notFound(`occurrence ${ref.id}@${slot}`);
    }
    const [match] = occurrencesOf(series, slot - DAY_MS, slot + DAY_MS).filter(
      (candidate) => candidate.occurrenceStartUtc === slot,
    );
    return match ?? notFound(`occurrence ${ref.id}@${slot}`);
  };

  /** Ends `series` before `slot`; returns the detached occurrences at/after it. */
  const truncateAt = (series: FakeSeries, slot: number): void => {
    const lines = truncateRecurrence(
      toRRuleLines(series.rules, series.event.isAllDay),
      slot,
      series.event.isAllDay,
      zoneOf(series.event),
    );
    series.rules = toStructuredRules(lines, series.event.isAllDay, zoneOf(series.event)).rules;
    for (const key of series.detached.keys()) {
      if (key >= slot) {
        series.detached.delete(key);
      }
    }
    for (const key of series.deleted) {
      if (key >= slot) {
        series.deleted.delete(key);
      }
    }
  };

  const newId = (): string => `ek-${String(state.nextId++)}`;

  const client: AppleCalendarClientShape = {
    changes: changesFromSubscription((listener) => {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    }),
    create: ({ calendarId, event }) =>
      guard('create', () => {
        if (!state.calendars.has(calendarId)) {
          notFound(`calendar ${calendarId}`);
        }
        const id = newId();
        const now = Date.now();
        const rules = event.recurrence ? [...event.recurrence] : [];
        const base: AppleEventJson = {
          alarms: [],
          calendarId,
          endUtc: event.endUtc ?? event.startUtc ?? now,
          hasRecurrence: rules.length > 0,
          id,
          isAllDay: event.isAllDay ?? false,
          isDetached: false,
          startUtc: event.startUtc ?? now,
          status: 'confirmed',
          title: event.title ?? '',
          updatedAt: now,
        };
        let created = applyWrite(base, event, now);
        if (rules.length > 0) {
          created = { ...created, occurrenceStartUtc: created.startUtc };
        }
        state.series.set(id, { deleted: new Set(), detached: new Map(), event: created, rules });
        return created;
      }),
    delete: ({ ref, span }) =>
      guard('delete', () => {
        const series = findSeries(ref.id);
        if (span === 'futureEvents' && isFirst(series, ref)) {
          state.series.delete(ref.id);
          return;
        }
        if (ref.originalStartUtc === undefined || series.rules.length === 0) {
          state.series.delete(ref.id);
          return;
        }
        occurrence(series, ref);
        if (span === 'futureEvents') {
          truncateAt(series, ref.originalStartUtc);
        } else {
          series.detached.delete(ref.originalStartUtc);
          series.deleted.add(ref.originalStartUtc);
        }
      }),
    events: ({ endUtc, startUtc }) =>
      guard('events', () =>
        [...state.series.values()]
          .flatMap((series) => occurrencesOf(series, startUtc, endUtc))
          .sort((a, b) => a.startUtc - b.startUtc),
      ),
    listCalendars: () => guard('listCalendars', () => [...state.calendars.values()]),
    move: ({ calendarId, id }) =>
      guard('move', () => {
        const target = state.calendars.get(calendarId) ?? notFound(`calendar ${calendarId}`);
        if (!target.allowsModifications) {
          throw new Error(`saveFailed: calendar ${calendarId} is read-only`);
        }
        const series = findSeries(id);
        series.event = { ...series.event, calendarId, updatedAt: Date.now() };
        for (const [slot, detached] of series.detached) {
          series.detached.set(slot, { ...detached, calendarId });
        }
        return series.event;
      }),
    requestAccess: () =>
      Effect.sync(() => {
        state.calls.push('requestAccess');
        if (state.authorization === 'notDetermined') {
          state.authorization = 'fullAccess';
        }
        return state.authorization === 'fullAccess';
      }),
    series: ({ id }) =>
      guard('series', () => {
        const series = findSeries(id);
        return { detachedCount: series.detached.size, first: series.event, rules: series.rules };
      }),
    setColor: ({ calendarId, colorHex }) =>
      guard('setColor', () => {
        const calendar = state.calendars.get(calendarId) ?? notFound(`calendar ${calendarId}`);
        if (!calendar.allowsModifications) {
          throw new Error(`unsupported: calendar ${calendarId} is read-only`);
        }
        state.calendars.set(calendarId, { ...calendar, colorHex });
      }),
    status: () =>
      Effect.sync(() => {
        state.calls.push('status');
        return state.authorization;
      }),
    update: ({ changes, ref, span }) =>
      guard('update', () => {
        const series = findSeries(ref.id);
        const now = Date.now();
        const current = occurrence(series, ref);
        if (series.rules.length === 0 || ref.originalStartUtc === undefined) {
          series.event = applyWrite(series.event, changes, now);
          if (changes.recurrence) {
            series.rules = [...changes.recurrence];
            series.event = {
              ...series.event,
              hasRecurrence: true,
              occurrenceStartUtc: series.event.startUtc,
            };
          }
          return series.event;
        }
        if (span === 'thisEvent') {
          const detached = {
            ...applyWrite(current, changes, now),
            isDetached: true,
            occurrenceStartUtc: ref.originalStartUtc,
          };
          series.detached.set(ref.originalStartUtc, detached);
          return detached;
        }
        if (isFirst(series, ref)) {
          const next = applyWrite(series.event, changes, now);
          series.event = { ...next, occurrenceStartUtc: next.startUtc };
          if (changes.recurrence !== undefined) {
            series.rules = changes.recurrence ? [...changes.recurrence] : [];
          }
          series.detached.clear();
          series.deleted.clear();
          return series.event;
        }
        // futureEvents from a later occurrence: EventKit ends the series
        // here and continues it as a new event from this occurrence on.
        // The continuation keeps the original rule (and its end); only the
        // old series is cut short.
        // A COUNT rule continues with the occurrences it had left.
        const slot = ref.originalStartUtc;
        const before =
          occurrencesOf(series, series.event.startUtc, slot).filter(
            (candidate) => (candidate.occurrenceStartUtc ?? candidate.startUtc) < slot,
          ).length + [...series.deleted].filter((key) => key < slot).length;
        const continued =
          changes.recurrence === undefined
            ? series.rules.map((rule) =>
                rule.count === undefined
                  ? rule
                  : { ...rule, count: Math.max(1, rule.count - before) },
              )
            : [...(changes.recurrence ?? [])];
        truncateAt(series, slot);
        const id = newId();
        const started = applyWrite({ ...current, id, isDetached: false }, changes, now);
        const event = { ...started, occurrenceStartUtc: started.startUtc };
        state.series.set(id, {
          deleted: new Set(),
          detached: new Map(),
          event,
          rules: continued,
        });
        return event;
      }),
  };
  return { client, state };
};

/** A fixture day as 'YYYY-MM-DD' → the exclusive end day of a one-day all-day event. */
export const nextDay = (isoDate: string): string => addDaysToPlainDate(isoDate, 1);
