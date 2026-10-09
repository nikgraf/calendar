import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vite-plus/test';
import {
  type LiveGoogleError,
  liveGoogleConfigFromEnv,
  LiveScratch,
  type LiveScratchShape,
} from '../testing/liveGoogle.ts';
import { deletedStatus, GONE, hoursFromNow, httpStatus, scratchFor, titleFor } from './support.ts';

/**
 * What a calendar mirror relies on, against the real Calendar API: a copy
 * is written under an id the mirror derives (so a second device's insert
 * is a 409, never a duplicate), carries its marker in a private extended
 * property, is updated by full replace (PATCH cannot clear a field the
 * user switched off) and can come back after it was deleted.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config);
const calendar = () => scratch.calendars[0]!;

const MARKER_KEY = 'solunivo.mirror';

const hex = (length: number): string =>
  Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');

/** The mirror's id shape: a fixed base32hex prefix plus 40 hex characters. */
const copyId = (): string => `slnvmr${hex(40)}`;

const copyBody = (name: string, hour: number, extra: Record<string, unknown> = {}) => ({
  end: { dateTime: new Date(hoursFromNow(hour + 1)).toISOString(), timeZone: 'Europe/Vienna' },
  extendedProperties: { private: { [MARKER_KEY]: '1700000000000.abcdef0123456789' } },
  reminders: { useDefault: false },
  start: { dateTime: new Date(hoursFromNow(hour)).toISOString(), timeZone: 'Europe/Vienna' },
  summary: titleFor(config, name),
  ...extra,
});

/** 'ok', or how Google refused: `http <status>` (a token failure reads as its tag). */
const outcome = <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E | LiveGoogleError>,
): Effect.Effect<string> =>
  effect.pipe(
    Effect.map(() => 'ok'),
    Effect.catch((error) =>
      Effect.succeed(
        error._tag === 'LiveGoogleError'
          ? `http ${httpStatus(error as LiveGoogleError)}`
          : error._tag,
      ),
    ),
  );

/** These probes need no engine or database: just the scratch service over the live wire. */
const run = <A, E>(body: (google: LiveScratchShape) => Effect.Effect<A, E>) =>
  Effect.promise(() => scratch.run(Effect.flatMap(LiveScratch, body)));

describe('live Google: mirror copies', () => {
  it.live('a copy keeps its derived id, its marker and an empty reminder list', () =>
    run((google) =>
      Effect.gen(function* () {
        const id = copyId();
        yield* google.insertEvent(calendar(), { ...copyBody('copy', 2), id });
        const server = yield* google.getEvent(calendar(), id);
        expect(server.id).toBe(id);
        expect(server.extendedProperties?.private?.[MARKER_KEY]).toBe(
          '1700000000000.abcdef0123456789',
        );
        expect(server.reminders?.useDefault).toBe(false);
        expect(server.reminders?.overrides ?? []).toEqual([]);
        expect(server.attendees ?? []).toEqual([]);
      }),
    ),
  );

  it.live('a full replace clears what the body leaves out; a patch does not', () =>
    run((google) =>
      Effect.gen(function* () {
        const id = copyId();
        yield* google.insertEvent(calendar(), {
          ...copyBody('replace', 4, { description: 'Dial-in 1234', location: 'Room 4' }),
          id,
        });
        yield* google.patchEvent(calendar(), id, { summary: titleFor(config, 'replace-patched') });
        const patched = yield* google.getEvent(calendar(), id);
        expect(patched.location).toBe('Room 4');

        yield* google.putEvent(calendar(), id, copyBody('replace-put', 4));
        const replaced = yield* google.getEvent(calendar(), id);
        expect(replaced.summary).toBe(titleFor(config, 'replace-put'));
        expect(replaced.location).toBeUndefined();
        expect(replaced.description).toBeUndefined();
        expect(replaced.extendedProperties?.private?.[MARKER_KEY]).toBeTruthy();
      }),
    ),
  );

  it.live('a deleted copy keeps its id reserved and comes back by full replace', () =>
    run((google) =>
      Effect.gen(function* () {
        const id = copyId();
        yield* google.insertEvent(calendar(), { ...copyBody('revive', 6), id });
        yield* google.deleteEvent(calendar(), id);
        expect(GONE.has(yield* deletedStatus(google, calendar(), id))).toBe(true);

        const reinsert = yield* outcome(
          google.insertEvent(calendar(), { ...copyBody('revive', 6), id }),
        );
        const put = yield* outcome(
          google.putEvent(calendar(), id, { ...copyBody('revived', 6), status: 'confirmed' }),
        );
        const after = yield* deletedStatus(google, calendar(), id);
        // One line with everything the mirror's 409 path depends on.
        yield* Effect.log(`mirror revive: reinsert=${reinsert} put=${put} status=${after}`);
        expect(reinsert).toBe('http 409');
        expect(put).toBe('ok');
        expect(after).toBe('confirmed');
        const server = yield* google.getEvent(calendar(), id);
        expect(server.summary).toBe(titleFor(config, 'revived'));
      }),
    ),
  );

  it.live('a second delete of a deleted copy answers gone, not an error to retry', () =>
    run((google) =>
      Effect.gen(function* () {
        const id = copyId();
        yield* google.insertEvent(calendar(), { ...copyBody('twice', 8), id });
        yield* google.deleteEvent(calendar(), id);
        const second = yield* outcome(google.deleteEvent(calendar(), id));
        yield* Effect.log(`mirror second delete: ${second}`);
        expect(['http 404', 'http 410']).toContain(second);
      }),
    ),
  );
});
