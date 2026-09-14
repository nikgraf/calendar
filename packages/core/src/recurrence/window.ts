import { EventRecord } from '../types.ts';
import { type EventInstance, expandRecurringEvent } from './expand.ts';

const masterKey = (accountId: string, calendarId: string, masterId: string): string =>
  `${accountId}\u0000${calendarId}\u0000${masterId}`;

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
  // Keyed by account + calendar + master id, not master id alone: event
  // ids are Google-global, so two accounts subscribed to one shared
  // calendar carry masters with identical ids, and an override of one
  // must not hide the other's occurrence.
  const shadowedByMaster = new Map<string, Set<number>>();
  for (const override of window.overrides) {
    if (override.recurringEventId !== undefined && override.originalStartUtc !== undefined) {
      const key = masterKey(override.accountId, override.calendarId, override.recurringEventId);
      let set = shadowedByMaster.get(key);
      if (!set) {
        set = new Set();
        shadowedByMaster.set(key, set);
      }
      set.add(override.originalStartUtc);
    }
  }

  const results: Array<EventRecord> = [...window.singles];

  for (const master of window.masters) {
    if (!master.recurrence || master.recurrence.length === 0) {
      continue;
    }
    let instances: ReadonlyArray<EventInstance>;
    try {
      instances = expandRecurringEvent(
        {
          endDate: master.endDate,
          endUtc: master.endUtc,
          id: master.id,
          isAllDay: master.isAllDay,
          recurrence: master.recurrence,
          startDate: master.startDate,
          startTimeZone: master.startTimeZone ?? 'UTC',
          startUtc: master.startUtc,
        },
        rangeStartUtc,
        rangeEndUtc,
        shadowedByMaster.get(masterKey(master.accountId, master.calendarId, master.id)),
      );
    } catch (error) {
      // One unparseable or runaway rule must not blank the whole window;
      // the rest of the calendar still renders and the caller can log it.
      onSkip?.(master, error);
      continue;
    }
    for (const instance of instances) {
      results.push(
        new EventRecord({
          ...master,
          endDate: instance.endDate,
          endUtc: instance.endUtc,
          id: `${master.id}__${instance.originalStartUtc}`,
          originalStartUtc: instance.originalStartUtc,
          recurrence: undefined,
          recurringEventId: master.id,
          startDate: instance.startDate,
          startUtc: instance.startUtc,
        }),
      );
    }
  }

  return results.sort((a, b) => a.startUtc - b.startUtc);
};
