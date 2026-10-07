import { SignInCancelledError } from '@calendar/core';
import { AuthRequest, type AuthRequestConfig } from 'expo-auth-session';

const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

import { GOOGLE_SCOPES } from '@calendar/google';

const SCOPES = [...GOOGLE_SCOPES];

/** iOS OAuth clients redirect to the reversed client id scheme. */
const redirectUriFor = (clientId: string): string => {
  const prefix = clientId.replace('.apps.googleusercontent.com', '');
  return `com.googleusercontent.apps.${prefix}:/oauth2redirect`;
};

export interface AuthGrant {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * Runs the expo-auth-session PKCE flow (ASWebAuthenticationSession) and
 * returns the authorization code; the shared TokenManager does the exchange.
 * A dismissed sheet or a refused consent throws SignInCancelledError, which
 * the UI does not show as an error. `loginHint` (a reconnect) opens Google
 * on that account rather than the chooser.
 */
export const signInWithGoogle = async (
  clientId: string,
  loginHint?: string,
): Promise<AuthGrant> => {
  const redirectUri = redirectUriFor(clientId);
  const config: AuthRequestConfig = {
    clientId,
    extraParams: {
      access_type: 'offline',
      ...(loginHint ? { login_hint: loginHint } : {}),
      prompt: loginHint ? 'consent' : 'consent select_account',
    },
    redirectUri,
    scopes: SCOPES,
    usePKCE: true,
  };
  const request = new AuthRequest(config);
  const result = await request.promptAsync(DISCOVERY);

  if (
    result.type === 'cancel' ||
    result.type === 'dismiss' ||
    (result.type === 'error' && result.params['error'] === 'access_denied')
  ) {
    throw new SignInCancelledError({ message: `sign-in ${result.type}` });
  }
  if (result.type !== 'success') {
    throw new Error(`sign-in ${result.type}`);
  }
  const code = result.params['code'];
  if (!code || !request.codeVerifier) {
    throw new Error('missing authorization code or PKCE verifier');
  }
  return { code, codeVerifier: request.codeVerifier, redirectUri };
};
