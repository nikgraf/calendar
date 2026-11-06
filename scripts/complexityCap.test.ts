import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * The complexity cap (`vite.config.ts`) has no exceptions, and a disable
 * directive that names the rule would be one the lint itself accepts.
 * This reads every tracked source file and fails on such a directive.
 */
const root = join(import.meta.dirname, '..');

/** A disable directive: the whole comment, since a block one may list its rules over several lines. */
const DIRECTIVE =
  /\/\/\s*(?:eslint|oxlint)-disable[^\n]*|\/\*\s*(?:eslint|oxlint)-disable[\s\S]*?\*\//g;

/** Every directive in a tracked source file that names the rule, as `path: directive`. */
const switchedOff = (): ReadonlyArray<string> => {
  const listed = spawnSync(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      ...['ts', 'tsx', 'js', 'mjs', 'cjs'].map((extension) => `*.${extension}`),
      ...['.agents', '.claude', '.pi'].map((folder) => `:!${folder}`),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (listed.error !== undefined || listed.status !== 0) {
    throw new Error(`git ls-files failed: ${String(listed.error ?? listed.stderr)}`);
  }
  return listed.stdout
    .split('\0')
    .filter((path) => path !== '' && existsSync(join(root, path)))
    .flatMap((path) =>
      [...readFileSync(join(root, path), 'utf8').matchAll(DIRECTIVE)]
        // What follows ` -- ` is the reason, not a rule.
        .filter(([directive]) => /\bcomplexity\b/.test(directive.split(/\s--\s/)[0] ?? ''))
        .map(([directive]) => `${path}: ${directive}`),
    );
};

describe('complexity cap', () => {
  it('is never switched off by a directive', () => {
    expect(switchedOff()).toEqual([]);
  });
});
