/// <reference types="node" />

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./fetch-dev-client.sh', import.meta.url));
const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fetchClient(scenario: string) {
  const directory = mkdtempSync(join(tmpdir(), 'fetch-dev-client-'));
  directories.push(directory);
  const bin = join(directory, 'bin');
  const app = join(directory, 'Solunivo.app');
  mkdirSync(bin);
  mkdirSync(app);
  writeFileSync(join(app, 'Info.plist'), 'test app');
  execFileSync('tar', ['-czf', join(directory, 'app.tar.gz'), '-C', directory, 'Solunivo.app']);
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$MOCK_ROOT/calls"
case "$2:$3" in
  eas:build:list)
    if [ "$MOCK_SCENARIO" = existing ] && [[ "$*" == *'--status finished'* ]]; then
      echo '[{"id":"existing-build"}]'
    else
      echo '[]'
    fi
    ;;
  eas:build)
    case "$MOCK_SCENARIO" in
      cloud) echo '[{"id":"new-build"}]' ;;
      error) echo 'Network request failed' >&2; exit 1 ;;
      *) echo 'This account has used its iOS builds from the Free plan this month' >&2; exit 1 ;;
    esac
    ;;
  eas:build:view)
    printf '{"artifacts":{"applicationArchiveUrl":"file://%s/app.tar.gz"},"runtime":{"version":"fingerprint"}}\\n' "$MOCK_ROOT"
    ;;
  expo:run:ios)
    [ "$MOCK_SCENARIO" != local-error ] || { echo 'Compilation failed' >&2; exit 2; }
    [ "$MOCK_SCENARIO" != local-empty ] || exit 0
    while [ "$1" != --output ]; do shift; done
    mkdir -p "$2"
    cp -R "$MOCK_ROOT/Solunivo.app" "$2/"
    ;;
  *) echo "Unexpected command: $*" >&2; exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  const result = spawnSync('bash', [script, 'fingerprint'], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      MOCK_ROOT: directory,
      MOCK_SCENARIO: scenario,
      PATH: `${bin}:${process.env['PATH']}`,
    },
  });
  return {
    calls: readFileSync(join(directory, 'calls'), 'utf8'),
    directory,
    ...result,
  };
}

it('builds the simulator client locally when Expo rejects a cloud build for exhausted quota', () => {
  const result = fetchClient('quota');
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls).toContain(
    'expo run:ios --configuration Debug --device generic --no-bundler',
  );
  expect(
    readFileSync(join(result.directory, 'build/devclient/Solunivo.app/Info.plist'), 'utf8'),
  ).toBe('test app');
});

it.each(['existing', 'cloud'])(
  'downloads the %s cloud build without compiling locally',
  (scenario) => {
    const result = fetchClient(scenario);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain('expo run:ios');
    expect(
      readFileSync(join(result.directory, 'build/devclient/Solunivo.app/Info.plist'), 'utf8'),
    ).toBe('test app');
  },
);

it('keeps unrelated EAS errors visible instead of starting a local build', () => {
  const result = fetchClient('error');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Network request failed');
  expect(result.calls).not.toContain('expo run:ios');
});

it('fails CI when the fallback native compilation fails', () => {
  const result = fetchClient('local-error');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Compilation failed');
});

it('fails CI when the fallback exits successfully without producing the app', () => {
  const result = fetchClient('local-empty');
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain('local build produced no Solunivo.app');
});
