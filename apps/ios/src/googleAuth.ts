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
 */
export const signInWithGoogle = async (clientId: string): Promise<AuthGrant> => {
  const redirectUri = redirectUriFor(clientId);
  const config: AuthRequestConfig = {
    clientId,
    extraParams: {
      access_type: 'offline',
      prompt: 'consent select_account',
    },
    redirectUri,
    scopes: SCOPES,
    usePKCE: true,
  };
  const request = new AuthRequest(config);
  const result = await request.promptAsync(DISCOVERY);

  if (result.type !== 'success') {
    throw new Error(`sign-in ${result.type}`);
  }
  const code = result.params['code'];
  if (!code || !request.codeVerifier) {
    throw new Error('missing authorization code or PKCE verifier');
  }
  return { code, codeVerifier: request.codeVerifier, redirectUri };
};
