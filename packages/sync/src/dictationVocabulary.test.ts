import { Contact } from '@calendar/core';
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

/** Stores with no events and no Google contacts; device contacts that fail until told not to. */
const setup = () => {
  const state = { failing: true, reads: 0 };
  const layer = Layer.mergeAll(
    Layer.succeed(EventRepo, {
      getWindow: () => Effect.succeed({ masters: [], overrides: [], singles: [] }),
    } as unknown as EventRepo['Service']),
    Layer.succeed(AppleCalendarEvents, {
      eventsInRange: () => Effect.succeed([]),
    } as unknown as AppleCalendarEvents['Service']),
    Layer.succeed(ContactRepo, {
      listAll: () => Effect.succeed([]),
    } as unknown as ContactRepo['Service']),
    Layer.succeed(DeviceContacts, {
      birthdays: () => Effect.succeed([]),
      list: () => {
        state.reads += 1;
        return state.failing
          ? Effect.fail(new Error('helper restarting') as never)
          : Effect.succeed([contact('Emily Carter')]);
      },
      refresh: () => Effect.void,
    } as unknown as DeviceContacts['Service']),
  );
  return { layer, state };
};

describe('loadDictationVocabulary', () => {
  it.effect('keeps a whole read for a while, and reads again after a failed one', () => {
    const { layer, state } = setup();
    return Effect.gen(function* () {
      // The device's contacts could not be read: the rest goes on, and nothing is kept.
      expect((yield* loadDictationVocabulary).people).toEqual([]);
      state.failing = false;
      expect((yield* loadDictationVocabulary).people).toEqual(['Emily Carter']);
      // Kept now: the next phrase does not read the address book again.
      expect((yield* loadDictationVocabulary).people).toEqual(['Emily Carter']);
      expect(state.reads).toBe(2);
    }).pipe(Effect.provide(layer));
  });
});
