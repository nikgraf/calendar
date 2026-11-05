import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { complexityCap, complexityPins } from '../vite.config.ts';

/**
 * The lint rule alone leaves two gaps in a pinned file: its override
 * lifts the limit for every function there, not only the listed ones,
 * and a pin left behind by a function that shrank is slack to grow back
 * into. This measures the pinned files as oxlint counts them without the
 * pins and holds each file to exactly the numbers listed for it — by
 * value: it does not know which function is which.
 */
const root = join(import.meta.dirname, '..');

interface Diagnostic {
  readonly code: string;
  readonly filename: string;
  readonly message: string;
}

/** Every function over the cap in the pinned files, per file, highest first. */
const measured = (): Record<string, ReadonlyArray<number>> => {
  const dir = mkdtempSync(join(tmpdir(), 'complexity-pins-'));
  try {
    // `-c` replaces the repo's lint config, pins included.
    const config = join(dir, 'oxlintrc.json');
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        rules: { complexity: ['error', { max: complexityCap }] },
      }),
    );
    const run = spawnSync(
      join(root, 'node_modules/.bin/vp'),
      ['lint', '-c', config, '-f', 'json', ...Object.keys(complexityPins)],
      { cwd: root, encoding: 'utf8' },
    );
    // A run that never started has no output at all, only `error`.
    if (run.error !== undefined || !run.stdout.trimStart().startsWith('{')) {
      throw new Error(`vp lint gave no report: ${String(run.error ?? run.stderr)}`);
    }
    const { diagnostics } = JSON.parse(run.stdout) as {
      diagnostics: ReadonlyArray<Diagnostic>;
    };
    const found: Record<string, Array<number>> = {};
    for (const { code, filename, message } of diagnostics) {
      const value = /has a complexity of (\d+)\./.exec(message)?.[1];
      if (code !== 'eslint(complexity)' || value === undefined) {
        throw new Error(`unexpected diagnostic in ${filename}: ${code} ${message}`);
      }
      (found[filename] ??= []).push(Number(value));
    }
    for (const values of Object.values(found)) {
      values.sort((a, b) => b - a);
    }
    return found;
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

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

describe('complexity pins', () => {
  it('name files that exist', () => {
    expect(Object.keys(complexityPins).filter((file) => !existsSync(join(root, file)))).toEqual([]);
  });

  it('are what each pinned file holds over the cap, number by number', () => {
    expect(
      measured(),
      'A number above its pin: that function grew, split it (AGENTS.md). ' +
        'A number below, or one missing: lower or drop the pin in vite.config.ts.',
    ).toEqual(complexityPins);
  });

  it('are the only way past the cap: no directive switches the rule off', () => {
    expect(switchedOff()).toEqual([]);
  });
});
