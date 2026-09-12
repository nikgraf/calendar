// Warns when the Swift model helper binary is missing or older than its
// sources. `desktop build` never compiles it (that needs the macOS 26 SDK),
// so an e2e run could silently exercise a stale helper — or none, in which
// case Reminders/Contacts report 'unavailable' and the model is off.
// Advisory only: exits 0 so the CDP e2e (which runs with the bridges off)
// keeps working on a checkout that never built the helper.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const warn = (message) => {
  process.stderr.write(`${message}\n`);
};

const root = fileURLToPath(new URL('..', import.meta.url));
const binary = join(root, 'helper/.build/release/solunivo-model-helper');
const sourceRoots = [
  join(root, 'helper/Sources'),
  join(root, 'helper/Package.swift'),
  join(root, '../../packages/reminders/swift'),
  join(root, '../../packages/contacts/swift'),
];

const newestMtime = (path) => {
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) {
      return stat.mtimeMs;
    }
    return Math.max(0, ...readdirSync(path).map((entry) => newestMtime(join(path, entry))));
  } catch {
    return 0;
  }
};

let binaryMtime;
try {
  binaryMtime = statSync(binary).mtimeMs;
} catch {
  warn(
    '[check-helper] no helper binary at helper/.build/release — Reminders, Contacts and the ' +
      'on-device model report unavailable. Build it with: pnpm --filter @calendar/desktop build:helper',
  );
  process.exit(0);
}
const sourcesMtime = Math.max(...sourceRoots.map(newestMtime));
if (sourcesMtime > binaryMtime) {
  warn(
    '[check-helper] the helper binary is older than its Swift sources — rebuild with: ' +
      'pnpm --filter @calendar/desktop build:helper',
  );
}
