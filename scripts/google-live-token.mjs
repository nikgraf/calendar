#!/usr/bin/env node
/**
 * Mints the live Google suite's refresh token — once, by hand, signed in
 * as the dedicated test account. RFC 8252 loopback flow like the desktop
 * app's (apps/desktop/electron/auth/loopbackFlow.ts), against the same
 * desktop OAuth client, asking for the app's scopes plus the full
 * Calendar scope the suite needs to create and delete its scratch
 * calendars.
 *
 *   node scripts/google-live-token.mjs [--write]
 *
 * Client id/secret: GOOGLE_DESKTOP_CLIENT_ID / GOOGLE_DESKTOP_CLIENT_SECRET,
 * else apps/desktop/google-oauth.local.json. Prints the email and the
 * refresh token with the `gh secret set` lines; `--write` also stores them
 * in google-live.local.json (gitignored) for local runs.
 *
 * The OAuth consent screen must be "In production": in "Testing" status
 * Google expires refresh tokens after seven days and the nightly would go
 * red every week. Use a dedicated account with an empty primary calendar
 * and no subscribed holiday calendars — every pass lists every calendar.
 * Dependency-free on purpose; Node 24 loads the scopes module via type
 * stripping so the list cannot drift from the app's.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { GOOGLE_SCOPES } from '../packages/google/src/oauth/scopes.ts';
import { LIVE_CALENDAR_SCOPE } from '../packages/sync/src/testing/liveScratchRest.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const write = process.argv.includes('--write');

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
const oauth = readJson(join(ROOT, 'apps/desktop/google-oauth.local.json'));
const clientId = process.env.GOOGLE_DESKTOP_CLIENT_ID || oauth.clientId;
const clientSecret = process.env.GOOGLE_DESKTOP_CLIENT_SECRET || oauth.clientSecret;
if (!clientId) {
  console.error(
    'no OAuth client: set GOOGLE_DESKTOP_CLIENT_ID (and _SECRET) or create apps/desktop/google-oauth.local.json',
  );
  process.exit(2);
}

const base64url = (buffer) => buffer.toString('base64url');
const verifier = base64url(randomBytes(32));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const state = base64url(randomBytes(16));
const scopes = [...GOOGLE_SCOPES, LIVE_CALENDAR_SCOPE];

const CLOSING_PAGE = `<!doctype html><meta charset="utf-8"><title>Solunivo live token</title>
<body style="font-family: system-ui; display: grid; place-items: center; height: 90vh">
  <p>Signed in — you can close this tab and return to the terminal.</p>
</body>`;

/** One-shot loopback server: resolves with the code Google redirects back with. */
const waitForCode = () =>
  new Promise((resolve, reject) => {
    let port = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CLOSING_PAGE);
      server.close();
      clearTimeout(timeout);
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error) {
        reject(new Error(`Google returned: ${error}`));
      } else if (url.searchParams.get('state') !== state) {
        reject(new Error('state mismatch'));
      } else if (!code) {
        reject(new Error('missing authorization code'));
      } else {
        resolve({ code, redirectUri: `http://127.0.0.1:${port}/callback` });
      }
    });
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('sign-in timed out'));
    }, FLOW_TIMEOUT_MS);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const authUrl = new URL(AUTH_ENDPOINT);
      authUrl.search = new URLSearchParams({
        access_type: 'offline',
        client_id: clientId,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'consent select_account',
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        response_type: 'code',
        scope: scopes.join(' '),
        state,
      }).toString();
      console.error('Sign in as the live test account in the browser:\n');
      console.error(authUrl.toString());
      console.error('');
      if (process.platform === 'darwin') {
        spawn('open', [authUrl.toString()], { stdio: 'ignore' }).unref();
      }
    });
  });

const decodeIdToken = (idToken) => {
  const payload = idToken?.split('.')[1];
  if (!payload) {
    return {};
  }
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
};

const { code, redirectUri } = await waitForCode();
const response = await fetch(TOKEN_ENDPOINT, {
  body: new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  }).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  method: 'POST',
});
const tokens = await response.json();
if (!response.ok || !tokens.refresh_token) {
  console.error('code exchange failed:', JSON.stringify(tokens));
  process.exit(1);
}
const granted = String(tokens.scope ?? '').split(' ');
if (!granted.includes(LIVE_CALENDAR_SCOPE)) {
  console.error(`the full Calendar scope was not granted (got: ${granted.join(' ')})`);
  process.exit(1);
}
const email = decodeIdToken(tokens.id_token).email ?? '';

if (write) {
  const path = join(ROOT, 'google-live.local.json');
  writeFileSync(
    path,
    `${JSON.stringify({ email, refreshToken: tokens.refresh_token }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  console.error(`wrote ${path}`);
}

console.log(`
Live test account: ${email}
Scopes: ${granted.join(' ')}

Set the repository secrets (GOOGLE_DESKTOP_CLIENT_ID/SECRET already exist):

  gh secret set GOOGLE_LIVE_EMAIL --body '${email}'
  gh secret set GOOGLE_LIVE_REFRESH_TOKEN --body '${tokens.refresh_token}'
`);
