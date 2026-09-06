import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeContactsClient, unavailableContactsClient } from './client.ts';
import { makeFakeContactsClient } from './fake.ts';

const clientRejectingWith = (message: string) =>
  makeContactsClient(() => Promise.reject(new Error(message)));

describe('makeContactsClient', () => {
  it('maps an access failure to ContactsAccessError on both transports', async () => {
    for (const message of [
      'accessDenied: denied',
      "FunctionCallException: Calling the 'invoke' function has failed\n→ Caused by: ContactsBridgeError: accessDenied: restricted",
    ]) {
      const result = await Effect.runPromise(
        Effect.result(clientRejectingWith(message).snapshot()),
      );
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('ContactsAccessError');
        expect(result.failure._tag === 'ContactsAccessError' && result.failure.authorization).toBe(
          message.endsWith('denied') ? 'denied' : 'restricted',
        );
      }
    }
  });

  it('keeps other bridge errors as ContactsRequestError with the unwrapped message', async () => {
    const result = await Effect.runPromise(
      Effect.result(
        clientRejectingWith('X → Caused by: ContactsBridgeError: fetchFailed: boom').status(),
      ),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('ContactsRequestError');
      expect(result.failure._tag === 'ContactsRequestError' && result.failure.message).toBe(
        'fetchFailed: boom',
      );
    }
  });

  it('decodes a snapshot and rejects a malformed one', async () => {
    const good = makeContactsClient(() =>
      Promise.resolve({
        contacts: [{ contactId: 'c1', displayName: 'Alice', email: 'alice@example.com' }],
      }),
    );
    expect(await Effect.runPromise(good.snapshot())).toEqual([
      { contactId: 'c1', displayName: 'Alice', email: 'alice@example.com' },
    ]);
    const bad = makeContactsClient(() => Promise.resolve({ contacts: [{ contactId: 'c1' }] }));
    const result = await Effect.runPromise(Effect.result(bad.snapshot()));
    expect(result._tag === 'Failure' && result.failure._tag).toBe('ContactsRequestError');
  });
});

describe('unavailableContactsClient', () => {
  it('reports unavailable and fails everything else', async () => {
    const client = unavailableContactsClient('no helper');
    expect(await Effect.runPromise(client.status())).toBe('unavailable');
    const result = await Effect.runPromise(Effect.result(client.snapshot()));
    expect(result._tag === 'Failure' && result.failure._tag).toBe('ContactsUnavailableError');
  });
});

describe('makeFakeContactsClient', () => {
  it('grants on request, serves the snapshot, and fails when revoked', async () => {
    const { client, state } = makeFakeContactsClient({
      authorization: 'notDetermined',
      contacts: [{ contactId: 'c1', email: 'a@example.com' }],
    });
    expect(await Effect.runPromise(client.status())).toBe('notDetermined');
    expect(await Effect.runPromise(client.requestAccess())).toBe(true);
    expect(await Effect.runPromise(client.snapshot())).toHaveLength(1);
    state.authorization = 'denied';
    const result = await Effect.runPromise(Effect.result(client.snapshot()));
    expect(result._tag === 'Failure' && result.failure._tag).toBe('ContactsAccessError');
  });
});
