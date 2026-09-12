import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DesktopOAuthConfig {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
}

const readConfigFile = (path: string): DesktopOAuthConfig | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      clientId?: string;
      clientSecret?: string;
    };
    return parsed.clientId
      ? { clientId: parsed.clientId, clientSecret: parsed.clientSecret }
      : null;
  } catch {
    return null;
  }
};

/**
 * Google "Desktop app" OAuth client credentials. Sources, in order:
 * 1. GOOGLE_DESKTOP_CLIENT_ID / GOOGLE_DESKTOP_CLIENT_SECRET env vars
 * 2. google-oauth.local.json next to the app (gitignored, developers)
 * 3. google-oauth.json next to the app — written by CI from secrets so a
 *    testing build can sign in; ships inside the package. The desktop
 *    client secret is not confidential (RFC 8252), it still stays out of
 *    git.
 * Returns null when unconfigured — the UI surfaces setup instructions.
 */
export const loadOAuthConfig = (): DesktopOAuthConfig | null => {
  if (process.env.GOOGLE_DESKTOP_CLIENT_ID) {
    return {
      clientId: process.env.GOOGLE_DESKTOP_CLIENT_ID,
      clientSecret: process.env.GOOGLE_DESKTOP_CLIENT_SECRET,
    };
  }
  const rootPath = fileURLToPath(new URL('..', import.meta.url));
  return (
    readConfigFile(join(rootPath, 'google-oauth.local.json')) ??
    readConfigFile(join(rootPath, 'google-oauth.json'))
  );
};
