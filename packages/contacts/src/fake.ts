import { changesFromSubscription } from '@calendar/reminders/client';
import { Effect } from 'effect';
import { ContactsAccessError, type ContactsClientShape, contactsReadable } from './client.ts';
import type { ContactsAuthorization, DeviceContactJson } from './protocol.ts';

/**
 * In-memory ContactsClient for tests: a mutable contact list with the
 * same access semantics as the Swift bridge. Tests mutate `state` to
 * simulate grants, revocations and address-book edits.
 */
export interface FakeContactsState {
  authorization: ContactsAuthorization;
  readonly calls: Array<string>;
  contacts: Array<DeviceContactJson>;
  /** Simulates CNContactStoreDidChange. */
  readonly emitChange: () => void;
}

export const makeFakeContactsClient = (
  initial: {
    readonly authorization?: ContactsAuthorization;
    readonly contacts?: ReadonlyArray<DeviceContactJson>;
  } = {},
): { readonly client: ContactsClientShape; readonly state: FakeContactsState } => {
  const changeListeners = new Set<() => void>();
  const state: FakeContactsState = {
    authorization: initial.authorization ?? 'authorized',
    calls: [],
    contacts: [...(initial.contacts ?? [])],
    emitChange: () => {
      for (const listener of changeListeners) {
        listener();
      }
    },
  };

  const client: ContactsClientShape = {
    changes: changesFromSubscription((listener) => {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    }),
    requestAccess: () =>
      Effect.sync(() => {
        state.calls.push('requestAccess');
        if (state.authorization === 'notDetermined') {
          state.authorization = 'authorized';
        }
        return contactsReadable(state.authorization);
      }),
    snapshot: () =>
      Effect.suspend(() => {
        state.calls.push('snapshot');
        return contactsReadable(state.authorization)
          ? Effect.succeed([...state.contacts])
          : Effect.fail(new ContactsAccessError({ authorization: state.authorization }));
      }),
    status: () =>
      Effect.sync(() => {
        state.calls.push('status');
        return state.authorization;
      }),
  };

  return { client, state };
};
