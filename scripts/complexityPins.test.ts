import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { complexityCap, complexityPins } from '../vite.config.ts';

/**
 * The lint rule alone leaves two gaps in a pinned file: its override
 * lifts the limit for every function there, not only the listed ones,
 * and a pin left behind by a function that shrank is slack to grow back
 * into. This measures the pinned files as oxlint counts them without the
 * pins and holds the result to the list, number by number.
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
    if (!run.stdout.trimStart().startsWith('{')) {
      throw new Error(`vp lint gave no report: ${run.stderr || String(run.error)}`);
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
    const grep = spawnSync(
      'git',
      [
        'grep',
        '-nE',
        '(eslint|oxlint)-disable.*complexity',
        '--',
        ...['ts', 'tsx', 'js', 'mjs', 'cjs'].map((extension) => `*.${extension}`),
        ...['.agents', '.claude', '.pi'].map((folder) => `:!${folder}`),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    // 1 is git's "nothing matched"; anything else is a hit or a failure.
    expect(`${String(grep.status)} ${grep.stdout}${grep.stderr}`.trim()).toBe('1');
  });
});
