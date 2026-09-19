import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { isNotFound, makeAppleCalendarClient } from './client.ts';

const failing = (message: string) =>
  makeAppleCalendarClient(() => Promise.reject(new Error(message)));

describe('makeAppleCalendarClient', () => {
  it('maps the bridge access prefix to the typed access error', async () => {
    const exit = await Effect.runPromiseExit(failing('accessDenied: writeOnly').listCalendars());
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain('AppleCalendarAccessError');
      expect(JSON.stringify(exit.cause)).toContain('writeOnly');
    }
  });

  it('unwraps the Expo envelope and recognises notFound', async () => {
    const client = failing(
      'FunctionCallException: Calling the invoke function failed → Caused by: AppleCalendarBridgeError: notFound: event ek-1',
    );
    const error = await Effect.runPromise(
      Effect.flip(client.delete({ ref: { id: 'ek-1' }, span: 'thisEvent' })),
    );
    expect(error._tag).toBe('AppleCalendarRequestError');
    expect(isNotFound(error)).toBe(true);
  });

  it('sends occurrence refs flat with the span', async () => {
    const calls: Array<[string, unknown]> = [];
    const client = makeAppleCalendarClient((method, params) => {
      calls.push([method, params]);
      return Promise.resolve({});
    });
    await Effect.runPromise(
      client.delete({ ref: { id: 'ek-1', originalStartUtc: 5 }, span: 'futureEvents' }),
    );
    expect(calls).toEqual([
      ['calendar.delete', { id: 'ek-1', originalStartUtc: 5, span: 'futureEvents' }],
    ]);
  });

  it('fails a malformed response instead of passing undefined fields on', async () => {
    const client = makeAppleCalendarClient(() => Promise.resolve({ events: [{ id: 1 }] }));
    const error = await Effect.runPromise(Effect.flip(client.events({ endUtc: 1, startUtc: 0 })));
    expect(error._tag).toBe('AppleCalendarRequestError');
  });
});
