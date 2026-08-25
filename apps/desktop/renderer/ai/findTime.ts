import { parseFindTime, type LanguageModel } from '@calendar/ai';
import {
  findFreeSlots,
  plainDateToUtcMs,
  Temporal,
  type BackendClient,
  type FreeSlot,
} from '@calendar/core';
import { Effect } from 'effect';

export interface FindTimeOutcome {
  readonly slots: ReadonlyArray<FreeSlot>;
  readonly title?: string | undefined;
}

/**
 * The desktop twin of apps/ios/src/findTime.ts: parse the constraint
 * sentence, fetch the assembled event window, run the pure solver.
 */
export const makeFindSlots =
  (model: LanguageModel, backend: BackendClient, timeZone: string) =>
  async (phrase: string): Promise<FindTimeOutcome | { readonly reason: string }> => {
    const referenceDate = Temporal.Now.plainDateISO(timeZone).toString();
    const parsed = await parseFindTime(model, { phrase, referenceDate, timeZone });
    if (parsed.kind === 'rejected') {
      return { reason: parsed.reason };
    }
    const { constraints } = parsed;
    // Zone-exact bounds matter to the solver, not the fetch: a UTC-day
    // window padded by a day each side always covers the local window.
    const rangeStartUtc = plainDateToUtcMs(constraints.windowStartDate) - 24 * 60 * 60 * 1000;
    const rangeEndUtc = plainDateToUtcMs(constraints.windowEndDate) + 2 * 24 * 60 * 60 * 1000;
    let events;
    try {
      events = await Effect.runPromise(backend.getEventsInRange({ rangeEndUtc, rangeStartUtc }));
    } catch {
      return { reason: "Couldn't load your calendar — try again." };
    }
    const slots = findFreeSlots(events, constraints, { nowUtc: Date.now(), timeZone });
    return { slots, ...(parsed.title === undefined ? {} : { title: parsed.title }) };
  };
