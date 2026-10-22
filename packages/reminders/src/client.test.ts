import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { bridgeMessage } from '@calendar/core';
import { makeRemindersClient } from './client.ts';

describe('bridgeMessage', () => {
  it('passes the helper wire message through and unwraps the Expo exception envelope', () => {
    expect(bridgeMessage('accessDenied: denied')).toBe('accessDenied: denied');
    expect(
      bridgeMessage(
        "FunctionCallException: Calling the 'invoke' function has failed\n→ Caused by: RemindersBridgeError: accessDenied: denied",
      ),
    ).toBe('accessDenied: denied');
    expect(bridgeMessage('Something → Caused by: notFound: abc')).toBe('notFound: abc');
  });

  it('drops the throw site expo-modules-core appends', () => {
    expect(
      bridgeMessage(
        "FunctionCallException: Calling the 'invoke' function has failed\n→ Caused by: RemindersBridgeError: accessDenied: notDetermined (at SolunivoReminders/SolunivoRemindersModule.swift:36)",
      ),
    ).toBe('accessDenied: notDetermined');
    // A parenthesis of the message's own stays.
    expect(bridgeMessage('notFound: rem-1 (list gone)')).toBe('notFound: rem-1 (list gone)');
  });
});

const clientRejectingWith = (message: string) =>
  makeRemindersClient(() => Promise.reject(new Error(message)));

/**
 * A prompt answered with `granted`, while iOS still reports notDetermined
 * — refused the way the iOS module words it.
 */
const lagging = (granted: boolean) =>
  makeRemindersClient((method) =>
    method === 'reminders.requestAccess'
      ? Promise.resolve({ granted })
      : Promise.reject(
          new Error(
            "FunctionCallException: Calling the 'invoke' function has failed\n→ Caused by: RemindersBridgeError: accessDenied: notDetermined (at SolunivoReminders/SolunivoRemindersModule.swift:36)",
          ),
        ),
  );

const failure = async (client: ReturnType<typeof makeRemindersClient>) => {
  const result = await Effect.runPromise(Effect.result(client.listLists()));
  return result._tag === 'Failure' ? result.failure : undefined;
};

describe('makeRemindersClient error mapping', () => {
  it('maps an access failure to RemindersAccessError on both transports', async () => {
    for (const message of [
      'accessDenied: denied',
      "FunctionCallException: Calling the 'invoke' function has failed\n→ Caused by: RemindersBridgeError: accessDenied: restricted",
    ]) {
      const result = await Effect.runPromise(
        Effect.result(clientRejectingWith(message).listLists()),
      );
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('RemindersAccessError');
        expect(result.failure._tag === 'RemindersAccessError' && result.failure.authorization).toBe(
          message.endsWith('denied') ? 'denied' : 'restricted',
        );
      }
    }
  });

  it('keeps other bridge errors as RemindersRequestError with the unwrapped message', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        clientRejectingWith('X → Caused by: RemindersBridgeError: notFound: rem-1').delete({
          id: 'rem-1',
        }),
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('RemindersRequestError');
      expect(result.failure._tag === 'RemindersRequestError' && result.failure.message).toBe(
        'notFound: rem-1',
      );
    }
  });

  it('trusts an answered prompt over a stale notDetermined status', async () => {
    let status = 'notDetermined';
    const client = makeRemindersClient((method) =>
      Promise.resolve(
        method === 'reminders.requestAccess' ? { granted: true } : { authorization: status },
      ),
    );
    expect(await Effect.runPromise(client.status())).toBe('notDetermined');
    expect(await Effect.runPromise(client.requestAccess())).toBe(true);
    // iOS has not written the grant yet: the answer we just got wins.
    expect(await Effect.runPromise(client.status())).toBe('fullAccess');
    // A definite system answer is never overridden.
    status = 'denied';
    expect(await Effect.runPromise(client.status())).toBe('denied');
  });

  it('reads a refusal over that stale status after a granted prompt as a failed call, not lost access', async () => {
    // Never asked in this process: the refusal is what it says.
    expect((await failure(lagging(true)))?._tag).toBe('RemindersAccessError');

    const granted = lagging(true);
    await Effect.runPromise(granted.requestAccess());
    const lag = await failure(granted);
    expect(lag?._tag).toBe('RemindersRequestError');
    expect(lag?._tag === 'RemindersRequestError' && lag.method).toBe('reminders.listLists');

    const denied = lagging(false);
    await Effect.runPromise(denied.requestAccess());
    expect((await failure(denied))?._tag).toBe('RemindersAccessError');
  });
});
