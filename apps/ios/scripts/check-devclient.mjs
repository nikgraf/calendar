// Warns when the dev client installed on the booted simulator was built for
// a different native fingerprint than the working tree: JS from Metro then
// runs against stale native code (a missing Expo module, an old pod), which
// fails in ways that look like app bugs. Advisory only (exit 0).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const warn = (message) => {
  process.stderr.write(`${message}\n`);
};
const say = (message) => {
  process.stdout.write(`${message}\n`);
};

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

let container;
try {
  container = run('xcrun', ['simctl', 'get_app_container', 'booted', 'com.solunivo.app']);
} catch {
  warn('[check-devclient] no booted simulator with Solunivo installed — skipping');
  process.exit(0);
}
let installed;
try {
  installed = run('plutil', [
    '-extract',
    'EXUpdatesRuntimeVersion',
    'raw',
    join(container, 'Expo.plist'),
  ]);
} catch {
  warn('[check-devclient] could not read the installed runtime version — skipping');
  process.exit(0);
}
let local;
try {
  const json = run('npx', ['expo-updates', 'fingerprint:generate', '--platform', 'ios']);
  local = JSON.parse(json).hash;
} catch {
  warn('[check-devclient] fingerprint generation failed — skipping');
  process.exit(0);
}
if (installed !== local) {
  warn(
    `[check-devclient] installed dev client is for fingerprint ${installed}, the working tree is ` +
      `${local} — rebuild it (eas build -p ios --profile development-simulator) before trusting ` +
      'native behavior.',
  );
} else {
  say(`[check-devclient] dev client matches the working tree (${local})`);
}
