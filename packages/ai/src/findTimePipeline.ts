import { parseFindTime } from './findTime.ts';
import type { LanguageModel } from './model.ts';
import { Effect } from 'effect';
import {
  findFreeSlots,
  plainDateToUtcMs,
  Temporal,
  type BackendClient,
  type FindSlotsConstraints,
  type FreeSlot,
} from '@calendar/core';

export interface FindTimeOutcome {
  readonly slots: ReadonlyArray<FreeSlot>;
  readonly title?: string | undefined;
}

/**
 * The search half of find-a-time, no model involved: the backend supplies
 * the assembled event window and the pure solver lists the free slots.
 * The event form's finder runs this from its presets; a parsed phrase
 * (`parseFindTime`) feeds the same constraints.
 */
export const findSlotsFor = async (
  backend: BackendClient,
  constraints: FindSlotsConstraints,
  timeZone: string,
): Promise<ReadonlyArray<FreeSlot> | { readonly reason: string }> => {
  // The zone-exact day bounds matter to the solver, not the fetch; a
  // UTC-day fetch window padded by a day on each side always covers the
  // local window.
  const rangeStartUtc = plainDateToUtcMs(constraints.windowStartDate) - 24 * 60 * 60 * 1000;
  const rangeEndUtc = plainDateToUtcMs(constraints.windowEndDate) + 2 * 24 * 60 * 60 * 1000;
  let events;
  try {
    // BackendClient methods are Effects; the app layer runs them.
    events = await Effect.runPromise(backend.getEventsInRange({ rangeEndUtc, rangeStartUtc }));
  } catch {
    return { reason: "Couldn't load your calendar — try again." };
  }
  return findFreeSlots(events, constraints, { nowUtc: Date.now(), timeZone });
};

/**
 * The whole find-a-time pipeline: the model parses the constraint
 * sentence, then `findSlotsFor` searches. Each stage stays independently
 * testable.
 */
export const makeFindSlots =
  (model: LanguageModel, backend: BackendClient, timeZone: string) =>
  async (phrase: string): Promise<FindTimeOutcome | { readonly reason: string }> => {
    const referenceDate = Temporal.Now.plainDateISO(timeZone).toString();
    const parsed = await parseFindTime(model, { phrase, referenceDate, timeZone });
    if (parsed.kind === 'rejected') {
      return { reason: parsed.reason };
    }
    const slots = await findSlotsFor(backend, parsed.constraints, timeZone);
    if ('reason' in slots) {
      return slots;
    }
    return { slots, ...(parsed.title === undefined ? {} : { title: parsed.title }) };
  };
