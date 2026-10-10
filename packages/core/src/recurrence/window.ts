import { EventRecord } from '../types.ts';
import { type EventInstance, expandRecurringEvent, type RecurrenceMaster } from './expand.ts';

const masterKey = (accountId: string, calendarId: string, masterId: string): string =>
  `${accountId}\u0000${calendarId}\u0000${masterId}`;

/** What the expander reads of a stored master. */
export const recurrenceMasterOf = (master: EventRecord): RecurrenceMaster => ({
  endDate: master.endDate,
  endUtc: master.endUtc,
  id: master.id,
  isAllDay: master.isAllDay,
  recurrence: master.recurrence ?? [],
  startDate: master.startDate,
  startTimeZone: master.startTimeZone ?? 'UTC',
  startUtc: master.startUtc,
});

/**
 * The slots each series' overrides (cancelled ones included) take over:
 * the original starts its own expansion leaves out. Keyed by account +
 * calendar + master id, not master id alone: event ids are Google-global,
 * so two accounts subscribed to one shared calendar carry masters with
 * identical ids, and an override of one must not hide the other's
 * occurrence.
 */
export const overriddenSlots = (
  overrides: ReadonlyArray<EventRecord>,
): ((master: EventRecord) => ReadonlySet<number> | undefined) => {
  const slots = new Map<string, Set<number>>();
  for (const override of overrides) {
    if (override.recurringEventId !== undefined && override.originalStartUtc !== undefined) {
      const key = masterKey(override.accountId, override.calendarId, override.recurringEventId);
      let set = slots.get(key);
      if (!set) {
        set = new Set();
        slots.set(key, set);
      }
      set.add(override.originalStartUtc);
    }
  }
  return (master) => slots.get(masterKey(master.accountId, master.calendarId, master.id));
};

/**
 * A generated occurrence as the views carry it: the master's fields with
 * the instance's times, an `id` of `<masterId>__<originalStartUtc>`, and
 * `recurringEventId` + `originalStartUtc` naming its slot in the series.
 */
export const occurrenceRecord = (master: EventRecord, instance: EventInstance): EventRecord =>
  new EventRecord({
    ...master,
    endDate: instance.endDate,
    endUtc: instance.endUtc,
    id: drawnOccurrenceId(master.id, instance.originalStartUtc),
    originalStartUtc: instance.originalStartUtc,
    recurrence: undefined,
    recurringEventId: master.id,
    startDate: instance.startDate,
    startUtc: instance.startUtc,
  });

const drawnOccurrenceId = (masterId: string, originalStartUtc: number): string =>
  `${masterId}__${originalStartUtc}`;

/**
 * An occurrence the window drew from its master's rule, as opposed to a
 * stored exception (an occurrence edited on its own, under the
 * provider's own id), which keeps its own times through a series edit.
 */
export const isDrawnOccurrence = (
  event: Pick<EventRecord, 'id' | 'originalStartUtc' | 'recurringEventId'>,
): boolean =>
  event.recurringEventId !== undefined &&
  event.originalStartUtc !== undefined &&
  event.id === drawnOccurrenceId(event.recurringEventId, event.originalStartUtc);

/**
 * Assembles the renderable events for a range from a DB window: concrete
 * events pass through; recurring masters are expanded, with occurrences
 * shadowed by overrides (including cancelled ones) dropped. Expanded
 * instances are materialized as EventRecords carrying instance times and an
 * `id` of `<masterId>__<originalStartUtc>`.
 */
export const assembleWindow = (
  window: {
    readonly masters: ReadonlyArray<EventRecord>;
    readonly overrides: ReadonlyArray<EventRecord>;
    readonly singles: ReadonlyArray<EventRecord>;
  },
  rangeStartUtc: number,
  rangeEndUtc: number,
  /** Called for a master whose rule could not be expanded (it is left out). */
  onSkip?: (master: EventRecord, error: unknown) => void,
): Array<EventRecord> => {
  const slotsOf = overriddenSlots(window.overrides);
  const results: Array<EventRecord> = [...window.singles];

  for (const master of window.masters) {
    if (!master.recurrence || master.recurrence.length === 0) {
      continue;
    }
    let instances: ReadonlyArray<EventInstance>;
    try {
      instances = expandRecurringEvent(
        recurrenceMasterOf(master),
        rangeStartUtc,
        rangeEndUtc,
        slotsOf(master),
      );
    } catch (error) {
      // One unparseable or runaway rule must not blank the whole window;
      // the rest of the calendar still renders and the caller can log it.
      onSkip?.(master, error);
      continue;
    }
    for (const instance of instances) {
      results.push(occurrenceRecord(master, instance));
    }
  }

  return results.sort((a, b) => a.startUtc - b.startUtc);
};
