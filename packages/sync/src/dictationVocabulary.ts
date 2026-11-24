import { dictationVocabulary, type DictationVocabulary, type EventRecord } from '@calendar/core';
import { ContactRepo, EventRepo } from '@calendar/db';
import { Clock, Effect } from 'effect';
import { DeviceContacts } from './deviceContacts.ts';
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
 * from it; dictation goes on with the rest.
 */
export const loadDictationVocabulary = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  const store = yield* EventRepo;
  const known = read.get(store);
  if (known && now - known.at < VOCABULARY_TTL_MS) {
    return known.vocabulary;
  }
  const events = yield* loadEventsInRange(now - VOCABULARY_HISTORY_MS, now).pipe(
    Effect.orElseSucceed((): ReadonlyArray<EventRecord> => []),
  );
  const google = yield* (yield* ContactRepo).listAll().pipe(Effect.orElseSucceed(() => []));
  const device = yield* (yield* DeviceContacts).list().pipe(Effect.orElseSucceed(() => []));
  const vocabulary = dictationVocabulary(events, [...google, ...device]);
  read.set(store, { at: now, vocabulary });
  return vocabulary;
});
