import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync, transformWithOxc } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import { refusedNames } from './page.ts';

/**
 * The free-name check `pageSource` runs before a page function is sent,
 * run here over the e2e code's source: a spec that only CI runs (the real
 * Reminders and Calendar, the live Google account, the website's shots)
 * learns of a name the page would not have before it gets there.
 */

/** The calls that send a page function, after an optional `{ timeoutMs }`. */
const PAGE_CALLS = new Set(['evaluate', 'waitForValue', 'waitUntil', 'waitUntilRendered']);
/** The calls that send two: `noteWhen`'s condition and its reading. */
const PAIR_CALLS = new Set(['noteWhen']);
/** page.ts's own, for page code sent another way (a script for every new document). */
const SOURCE_CALLS = new Set(['pageExpression', 'pageSource']);

interface Node {
  readonly end: number;
  readonly [key: string]: unknown;
  readonly start: number;
  readonly type: string;
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

const children = (node: Node): ReadonlyArray<Node> =>
  Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  );

const isFunction = (node: Node | undefined): node is Node =>
  node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';

const nameOf = (node: unknown): string | undefined =>
  isNode(node) && node.type === 'Identifier' ? (node['name'] as string) : undefined;

/** The page functions a file sends: written in the call, or a function the file names there. */
const pageFunctionsIn = (source: string): ReadonlyArray<Node> => {
  const declared = new Map<string, Array<Node>>();
  const sent: Array<Node | string> = [];
  const visit = (node: Node): void => {
    if (node.type === 'VariableDeclarator') {
      const name = nameOf(node['id']);
      const init = node['init'] as Node | undefined;
      if (name !== undefined && isFunction(init)) {
        declared.set(name, [...(declared.get(name) ?? []), init]);
      }
    }
    const callee = node['callee'];
    const method =
      node.type === 'CallExpression' &&
      isNode(callee) &&
      callee.type === 'MemberExpression' &&
      !callee['computed']
        ? (nameOf(callee['property']) ?? '')
        : '';
    const fn = node.type === 'CallExpression' ? (nameOf(callee) ?? '') : '';
    if (PAGE_CALLS.has(method) || PAIR_CALLS.has(method) || SOURCE_CALLS.has(fn)) {
      const args = (node['arguments'] as ReadonlyArray<Node>).filter(isNode);
      const pages = PAIR_CALLS.has(method)
        ? args.slice(0, 2)
        : SOURCE_CALLS.has(fn)
          ? args.slice(0, 1)
          : [args[0]?.type === 'ObjectExpression' ? args[1] : args[0]];
      for (const page of pages) {
        const name = nameOf(page);
        if (isFunction(page)) {
          sent.push(page);
        } else if (name !== undefined) {
          sent.push(name);
        }
      }
    }
    children(node).forEach(visit);
  };
  visit(parseSync('spec.ts', source).program as unknown as Node);
  // A name the file does not define (a wrapper's parameter, an import) is checked where it is written.
  const pages = new Set(
    sent.flatMap((page) => (typeof page === 'string' ? (declared.get(page) ?? []) : [page])),
  );
  return [...pages].toSorted((a, b) => a.start - b.start);
};

/** The page function's source as the page gets it: types stripped. */
const asSent = async (source: string): Promise<string> =>
  (await transformWithOxc(`(${source})`, 'page.ts', { lang: 'ts', sourcemap: false })).code
    .trim()
    .replace(/;$/, '');

const dir = import.meta.dirname;
const files = readdirSync(dir, { encoding: 'utf8', recursive: true })
  .filter((file) => file.endsWith('.e2e.ts') || file === 'harness.ts')
  .toSorted();

describe('the page functions the e2e code sends', () => {
  it('are found in every file that sends them', () => {
    const source = `
      const ready = ($: PageKit) => $.has('[data-testid="ready"]');
      await cdp.waitUntil(ready);
      await app.cdp.waitUntil({ timeoutMs: 1 }, ($, want: string) => $.text('h1') === want, 'x');
      await this.evaluate(function () { return document.title; });
      await cdp.waitForValue(passedIn);
      const moved = ($: PageKit) => $.text('h2') === 'Moved';
      await cdp.noteWhen(moved, ($, field: string) => $.value(field), 'input');
      const record = () => { window.__seen = []; };
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageExpression(record, []) });
    `;
    expect(pageFunctionsIn(source).map((node) => source.slice(node.start, node.end))).toEqual([
      `($: PageKit) => $.has('[data-testid="ready"]')`,
      `($, want: string) => $.text('h1') === want`,
      'function () { return document.title; }',
      `($: PageKit) => $.text('h2') === 'Moved'`,
      '($, field: string) => $.value(field)',
      '() => { window.__seen = []; }',
    ]);
  });

  it.each(files)('%s: name only what the page has', async (file) => {
    const source = readFileSync(join(dir, file), 'utf8');
    const refused: Array<string> = [];
    for (const page of pageFunctionsIn(source)) {
      const names = refusedNames(await asSent(source.slice(page.start, page.end)));
      if (names.length > 0) {
        const line = source.slice(0, page.start).split('\n').length;
        refused.push(`${file}:${String(line)} names ${names.join(', ')}`);
      }
    }
    expect(refused).toEqual([]);
  });
});
