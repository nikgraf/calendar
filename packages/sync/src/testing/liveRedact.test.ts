import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containsSecret, REDACTED, redactSecrets, redactTree } from './liveRedact.ts';

const ACCESS_TOKEN = 'ya29.a0AfB_test-Token.value_123';
const REFRESH_TOKEN = '1//0gTestRefreshToken-abcdefghijklmnop';
const CLIENT_SECRET = 'GOCSPX-test-client-secret';

describe('redactSecrets', () => {
  it('replaces exact secrets and credential-shaped strings', () => {
    const text = JSON.stringify({
      env: { MAESTRO_LIVE_ACCESS_TOKEN: ACCESS_TOKEN, OTHER: 'keep me' },
      log: `client_secret=${CLIENT_SECRET} refresh=${REFRESH_TOKEN}`,
    });
    const result = redactSecrets(text, [CLIENT_SECRET]);
    expect(result.count).toBe(3);
    expect(result.text).not.toContain('ya29.');
    expect(result.text).not.toContain(CLIENT_SECRET);
    expect(result.text).not.toContain('1//');
    expect(result.text).toContain('keep me');
    expect(result.text.split(REDACTED)).toHaveLength(4);
  });

  it('catches the JSON-escaped form of a secret', () => {
    const escaped = REFRESH_TOKEN.replaceAll('/', String.raw`\/`);
    expect(redactSecrets(`"token":"${escaped}"`, [REFRESH_TOKEN]).text).toBe(
      `"token":"${REDACTED}"`,
    );
  });

  it('leaves clean text and too-short secrets alone', () => {
    const text = 'Live Google — create, rename and delete an event at 12:00';
    expect(redactSecrets(text, ['12:00', ''])).toEqual({ count: 0, text });
    expect(containsSecret(text, [])).toBe(false);
  });
});

describe('redactTree', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'live-redact-'));
  });
  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('rewrites text files, drops binaries holding a token and symlinks, keeps the rest', () => {
    const flow = join(root, 'tests', '2026-09-24_162932', 'Live Google — a flow');
    mkdirSync(flow, { recursive: true });
    writeFileSync(
      join(flow, 'commands.json'),
      `{"MAESTRO_LIVE_ACCESS_TOKEN":"${ACCESS_TOKEN}","MAESTRO_LIVE_RUN_TAG":"ci-1"}`,
    );
    writeFileSync(join(flow, 'screenshot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    writeFileSync(
      join(flow, 'recording.bin'),
      Buffer.concat([Buffer.from([0, 1]), Buffer.from(ACCESS_TOKEN)]),
    );
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, ACCESS_TOKEN);
    symlinkSync(outside, join(flow, 'link.txt'));
    const metroLog = join(root, 'metro.log');
    writeFileSync(metroLog, 'Bundled 1234ms\n');

    const report = redactTree([join(root, 'tests'), metroLog, join(root, 'missing')], []);

    expect(report.files).toBe(4);
    expect(report.redacted).toEqual([{ count: 1, path: join(flow, 'commands.json') }]);
    expect(report.removed.toSorted()).toEqual(
      [join(flow, 'link.txt'), join(flow, 'recording.bin')].toSorted(),
    );
    expect(readFileSync(join(flow, 'commands.json'), 'utf8')).toBe(
      `{"MAESTRO_LIVE_ACCESS_TOKEN":"${REDACTED}","MAESTRO_LIVE_RUN_TAG":"ci-1"}`,
    );
    expect(existsSync(join(flow, 'screenshot.png'))).toBe(true);
    expect(readFileSync(metroLog, 'utf8')).toBe('Bundled 1234ms\n');
  });
});
