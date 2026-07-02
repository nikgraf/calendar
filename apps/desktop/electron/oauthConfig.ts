import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DesktopOAuthConfig {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
}

/**
 * Google "Desktop app" OAuth client credentials. Sources, in order:
 * 1. GOOGLE_DESKTOP_CLIENT_ID / GOOGLE_DESKTOP_CLIENT_SECRET env vars
 * 2. google-oauth.local.json next to the app (gitignored)
 * Returns null when unconfigured — the UI surfaces setup instructions.
 */
export const loadOAuthConfig = (): DesktopOAuthConfig | null => {
  if (process.env.GOOGLE_DESKTOP_CLIENT_ID) {
    return {
      clientId: process.env.GOOGLE_DESKTOP_CLIENT_ID,
      clientSecret: process.env.GOOGLE_DESKTOP_CLIENT_SECRET,
    };
  }
  try {
    const rootPath = fileURLToPath(new URL('..', import.meta.url));
    const parsed = JSON.parse(readFileSync(join(rootPath, 'google-oauth.local.json'), 'utf8')) as {
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
