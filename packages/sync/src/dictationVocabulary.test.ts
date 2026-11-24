import { AppleCalendarRequestError } from '@calendar/apple-calendar';
import { Contact, EventRecord } from '@calendar/core';
import { ContactRepo, EventRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe } from 'vite-plus/test';
import { AppleCalendarEvents } from './appleCalendarEvents.ts';
import { DeviceContacts } from './deviceContacts.ts';
import { loadDictationVocabulary } from './dictationVocabulary.ts';

const contact = (displayName: string) =>
  new Contact({
    displayName,
    email: `${displayName}@example.com`,
    id: displayName,
    source: 'device',
  });

/** No stored events, one device contact, and EventKit failing until told not to. */
const setup = () => {
  const state = { appleFailing: true, contactReads: 0 };
  const layer = Layer.mergeAll(
    Layer.succeed(EventRepo, {
      getWindow: () =>
        Effect.succeed({
          masters: [],
          overrides: [],
          singles: [
            new EventRecord({
              accountId: 'acc',
              calendarId: 'cal',
              endUtc: -3_600_000,
              etag: null,
              id: 'lunch',
              isAllDay: false,
              location: 'Figlmüller, Wollzeile 5',
              startUtc: -7_200_000,
              status: 'confirmed',
              syncedAt: 0,
              syncStatus: 'synced',
              title: 'Lunch',
              updatedAt: 0,
            }),
          ],
        }),
    } as unknown as EventRepo['Service']),
    Layer.succeed(AppleCalendarEvents, {
      eventsInRangeOrFail: () =>
        state.appleFailing
          ? Effect.fail(new AppleCalendarRequestError({ message: 'timed out', method: 'events' }))
          : Effect.succeed([]),
    } as unknown as AppleCalendarEvents['Service']),
    Layer.succeed(ContactRepo, {
      listAll: () => Effect.succeed([]),
    } as unknown as ContactRepo['Service']),
    Layer.succeed(DeviceContacts, {
      birthdays: () => Effect.succeed([]),
      list: () => {
        state.contactReads += 1;
        return Effect.succeed([contact('Emily Carter')]);
      },
      refresh: () => Effect.void,
    } as unknown as DeviceContacts['Service']),
  );
  return { layer, state };
};

describe('loadDictationVocabulary', () => {
  it.effect('keeps a whole read for a while, and reads again after EventKit failed', () => {
    const { layer, state } = setup();
    return Effect.gen(function* () {
      // EventKit did not answer: Google's events and the contacts still count, and nothing is kept.
      expect(yield* loadDictationVocabulary).toEqual({
        people: ['Emily Carter'],
        places: ['Figlmüller'],
      });
      state.appleFailing = false;
      expect((yield* loadDictationVocabulary).people).toEqual(['Emily Carter']);
      // Kept now: the next phrase reads nothing again.
      expect((yield* loadDictationVocabulary).people).toEqual(['Emily Carter']);
      expect(state.contactReads).toBe(2);
    }).pipe(Effect.provide(layer));
  });
});
