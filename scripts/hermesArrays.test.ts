import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Hermes, the iPhone's JavaScript engine, has none of the array methods
 * that return a changed copy (`toSorted`, `toReversed`, `toSpliced`,
 * `with`): a call is "undefined is not a function" there, while Node's
 * unit tests and the desktop pass. Three of them in the queue's own code
 * failed every save on the iPhone (#374) and only its e2e said so. This
 * reads the source the iOS bundle is built from and fails on a call.
 * Tests, the fakes under `testing/`, the live suite, the desktop and the
 * website never run on Hermes.
 */
const root = join(import.meta.dirname, '..');
const CALL = /\.(?:toSorted|toReversed|toSpliced)\(/g;

const calls = (): ReadonlyArray<string> => {
  const listed = spawnSync(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      'packages/*/src/**/*.ts',
      'packages/*/src/**/*.tsx',
      'apps/ios/**/*.ts',
      'apps/ios/**/*.tsx',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (listed.error !== undefined || listed.status !== 0) {
    throw new Error(`git ls-files failed: ${String(listed.error ?? listed.stderr)}`);
  }
  return listed.stdout
    .split('\0')
    .filter(
      (path) =>
        path !== '' &&
        existsSync(join(root, path)) &&
        !/\.test\.tsx?$|\.live\.ts$|\/testing\/|\/live\/|\/e2e\//.test(path),
    )
    .flatMap((path) =>
      readFileSync(join(root, path), 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          [...line.matchAll(CALL)].map(([call]) => `${path}:${String(index + 1)} ${call}`),
        ),
    );
};

describe('array methods Hermes lacks', () => {
  it('are not called in the code the iPhone runs', () => {
    expect(calls()).toEqual([]);
  });
});
