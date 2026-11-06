import {
  addDaysToPlainDate,
  applyWallClockDelta,
  changesFromSubscription,
  expandRecurringEvent,
  plainDateToUtcMs,
  type StructuredRule,
  toRRuleLines,
  truncateRecurrence,
  toStructuredRules,
} from '@calendar/core';
import { Effect } from 'effect';
import type { AppleCalendarBridgeShape, AppleCalendarClientShape } from './client.ts';
import { AppleCalendarAccessError, AppleCalendarRequestError } from './errors.ts';
import { appleDetachedId, appleRecurrenceSuffix } from './identity.ts';
import {
  APPLE_BATCH_MAX,
  APPLE_WRITE_REACH_MS,
  type AppleCalendarJson,
  type AppleEventJson,
  type CalendarAuthorization,
  type EventWrite,
  type OccurrenceRef,
} from './protocol.ts';
import { withSeriesIdentity } from './seriesIdentity.ts';

/**
 * In-memory EventKit for tests and the desktop e2e fixture mode: it
 * answers like the bridge, identifiers included, and is wrapped in the
 * same layer the real bridge is (`withSeriesIdentity`), so every test
 * runs through the production handling of those identifiers. `bridge` is
 * the unwrapped fake, for tests of that layer.
 *
 * It keeps series the way EventKit does — a master with rules,
 * occurrences detached by `thisEvent` edits, deleted occurrences — and
 * expands them with core's expander. What it models was probed on a real
 * store (docs/google-sync-and-testing.md → Apple Calendar):
 *
 * - An occurrence the rule draws carries the series id. One changed on
 *   its own carries `<series id>/RID=<n>` and no rules; that id alone
 *   finds it wherever it sits, and the series id with its slot does not.
 * - The series id alone answers the master: the first occurrence as the
 *   rule draws it, also when that occurrence was moved or deleted.
 * - `thisEvent` detaches one occurrence. `futureEvents` on a later one
 *   (drawn or detached) ends the series before its slot and starts a new
 *   one there, taking the later detached occurrences along; on the first
 *   one (drawn or detached), or on the series id, it writes the whole
 *   series in place and keeps the detached occurrences.
 * - A lookup by slot matches the identifier exactly and reaches
 *   `APPLE_WRITE_REACH_MS` either side, while a range read returns an
 *   occurrence wherever it sits.
 */
export interface FakeSeries {
  /** Slots of occurrences removed on their own. */
  readonly deleted: Set<number>;
  /**
   * Occurrences changed on their own, by slot. Each carries the id
   * EventKit gave it when it was detached, never the series'.
   */
  readonly detached: Map<number, AppleEventJson>;
  /** The first occurrence as the rule draws it (or the single event) — times, fields, calendar. */
  event: AppleEventJson;
  rules: Array<StructuredRule>;
}

export interface FakeAppleCalendarState {
  authorization: CalendarAuthorization;
  readonly calendars: Map<string, AppleCalendarJson>;
  /** The bridge calls made, by method. */
  readonly calls: Array<string>;
  /** Simulates EKEventStoreChanged. */
  readonly emitChange: () => void;
  nextId: number;
  /** By series (or single event) id. */
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
  // Like EventKit, an all-day event's instants follow its days (the bridge
  // reports local midnight; the fake uses UTC midnight, a fixed zone).
  if (next['isAllDay'] === true && typeof next['startDate'] === 'string') {
    next['startUtc'] = plainDateToUtcMs(next['startDate']);
    if (typeof next['endDate'] === 'string') {
      next['endUtc'] = plainDateToUtcMs(next['endDate']);
    }
  }
  return next as unknown as AppleEventJson;
};

const zoneOf = (event: AppleEventJson): string => event.timeZone ?? 'UTC';

const firstSlot = (series: FakeSeries): number =>
  series.event.occurrenceStartUtc ?? series.event.startUtc;

/** What the rule draws in [start, end), whatever was changed or deleted since unless `shadowed`. */
const drawnOf = (
  series: FakeSeries,
  start: number,
  end: number,
  shadowed: ReadonlySet<number>,
): Array<AppleEventJson> => {
  const { event } = series;
  return expandRecurringEvent(
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
};

/** Occurrences of one series overlapping [start, end), EventKit-shaped. */
const occurrencesOf = (series: FakeSeries, start: number, end: number): Array<AppleEventJson> => {
  const { event } = series;
  if (series.rules.length === 0) {
    return event.startUtc < end && event.endUtc > start ? [event] : [];
  }
  const shadowed = new Set<number>([...series.deleted, ...series.detached.keys()]);
  const detached = [...series.detached.values()].filter(
    (occurrence) => occurrence.startUtc < end && occurrence.endUtc > start,
  );
  return [...drawnOf(series, start, end, shadowed), ...detached];
};

/** The occurrence the rule draws at `slot`, as if nothing had been changed or deleted there. */
const drawnAt = (series: FakeSeries, slot: number): AppleEventJson | undefined =>
  drawnOf(series, slot - DAY_MS, slot + DAY_MS, new Set()).find(
    (candidate) => candidate.occurrenceStartUtc === slot,
  );

/** Ends `series` before `slot`: what was detached or deleted from there on goes with it. */
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

/** A detached occurrence's identifiers under (another) series, its `/RID=` part kept. */
const underSeries = (occurrence: AppleEventJson, master: AppleEventJson): AppleEventJson => {
  const suffix = appleRecurrenceSuffix(occurrence.id);
  const { externalId: _externalId, ...rest } = occurrence;
  return {
    ...rest,
    ...(master.externalId === undefined ? {} : { externalId: `${master.externalId}${suffix}` }),
    id: `${master.id}${suffix}`,
  };
};

/** The fields a series-wide write carries over to a detached occurrence that still has the series' value. */
const SERIES_FIELDS = [
  'alarms',
  'description',
  'geo',
  'location',
  'timeZone',
  'title',
  'url',
] as const;

/**
 * Where a slot lands when its series' start moves from `from` to `to`: by
 * the wall clock of the series' zone, as the rule's own slots do — a fixed
 * number of hours would miss them across a DST change.
 */
const slotAfter = (slot: number, zone: string, from: number, to: number): number =>
  from === to ? slot : applyWallClockDelta(slot, zone, from, to);

/**
 * A detached occurrence after its series' time moved: its slot is `to`,
 * and its own time follows while it still sat on its slot. The identifier
 * keeps its `/RID=`.
 */
const atSlot = (occurrence: AppleEventJson, slot: number, to: number): AppleEventJson => ({
  ...occurrence,
  occurrenceStartUtc: to,
  ...(to !== slot && occurrence.startUtc === slot
    ? { endUtc: to + (occurrence.endUtc - occurrence.startUtc), startUtc: to }
    : {}),
});

/**
 * A write to the series as a whole (or to a single event). Detached
 * occurrences stay: each takes a field the write changed on the series
 * while it still had the series' value (EventKit leaves out one that was
 * moved past the series' end; the fake does not tell), and each follows a
 * time change (`atSlot`). A time change also brings back the occurrences
 * deleted on their own (their exclusion keeps the old time).
 */
const writeWhole = (series: FakeSeries, changes: EventWrite, now: number): AppleEventJson => {
  const before = series.event;
  const written = applyWrite(before, changes, now);
  if (changes.recurrence !== undefined) {
    series.rules = changes.recurrence ? [...changes.recurrence] : [];
  }
  const { occurrenceStartUtc: _slot, ...single } = written;
  series.event =
    series.rules.length > 0
      ? { ...written, hasRecurrence: true, occurrenceStartUtc: written.startUtc }
      : { ...single, hasRecurrence: false };
  const zone = zoneOf(series.event);
  const kept = [...series.detached];
  series.detached.clear();
  for (const [slot, occurrence] of kept) {
    const next: Record<string, unknown> = { ...occurrence };
    for (const field of SERIES_FIELDS) {
      // What the write changed on the series, coordinates dropped with a
      // new location included.
      const was = JSON.stringify(before[field]);
      if (
        JSON.stringify(series.event[field]) !== was &&
        JSON.stringify(occurrence[field]) === was
      ) {
        if (series.event[field] === undefined) {
          delete next[field];
        } else {
          next[field] = series.event[field];
        }
      }
    }
    const to = slotAfter(slot, zone, before.startUtc, series.event.startUtc);
    series.detached.set(to, atSlot(next as unknown as AppleEventJson, slot, to));
  }
  if (series.event.startUtc !== before.startUtc) {
    series.deleted.clear();
  }
  return series.event;
};

/** What a ref names. */
type Target =
  | { readonly key: string; readonly kind: 'whole'; readonly series: FakeSeries }
  | {
      readonly event: AppleEventJson;
      readonly key: string;
      readonly kind: 'detached' | 'drawn';
      readonly series: FakeSeries;
      readonly slot: number;
    };

export const makeFakeAppleCalendarClient = (
  initial: {
    readonly authorization?: CalendarAuthorization;
    readonly calendars?: ReadonlyArray<AppleCalendarJson>;
    readonly events?: ReadonlyArray<FakeEventSeed>;
  } = {},
): {
  /** The fake as the bridge answers: EventKit's own identifiers. */
  readonly bridge: AppleCalendarBridgeShape;
  readonly client: AppleCalendarClientShape;
  readonly state: FakeAppleCalendarState;
} => {
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

  const newId = (): string => `ek-${String(state.nextId++)}`;

  /** `store.event(withIdentifier:)`: a series or single event, or one detached occurrence. */
  const byId = (
    id: string,
  ): { readonly key: string; readonly series: FakeSeries; readonly slot?: number } | undefined => {
    const series = state.series.get(id);
    if (series) {
      return { key: id, series };
    }
    for (const [key, candidate] of state.series) {
      for (const [slot, occurrence] of candidate.detached) {
        if (occurrence.id === id) {
          return { key, series: candidate, slot };
        }
      }
    }
    return undefined;
  };

  /**
   * The event a ref names, found the way the bridge finds it. By id
   * alone: whatever carries that identifier. By slot too: among what
   * overlaps `APPLE_WRITE_REACH_MS` either side of the slot, the event
   * with exactly that identifier and slot — so the series id finds an
   * occurrence the rule draws, never one changed on its own.
   */
  const target = (ref: OccurrenceRef): Target => {
    const found = byId(ref.id) ?? notFound(`event ${ref.id}`);
    const { key, series } = found;
    const slot = ref.originalStartUtc;
    if (found.slot !== undefined) {
      const event = series.detached.get(found.slot) ?? notFound(`event ${ref.id}`);
      if (
        slot !== undefined &&
        (event.occurrenceStartUtc !== slot ||
          event.startUtc >= slot + APPLE_WRITE_REACH_MS ||
          event.endUtc <= slot - APPLE_WRITE_REACH_MS)
      ) {
        notFound(`occurrence ${ref.id}@${slot}`);
      }
      return { event, key, kind: 'detached', series, slot: found.slot };
    }
    if (slot === undefined || series.rules.length === 0) {
      return { key, kind: 'whole', series };
    }
    const event =
      (series.deleted.has(slot) || series.detached.has(slot) ? undefined : drawnAt(series, slot)) ??
      notFound(`occurrence ${ref.id}@${slot}`);
    return { event, key, kind: 'drawn', series, slot };
  };

  /**
   * `futureEvents` from an occurrence after the first: EventKit ends the
   * series before its slot and continues it as a new event from there.
   * The continuation keeps the rule (a COUNT rule the occurrences it had
   * left) unless the write brings one, starts at the slot — or where the
   * write puts the occurrence — and takes the later detached occurrences
   * along (moved with it, when the write changed the time: not probed,
   * modelled on a series-wide time change). A detached occurrence it was
   * saved from stays detached, as the new series' first.
   */
  const split = (
    series: FakeSeries,
    at: Extract<Target, { kind: 'detached' | 'drawn' }>,
    changes: EventWrite,
    now: number,
  ): AppleEventJson => {
    const { slot } = at;
    const before = drawnOf(series, firstSlot(series), slot, new Set()).filter(
      (candidate) => (candidate.occurrenceStartUtc ?? candidate.startUtc) < slot,
    ).length;
    const continued =
      changes.recurrence === undefined
        ? series.rules.map((rule) =>
            rule.count === undefined ? rule : { ...rule, count: Math.max(1, rule.count - before) },
          )
        : [...(changes.recurrence ?? [])];
    const drawn = at.kind === 'drawn' ? at.event : (drawnAt(series, slot) ?? at.event);
    const later = [...series.detached].filter(([key]) => key > slot);
    truncateAt(series, slot);
    const id = newId();
    const { externalId: _externalId, ...fields } = drawn;
    const started = applyWrite(
      {
        ...fields,
        ...(drawn.externalId === undefined ? {} : { externalId: `ext-${id}` }),
        id,
        isDetached: false,
      },
      changes,
      now,
    );
    const event = {
      ...started,
      hasRecurrence: continued.length > 0,
      occurrenceStartUtc: started.startUtc,
    };
    // The new series may start elsewhere than the slot (the write moved
    // the occurrence): the later detached occurrences follow, as they do
    // through a series-wide time change.
    const detached = new Map(
      later.map(([key, occurrence]) => {
        const to = slotAfter(key, zoneOf(event), slot, event.startUtc);
        return [to, underSeries(atSlot(occurrence, key, to), event)];
      }),
    );
    const saved =
      at.kind === 'detached'
        ? {
            ...underSeries(applyWrite(at.event, changes, now), event),
            occurrenceStartUtc: event.startUtc,
          }
        : undefined;
    if (saved) {
      detached.set(event.startUtc, saved);
    }
    state.series.set(id, { deleted: new Set(), detached, event, rules: continued });
    return saved ?? event;
  };

  const bridge: AppleCalendarBridgeShape = {
    // Each write runs like its single-call sibling; one that cannot be made
    // is reported by index and the rest still land, as in the bridge.
    applyBatch: ({ ops }) =>
      Effect.gen(function* () {
        if (ops.length > APPLE_BATCH_MAX) {
          return yield* new AppleCalendarRequestError({
            message: `badRequest: ops: at most ${APPLE_BATCH_MAX}`,
            method: 'applyBatch',
          });
        }
        const failures: Array<{ index: number; message: string }> = [];
        for (const [index, op] of ops.entries()) {
          const write =
            op.kind === 'create'
              ? bridge.create({ calendarId: op.calendarId, event: op.event })
              : op.kind === 'update'
                ? bridge.update({ changes: op.changes, ref: op.ref, span: 'thisEvent' })
                : bridge.delete({ ref: op.ref, span: 'thisEvent' });
          const failure = yield* write.pipe(
            Effect.as(undefined),
            Effect.catchTag('AppleCalendarRequestError', (error) => Effect.succeed(error.message)),
          );
          if (failure !== undefined) {
            failures.push({ index, message: failure });
          }
        }
        state.calls.push('applyBatch');
        return failures;
      }),
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
          // EventKit hands out both; only this one is the same on every device.
          externalId: `ext-${id}`,
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
    createCalendar: ({ title }) =>
      guard('createCalendar', () => {
        const calendar: AppleCalendarJson = {
          allowsModifications: true,
          id: `ek-cal-${String(state.nextId++)}`,
          isDefault: false,
          sourceTitle: 'iCloud',
          sourceType: 'calDAV',
          title,
          type: 'calDAV',
        };
        state.calendars.set(calendar.id, calendar);
        return calendar;
      }),
    delete: ({ ref, span }) =>
      guard('delete', () => {
        // Like the bridge: the event is found before anything is removed.
        const at = target(ref);
        if (at.kind === 'whole' || (span === 'futureEvents' && at.slot === firstSlot(at.series))) {
          state.series.delete(at.key);
          return;
        }
        if (span === 'futureEvents') {
          truncateAt(at.series, at.slot);
        } else {
          at.series.detached.delete(at.slot);
          at.series.deleted.add(at.slot);
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
        const destination = state.calendars.get(calendarId) ?? notFound(`calendar ${calendarId}`);
        if (!destination.allowsModifications) {
          throw new Error(`saveFailed: calendar ${calendarId} is read-only`);
        }
        // A detached occurrence's id moves its whole series too.
        const found = byId(id) ?? notFound(`event ${id}`);
        const { series } = found;
        series.event = { ...series.event, calendarId, updatedAt: Date.now() };
        for (const [slot, detached] of series.detached) {
          series.detached.set(slot, { ...detached, calendarId });
        }
        return (
          (found.slot === undefined ? undefined : series.detached.get(found.slot)) ?? series.event
        );
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
        const found = byId(id) ?? notFound(`event ${id}`);
        const occurrence =
          found.slot === undefined ? undefined : found.series.detached.get(found.slot);
        // The bridge counts the events that carry the series id and are
        // detached. No event is both, so its count is 0.
        return occurrence
          ? { detachedCount: 0, first: occurrence, rules: [] }
          : { detachedCount: 0, first: found.series.event, rules: found.series.rules };
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
        const at = target(ref);
        const now = Date.now();
        if (at.kind === 'whole') {
          return writeWhole(at.series, changes, now);
        }
        if (span === 'thisEvent') {
          const master = at.series.event;
          const detached: AppleEventJson =
            at.kind === 'detached'
              ? applyWrite(at.event, changes, now)
              : {
                  ...applyWrite(at.event, changes, now),
                  ...(master.externalId === undefined
                    ? {}
                    : { externalId: appleDetachedId(master.externalId, at.slot) }),
                  hasRecurrence: false,
                  id: appleDetachedId(master.id, at.slot),
                  isDetached: true,
                  occurrenceStartUtc: at.slot,
                };
          at.series.detached.set(at.slot, detached);
          return detached;
        }
        if (at.slot !== firstSlot(at.series)) {
          return split(at.series, at, changes, now);
        }
        // On the series' first occurrence futureEvents writes the series in
        // place, whether the rule draws that occurrence or it was changed on
        // its own — which then stays detached and takes the write itself.
        const written = writeWhole(at.series, changes, now);
        if (at.kind === 'drawn') {
          return written;
        }
        const first = firstSlot(at.series);
        const saved = {
          ...applyWrite(at.series.detached.get(first) ?? at.event, changes, now),
          occurrenceStartUtc: first,
        };
        at.series.detached.set(first, saved);
        return saved;
      }),
  };
  return { bridge, client: withSeriesIdentity(bridge), state };
};

/** A fixture day as 'YYYY-MM-DD' → the exclusive end day of a one-day all-day event. */
export const nextDay = (isoDate: string): string => addDaysToPlainDate(isoDate, 1);
