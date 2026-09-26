#!/usr/bin/env node
/**
 * Redacts Google credentials from the live suite's diagnostics in place,
 * before the failure artifact uploads them: the live access token that
 * Maestro records in every flow's `commands.json` and `maestro.log`, plus
 * the refresh token and client secret should anything ever log them.
 *
 *   node scripts/redact-live-reports.ts <file-or-directory>...
 *
 * Exact values come from MAESTRO_LIVE_ACCESS_TOKEN,
 * GOOGLE_LIVE_REFRESH_TOKEN and GOOGLE_DESKTOP_CLIENT_SECRET when set;
 * credential-shaped strings are replaced regardless. Exits non-zero if
 * anything is left afterwards, so the upload step can refuse to run.
 * See packages/sync/src/testing/liveRedact.ts.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { containsSecret, redactTree } from '../packages/sync/src/testing/liveRedact.ts';

const SECRET_VARIABLES = [
  'MAESTRO_LIVE_ACCESS_TOKEN',
  'GOOGLE_LIVE_REFRESH_TOKEN',
  'GOOGLE_DESKTOP_CLIENT_SECRET',
];

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: redact-live-reports.ts <file-or-directory>...');
  process.exit(2);
}
const secrets = SECRET_VARIABLES.map((name) => process.env[name] ?? '').filter(Boolean);

const report = redactTree(paths, secrets);
for (const { count, path } of report.redacted) {
  console.error(`redacted ${count} value(s) in ${path}`);
}
for (const path of report.removed) {
  console.log(`::warning::removed ${path} from the diagnostics (a credential or a symlink)`);
}

const leftovers: Array<string> = [];
const verify = (path: string): void => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    for (const entry of readdirSync(path)) {
      verify(join(path, entry));
    }
  } else if (stat?.isFile() && containsSecret(readFileSync(path).toString('latin1'), secrets)) {
    leftovers.push(path);
  }
};
paths.forEach(verify);
if (leftovers.length > 0) {
  console.error(`credentials survived redaction in:\n  ${leftovers.join('\n  ')}`);
  process.exit(1);
}
console.error(
  `scanned ${report.files} files: ${report.redacted.length} redacted, ${report.removed.length} removed`,
);
