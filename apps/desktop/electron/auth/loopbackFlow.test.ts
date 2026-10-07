import { TokenSet } from '@calendar/core';
import { TokenManager, TokenRefreshError, type TokenManagerShape } from '@calendar/google';
import { Effect, Exit, Layer } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The system browser is the test: it reads the auth URL Google would get.
const opened: Array<string> = [];
vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => {
      opened.push(url);
      return Promise.resolve();
    },
  },
}));

const { cancelGoogleSignIn, runGoogleSignIn } = await import('./loopbackFlow.ts');

const tokens = new TokenSet({
  accessToken: 'access',
  expiresAt: 0,
  refreshToken: 'refresh',
  scopes: [],
});

const tokenManager = (exchange: TokenManagerShape['exchangeCode']) =>
  Layer.succeed(TokenManager, {
    exchangeCode: exchange,
    getAccessToken: () => Effect.die('not used'),
    invalidateAccessToken: () => Effect.void,
  });

const exchangeOk: TokenManagerShape['exchangeCode'] = () =>
  Effect.succeed({ profile: { email: 'nik@example.com' }, tokens });

/** Starts a sign-in and waits for the browser to be sent to Google. */
const start = async (
  exchange: TokenManagerShape['exchangeCode'] = exchangeOk,
  options: { readonly loginHint?: string } = {},
) => {
  opened.length = 0;
  const outcome = Effect.runPromiseExit(
    runGoogleSignIn('client-id', options).pipe(Effect.provide(tokenManager(exchange))),
  );
  await vi.waitFor(() => expect(opened).toHaveLength(1));
  const auth = new URL(opened[0]!);
  const callback = (params: Record<string, string>) =>
    fetch(
      `${auth.searchParams.get('redirect_uri')}?${new URLSearchParams(params).toString()}`,
    ).then((response) => response.text());
  return { auth, callback, outcome, state: auth.searchParams.get('state')! };
};

afterEach(() => {
  cancelGoogleSignIn();
});

describe('runGoogleSignIn', () => {
  it('says "Signed in" only once the code exchange went through', async () => {
    const flow = await start();
    const page = await flow.callback({ code: 'the-code', state: flow.state });
    expect(page).toContain('Signed in');
    expect(Exit.isSuccess(await flow.outcome)).toBe(true);

    const failing = await start(() =>
      Effect.fail(new TokenRefreshError({ accountId: '', message: 'invalid_grant' })),
    );
    const failedPage = await failing.callback({ code: 'the-code', state: failing.state });
    expect(failedPage).not.toContain('Signed in');
    expect(failedPage).toContain('Sign-in failed');
    expect(Exit.isFailure(await failing.outcome)).toBe(true);
  });

  it('reads a refused consent as cancelled, and a foreign state as a failure', async () => {
    const refused = await start();
    expect(await refused.callback({ error: 'access_denied', state: refused.state })).toContain(
      'Sign-in cancelled',
    );
    const refusedExit = await refused.outcome;
    expect(Exit.isFailure(refusedExit) && JSON.stringify(refusedExit.cause)).toContain(
      'SignInCancelledError',
    );

    const forged = await start();
    const page = await forged.callback({ code: 'stolen', state: 'not-ours' });
    expect(page).toContain('Sign-in failed');
    expect(JSON.stringify(await forged.outcome)).toContain('state mismatch');
  });

  it('ends as cancelled on Cancel, without waiting for the browser', async () => {
    const flow = await start();
    cancelGoogleSignIn();
    const exit = await flow.outcome;
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain('SignInCancelledError');
  });

  it('Cancel still works while the code exchange is pending', async () => {
    // Google's token endpoint is slow: the UI still offers Cancel, and the
    // account must not be added after it was pressed.
    let exchanging = false;
    const flow = await start(() =>
      Effect.suspend(() => {
        exchanging = true;
        return Effect.never;
      }),
    );
    const page = flow.callback({ code: 'the-code', state: flow.state });
    await vi.waitFor(() => expect(exchanging).toBe(true));
    cancelGoogleSignIn();
    const exit = await flow.outcome;
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain('SignInCancelledError');
    expect(await page).toContain('Sign-in cancelled');
  });

  it('opens a reconnect on its account instead of the chooser', async () => {
    const reconnect = await start(exchangeOk, { loginHint: 'nik@example.com' });
    expect(reconnect.auth.searchParams.get('login_hint')).toBe('nik@example.com');
    expect(reconnect.auth.searchParams.get('prompt')).toBe('consent');
    cancelGoogleSignIn();
    await reconnect.outcome;

    const add = await start();
    expect(add.auth.searchParams.get('login_hint')).toBeNull();
    expect(add.auth.searchParams.get('prompt')).toBe('consent select_account');
  });
});
