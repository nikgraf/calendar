import { EventRecord } from '../types.ts';
import { expandRecurringEvent } from './expand.ts';

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
): Array<EventRecord> => {
  const shadowedByMaster = new Map<string, Set<number>>();
  for (const override of window.overrides) {
    if (override.recurringEventId !== undefined && override.originalStartUtc !== undefined) {
      let set = shadowedByMaster.get(override.recurringEventId);
      if (!set) {
        set = new Set();
        shadowedByMaster.set(override.recurringEventId, set);
      }
      set.add(override.originalStartUtc);
    }
  }

  const results: Array<EventRecord> = [...window.singles];

  for (const master of window.masters) {
    if (!master.recurrence || master.recurrence.length === 0) {
      continue;
    }
    const instances = expandRecurringEvent(
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
      shadowedByMaster.get(master.id),
    );
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
