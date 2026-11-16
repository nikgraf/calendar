import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { misreadFallbacks, refuseMisreadFallback } from './fallbackPrecedence';

const root = join(import.meta.dirname, '../../..');

/**
 * These spell the shapes out on purpose: this guard's own files, and the
 * typed page functions' (`page.test.ts` holds that they do not compile).
 */
const OWN = ['fallbackPrecedence.ts', 'fallbackPrecedence.test.ts', 'page.ts', 'page.test.ts'].map(
  (file) => `apps/desktop/e2e/${file}`,
);

/** The tracked e2e sources, as paths from the root. */
const sources = (): ReadonlyArray<string> => {
  const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--', 'apps/desktop/e2e/*.ts', ...OWN.map((path) => `:!${path}`)],
    { cwd: root, encoding: 'utf8' },
  );
  if (listed.error !== undefined || listed.status !== 0) {
    throw new Error(`git ls-files failed: ${String(listed.error ?? listed.stderr)}`);
  }
  return listed.stdout.split('\0').filter((path) => path !== '' && existsSync(join(root, path)));
};

/** Every misread fallback written out in `paths`, as `path:line: text`. */
const writtenOut = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.flatMap((path) => {
    const source = readFileSync(join(root, path), 'utf8');
    return misreadFallbacks(source).map(
      ({ index, text }) => `${path}:${String(source.slice(0, index).split('\n').length)}: ${text}`,
    );
  });

const found = (source: string) => misreadFallbacks(source).map(({ text }) => text);

describe('a ?? fallback in a CDP expression', () => {
  it('is never written out where it takes in a comparison, or a member access on a literal', () => {
    const paths = sources();
    // Not a pass over nothing: the harness, the specs and the bench are read.
    expect(paths).toEqual(
      expect.arrayContaining([
        'apps/desktop/e2e/harness.ts',
        'apps/desktop/e2e/flows.e2e.ts',
        'apps/desktop/e2e/bench/check.ts',
      ]),
    );
    expect(writtenOut(paths)).toEqual([]);
  });

  it.each([
    ["el?.textContent ?? null === 'v'", '?? null ==='],
    ["el?.textContent ?? '' === 'v'", "?? '' ==="],
    ['el?.textContent ?? "" === \'v\'', '?? "" ==='],
    ["el?.textContent ?? undefined === 'v'", '?? undefined ==='],
    ['el?.value ?? `` === `v`', '?? `` ==='],
    ['el?.checked ?? false === true', '?? false ==='],
  ])('finds a literal fallback before ===: %s', (source, text) => {
    expect(found(source)).toEqual([text]);
  });

  it.each([
    ["x ?? null !== 'v'", '?? null !=='],
    ["x ?? null == 'v'", '?? null =='],
    ["x ?? null != 'v'", '?? null !='],
    ['rect?.y ?? 0 > 100', '?? 0 >'],
    ['rect?.y ?? -1 <= 0', '?? -1 <='],
  ])('finds any comparison: %s', (source, text) => {
    expect(found(source)).toEqual([text]);
  });

  it.each([
    ["x ??null==='v'", '??null==='],
    ["x ??   null   ===   'v'", '?? null ==='],
    ["x ??\n      null\n      === 'v'", '?? null ==='],
    ["x ??\tnull\t!== 'v'", '?? null !=='],
  ])('finds it spaced closely, widely or over lines: %j', (source, text) => {
    expect(found(source)).toEqual([text]);
  });

  it.each([
    ["${status} ?? ${JSON.stringify(fallback)} === 'v'", '?? ${JSON.stringify(fallback)} ==='],
    ["a ?? b.c?.('d')[0] === 'e'", "?? b.c?.('d')[0] ==="],
    ["a ?? (b) === 'c'", '?? (b) ==='],
    ['a ?? !b === c', '?? !b ==='],
    ["a ?? typeof b === 'string'", '?? typeof b ==='],
    ['a ?? new Date() > d', '?? new Date() >'],
    ["a ?? String(Number(b)) === '1'", '?? String(Number(b)) ==='],
    ["a ?? ['x'] === b", "?? ['x'] ==="],
    [
      "[...document.querySelectorAll('li')].find((li) => li.dataset.id ?? null === 'v')",
      '?? null ===',
    ],
  ])('finds a fallback that is not a literal, or sits inside more: %s', (source, text) => {
    expect(found(source)).toEqual([text]);
  });

  it.each([
    ["el?.textContent ?? ''.includes('v')", "?? ''.i"],
    ['list ?? [].length', '?? [].l'],
    ['el ?? null?.dataset', '?? null?.d'],
  ])('finds a member access on a literal fallback: %s', (source, text) => {
    expect(found(source)).toEqual([text]);
  });

  it.each([
    "(el?.textContent ?? null) === 'v'",
    "(el?.textContent ?? '').includes('v')",
    'x ?? (a === b)',
    "x ?? (lang === 'de' ? 'de-DE' : 'en-US')",
    "fold(location ?? '') !== fold(wanted)",
    'a ?? b ? c === d : e',
    '(window.__noted ??= {})',
    'rect?.y ?? 1.5',
    "el?.textContent ?? ''",
    "(a ?? b) || c === 'v'",
    'list.map((x) => x ?? 0).filter((n) => n > 0)',
    'cached ?? createStore<State>()',
    'map.get(key) ?? new Map<string, number>()',
    'given ?? 1 << 3',
    'given ?? mask >> 2',
    'given ?? mask >>> 2',
    "x ?? [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save')",
    'x ?? [...list].sort()[0]',
    "x ?? a.b.includes('v')",
    '// `??` binds looser than `===`, so `(x ?? null) === v`',
  ])('passes a fallback kept apart: %s', (source) => {
    expect(found(source)).toEqual([]);
  });

  it('refuses the expression a spec assembles from a constant ending in a fallback', () => {
    const status = `document.querySelector('[data-testid="status"]')?.textContent ?? null`;
    expect(() => refuseMisreadFallback(`${status} === 'Visible'`)).toThrow(
      /\?\? null ===`.*parenthesise/,
    );
    expect(() => refuseMisreadFallback(`(${status}) === 'Visible'`)).not.toThrow();
  });
});
