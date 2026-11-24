import { dictationVocabulary, type DictationVocabulary, type EventRecord } from '@calendar/core';
import { ContactRepo, EventRepo } from '@calendar/db';
import { Clock, Effect } from 'effect';
import { DeviceContacts } from './deviceContacts.ts';
import { AppleCalendarEvents } from './appleCalendarEvents.ts';
import { loadEventsInRange } from './eventsInRange.ts';

/** A year of events: the people met and the places been to. */
const VOCABULARY_HISTORY_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * Read again after this: every dictation asks for the names as it starts,
 * and a year of events is read once in a while, not on each phrase.
 */
export const VOCABULARY_TTL_MS = 5 * 60 * 1000;

const read = new WeakMap<object, { at: number; vocabulary: DictationVocabulary }>();

/**
 * The names dictation's Parakeet listens for (`dictationVocabulary` in
 * core): read from a year of events and both address books, at most once
 * per `VOCABULARY_TTL_MS`. A store that cannot be read gives no names
 * from it; dictation goes on with the rest, and the next phrase reads
 * again (a failed read is never kept).
 */
export const loadDictationVocabulary = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const store = yield* EventRepo;
  const known = read.get(store);
  if (known && now - known.at < VOCABULARY_TTL_MS) {
    return known.vocabulary;
  }
  let whole = true;
  const orNothing = <A>(fallback: A) =>
    Effect.orElseSucceed(() => {
      whole = false;
      return fallback;
    });
  // Google's rows and EventKit's apart: either failing leaves the other's
  // names, and EventKit's failure is told from no events (`OrFail`).
  const start = now - VOCABULARY_HISTORY_MS;
  const google = yield* loadEventsInRange(start, now, { apple: false }).pipe(
    orNothing<ReadonlyArray<EventRecord>>([]),
  );
  const apple = yield* (yield* AppleCalendarEvents)
    .eventsInRangeOrFail(start, now)
    .pipe(orNothing<ReadonlyArray<EventRecord>>([]));
  const events = [...google, ...apple];
  const saved = yield* (yield* ContactRepo).listAll().pipe(orNothing([]));
  // The device's contacts never fail: the last snapshot stands in for a failed read.
  const device = yield* (yield* DeviceContacts).list();
  const vocabulary = dictationVocabulary(events, [...saved, ...device]);
  if (whole) {
    read.set(store, { at: now, vocabulary });
  }
  return vocabulary;
});
