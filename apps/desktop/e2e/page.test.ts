import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vite-plus/test';
import type { Cdp } from './harness.ts';
import { pageExpression, type PageKit, pageSource } from './page.ts';

/** What the e2e specs write: this suite runs under the same transform. */
const typical = async ($: PageKit, selector: string, words: ReadonlyArray<string>) => {
  const text = $.el<HTMLInputElement>(selector)?.value ?? ('' satisfies string);
  const found = [...words].filter((word) => text.includes(word));
  await Promise.resolve();
  return `${String(found.length)} of ${String(words.length)}: ${found.join()}`;
};

const describes = ($: PageKit, word: string, count: number, list: ReadonlyArray<string>) =>
  `${typeof $.text} ${word} ${String(count)} ${list.join('+')}`;

/**
 * Waits as a spec would write them, type-checked by `pnpm typecheck` and
 * never run: each `@ts-expect-error` fails the check once its line compiles.
 */
const waits = (cdp: Cdp) => [
  // @ts-expect-error -- `?? null === 'v'` reads as `?? (null === 'v')`: a string or a boolean.
  cdp.waitUntil(($) => $.el('h1')?.textContent ?? null === 'v'), // eslint-disable-line no-constant-binary-expression -- the bug, on purpose
  // @ts-expect-error -- `?? ''.includes('v')` asks `''` alone: a string or a boolean.
  cdp.waitUntil(($) => $.el('h1')?.textContent ?? ''.includes('v')),
  // @ts-expect-error -- The same in the timed form.
  cdp.waitUntil({ timeoutMs: 1 }, ($, want) => $.el('h1')?.textContent ?? want === 'v', 'v'),
  cdp.waitUntil(($) => ($.el('h1')?.textContent ?? null) === 'v'),
  cdp.waitUntil({ timeoutMs: 1 }, ($, want: string) => $.text('h1').includes(want), 'v'),
  // @ts-expect-error -- An argument of the wrong type.
  cdp.waitUntil(($, count: number) => $.count('li') === count, 'two'),
  // @ts-expect-error -- A DOM node does not come back by value.
  cdp.evaluate(($) => $.el('h1')),
];

describe('page functions', () => {
  it('reach the page as vitest prints them: types gone, no syntax lowered, nothing added', () => {
    // The transform prints the code again: its own quotes, no redundant parentheses.
    const source = pageSource(typical);
    expect(source).toMatch(/^async \(\$, selector, words\) => \{/);
    expect(source).toMatch(/= \$\.el\(selector\)\?\.value \?\? ["']{2};/);
    expect(source).toContain('[...words]');
    expect(source).toContain('await Promise.resolve()');
    expect(source).toContain('`${String(found.length)} of ');
    expect(source).not.toMatch(
      /: PageKit|HTMLInputElement|satisfies|ReadonlyArray|__vite|_a\b|var /,
    );
  });

  it('are called with a fresh kit and their arguments as JSON', () => {
    const expression = pageExpression(describes, ['it\'s "quoted"', 2, ['a', 'b']]);
    expect(runInNewContext(expression)).toBe('function it\'s "quoted" 2 a+b');
  });

  it('are refused when they close over an import, or are not an expression the page can call', () => {
    expect(() => pageSource(() => pageSource)).toThrow(/names an import/);
    const methods = {
      shorthand() {
        return 1;
      },
    };
    expect(() => pageSource(methods.shorthand)).toThrow(/arrow or a function expression/);
    expect(() => pageSource(Math.max)).toThrow(/arrow or a function expression/);
    expect(pageSource(function named() {})).toMatch(/^function named/);
  });

  it('wait on a boolean, so a fallback that takes in a comparison does not compile', () => {
    expect(waits).toBeTypeOf('function');
  });
});
