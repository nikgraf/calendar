import { parseFindTime } from './findTime.ts';
import type { LanguageModel } from './model.ts';
import { Effect } from 'effect';
import {
  type EventRecord,
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
  {
    exclude,
    maxSlots,
    preferredTime,
  }: {
    /** Rows that are not busy time: the event being rescheduled (its own occurrences). */
    readonly exclude?: ((event: EventRecord) => boolean) | undefined;
    /** How many slots to list; the solver's own ten by default. */
    readonly maxSlots?: number | undefined;
    /** Each gap's slot placed as near this wall-clock time as the gap allows. */
    readonly preferredTime?: string | undefined;
  } = {},
): Promise<ReadonlyArray<FreeSlot> | { readonly reason: string }> => {
  // The zone-exact day bounds matter to the solver, not the fetch; a
  // UTC-day fetch window padded by a day on each side always covers the
  // local window.
  const rangeStartUtc = plainDateToUtcMs(constraints.windowStartDate) - 24 * 60 * 60 * 1000;
  const rangeEndUtc = plainDateToUtcMs(constraints.windowEndDate) + 2 * 24 * 60 * 60 * 1000;
  let events;
  let accounts;
  try {
    // BackendClient methods are Effects; the app layer runs them. The
    // accounts' emails find a declined invitation the way the agent
    // gateway's free/busy does (`blocksTime`).
    [events, accounts] = await Effect.runPromise(
      Effect.all(
        [backend.getEventsInRange({ rangeEndUtc, rangeStartUtc }), backend.listAccounts(undefined)],
        {
          concurrency: 'unbounded',
        },
      ),
    );
  } catch {
    return { reason: "Couldn't load your calendar — try again." };
  }
  return findFreeSlots(exclude ? events.filter((event) => !exclude(event)) : events, constraints, {
    accountEmails: new Map(accounts.map((account) => [account.id, account.email])),
    maxSlots,
    nowUtc: Date.now(),
    preferredTime,
    timeZone,
  });
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
