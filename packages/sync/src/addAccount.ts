import { Account, type TokenSet } from '@calendar/core';
import { AccountRepo } from '@calendar/db';
import { grantsContacts, TASKS_SCOPE, TokenStore } from '@calendar/google';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { SyncEngine } from './engine.ts';

/** What a completed Google sign-in yields on either platform. */
export interface SignInResult {
  readonly profile: {
    readonly avatarUrl?: string | undefined;
    readonly displayName?: string | undefined;
    readonly email: string;
  };
  readonly tokens: TokenSet;
}

/**
 * The platform-independent tail of "Add Google Account": find an existing
 * account by email (re-consent upgrades it in place, keeping its id),
 * derive the feature flags from what Google actually granted — a user
 * can untick scopes on the consent screen — store the tokens, upsert the
 * row, and start the first sync in the background. Both apps used to
 * carry this block line for line.
 */
export const finishAddAccount = (
  result: SignInResult,
  generateId: () => string,
): Effect.Effect<Account, SqlError, AccountRepo | SyncEngine | TokenStore> =>
  Effect.gen(function* () {
    const accountRepo = yield* AccountRepo;
    const tokenStore = yield* TokenStore;
    const engine = yield* SyncEngine;
    const existing = (yield* accountRepo.list()).find(
      (candidate) => candidate.email === result.profile.email,
    );
    const account = new Account({
      avatarUrl: result.profile.avatarUrl,
      contactsEnabled: grantsContacts(result.tokens.scopes),
      createdAt: Date.now(),
      displayName: result.profile.displayName,
      email: result.profile.email,
      id: existing?.id ?? generateId(),
      provider: 'google',
      status: 'ok',
      tasksEnabled: result.tokens.scopes.includes(TASKS_SCOPE),
    });
    yield* tokenStore.set(account.id, result.tokens);
    yield* accountRepo.upsert(account);
    yield* Effect.forkDetach(engine.syncAll());
    return account;
  });
