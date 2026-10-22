import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { isNotFound, makeAppleCalendarClient } from './client.ts';

const failing = (message: string) =>
  makeAppleCalendarClient(() => Promise.reject(new Error(message)));

/**
 * A prompt answered with `granted`, while iOS still reports notDetermined
 * — refused the way the iOS module words it.
 */
const lagging = (granted: boolean) =>
  makeAppleCalendarClient((method) =>
    method === 'calendar.requestAccess'
      ? Promise.resolve({ granted })
      : Promise.reject(
          new Error(
            "FunctionCallException: Calling the 'invoke' function has failed\n→ Caused by: AppleCalendarBridgeError: accessDenied: notDetermined (at SolunivoAppleCalendar/SolunivoAppleCalendarModule.swift:26)",
          ),
        ),
  );

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

  it('trusts an answered prompt over a stale notDetermined status', async () => {
    const client = makeAppleCalendarClient((method) =>
      Promise.resolve(
        method === 'calendar.requestAccess'
          ? { granted: false }
          : { authorization: 'notDetermined' },
      ),
    );
    expect(await Effect.runPromise(client.requestAccess())).toBe(false);
    expect(await Effect.runPromise(client.status())).toBe('denied');
  });

  it('reads a refusal over that stale status after a granted prompt as a failed call, not lost access', async () => {
    // Never asked in this process: the refusal is what it says.
    const unasked = await Effect.runPromise(Effect.flip(lagging(true).listCalendars()));
    expect(unasked._tag).toBe('AppleCalendarAccessError');

    const granted = lagging(true);
    await Effect.runPromise(granted.requestAccess());
    const lag = await Effect.runPromise(Effect.flip(granted.listCalendars()));
    expect(lag._tag).toBe('AppleCalendarRequestError');
    expect(isNotFound(lag)).toBe(false);

    const denied = lagging(false);
    await Effect.runPromise(denied.requestAccess());
    const refused = await Effect.runPromise(Effect.flip(denied.listCalendars()));
    expect(refused._tag).toBe('AppleCalendarAccessError');
  });

  it('ends that grace once the system reports a definite status: a later notDetermined is a reset', async () => {
    let status = 'notDetermined';
    const client = makeAppleCalendarClient((method) => {
      if (method === 'calendar.requestAccess') {
        return Promise.resolve({ granted: true });
      }
      if (method === 'calendar.status') {
        return Promise.resolve({ authorization: status });
      }
      return status === 'fullAccess'
        ? Promise.resolve({ calendars: [] })
        : Promise.reject(new Error(`accessDenied: ${status}`));
    });
    await Effect.runPromise(client.requestAccess());
    // The system caught up …
    status = 'fullAccess';
    expect(await Effect.runPromise(client.status())).toBe('fullAccess');
    // … then access was reset with the app running (`tccutil reset` on a Mac).
    status = 'notDetermined';
    expect(await Effect.runPromise(client.status())).toBe('notDetermined');
    const reset = await Effect.runPromise(Effect.flip(client.listCalendars()));
    expect(reset._tag).toBe('AppleCalendarAccessError');
  });
});
