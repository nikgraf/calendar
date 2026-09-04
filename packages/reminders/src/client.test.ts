import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { bridgeMessage, makeRemindersClient } from './client.ts';

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
});

const clientRejectingWith = (message: string) =>
  makeRemindersClient(() => Promise.reject(new Error(message)));

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
});
