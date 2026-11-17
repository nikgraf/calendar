import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseSync, transformWithOxc } from 'vite';
import { describe, expect, it } from 'vite-plus/test';
import { freeNames, refusedNames } from './page.ts';

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

const isFunction = (node: Node): boolean =>
  node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';

const nameOf = (node: unknown): string | undefined =>
  isNode(node) && node.type === 'Identifier' ? (node['name'] as string) : undefined;

/** What a call sends as page code: a function written there, a name, or something else. */
type Sent =
  | { readonly kind: 'function'; readonly node: Node }
  | { readonly kind: 'name'; readonly name: string; readonly start: number }
  | { readonly end: number; readonly kind: 'other'; readonly start: number };

/** A file's page code: what it sends, the functions it declares by name and what it imports. */
interface Scan {
  readonly declared: ReadonlyMap<string, ReadonlyArray<Node>>;
  /** Each import's local name: the file it comes from (relative to e2e/) and its name there. */
  readonly imports: ReadonlyMap<string, { readonly from: string; readonly name: string }>;
  readonly sent: ReadonlyArray<Sent>;
  readonly source: string;
}

const scan = (file: string, source: string): Scan => {
  const declared = new Map<string, Array<Node>>();
  const imports = new Map<string, { from: string; name: string }>();
  const sent: Array<Sent> = [];
  const visit = (node: Node): void => {
    if (node.type === 'VariableDeclarator') {
      const name = nameOf(node['id']);
      const init = node['init'] as Node | undefined;
      if (name !== undefined && isNode(init) && isFunction(init)) {
        declared.set(name, [...(declared.get(name) ?? []), init]);
      }
    }
    if (node.type === 'ImportDeclaration') {
      const from = join(dirname(file), String((node['source'] as Node)['value'])).replace(
        /(?:\.ts)?$/,
        '.ts',
      );
      for (const specifier of (node['specifiers'] as ReadonlyArray<Node>).filter(isNode)) {
        const local = nameOf(specifier['local']);
        const name = nameOf(specifier['imported']);
        if (local !== undefined && name !== undefined) {
          imports.set(local, { from, name });
        }
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
      for (const page of pages.filter(isNode)) {
        const name = nameOf(page);
        sent.push(
          isFunction(page)
            ? { kind: 'function', node: page }
            : name === undefined
              ? { end: page.end, kind: 'other', start: page.start }
              : { kind: 'name', name, start: page.start },
        );
      }
    }
    children(node).forEach(visit);
  };
  visit(parseSync(file, source).program as unknown as Node);
  return { declared, imports, sent, source };
};

const lineOf = (source: string, offset: number): number =>
  source.slice(0, offset).split('\n').length;

/** A page function, in the file that writes it. */
interface Page {
  readonly file: string;
  readonly node: Node;
}

/**
 * The page functions `file` sends, each found where it is written: in the
 * call, a function the file declares, or one it imports from another
 * e2e file. Anything else it sends is `unread`: the check cannot see it.
 * The harness's wrappers pass on the function they were given (`page`).
 */
const pagesSentBy = (
  file: string,
  scans: ReadonlyMap<string, Scan>,
): { pages: ReadonlyArray<Page>; unread: ReadonlyArray<string> } => {
  const own = scans.get(file)!;
  const pages = new Map<Node, Page>();
  const unread: Array<string> = [];
  const at = (start: number) => `${file}:${String(lineOf(own.source, start))}`;
  for (const sent of own.sent) {
    if (sent.kind === 'function') {
      pages.set(sent.node, { file, node: sent.node });
    } else if (sent.kind === 'other') {
      unread.push(`${at(sent.start)} sends ${own.source.slice(sent.start, sent.end)}`);
    } else {
      const imported = own.imports.get(sent.name);
      const local = own.declared.get(sent.name)?.map((node) => ({ file, node }));
      const there = imported
        ? scans
            .get(imported.from)
            ?.declared.get(imported.name)
            ?.map((node) => ({ file: imported.from, node }))
        : undefined;
      const found = local ?? there;
      if (found) {
        found.forEach((page) => pages.set(page.node, page));
      } else if (!(file === 'harness.ts' && sent.name === 'page')) {
        unread.push(`${at(sent.start)} sends ${sent.name}`);
      }
    }
  }
  return { pages: [...pages.values()].toSorted((a, b) => a.node.start - b.node.start), unread };
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
  it('are found in the call, as a name the file declares, or as an import from another e2e file', () => {
    const harness = `
      export const leave = ($: PageKit) => { $.button('Cancel')?.click(); };
      export const evaluate = (page) => run(pageExpression(page, []));
    `;
    const spec = `
      import { leave as goAway } from './harness.ts';
      const ready = ($: PageKit) => $.has('[data-testid="ready"]');
      await cdp.waitUntil(ready);
      await app.cdp.waitUntil({ timeoutMs: 1 }, ($, want: string) => $.text('h1') === want, 'x');
      await this.evaluate(function () { return document.title; });
      await cdp.evaluate(goAway);
      const moved = ($: PageKit) => $.text('h2') === 'Moved';
      await cdp.noteWhen(moved, ($, field: string) => $.value(field), 'input');
      const record = () => { window.__seen = []; };
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageExpression(record, []) });
      await cdp.waitForValue(passedIn);
      await cdp.waitUntil(LONG, ready);
      await cdp.evaluate(pages.ready);
    `;
    const scans = new Map([
      ['harness.ts', scan('harness.ts', harness)],
      ['spec.e2e.ts', scan('spec.e2e.ts', spec)],
    ]);
    const { pages, unread } = pagesSentBy('spec.e2e.ts', scans);
    expect(
      pages.map(
        ({ file, node }) =>
          `${file}: ${(file === 'harness.ts' ? harness : spec).slice(node.start, node.end)}`,
      ),
    ).toEqual([
      `harness.ts: ($: PageKit) => { $.button('Cancel')?.click(); }`,
      `spec.e2e.ts: ($: PageKit) => $.has('[data-testid="ready"]')`,
      `spec.e2e.ts: ($, want: string) => $.text('h1') === want`,
      'spec.e2e.ts: function () { return document.title; }',
      `spec.e2e.ts: ($: PageKit) => $.text('h2') === 'Moved'`,
      'spec.e2e.ts: ($, field: string) => $.value(field)',
      'spec.e2e.ts: () => { window.__seen = []; }',
    ]);
    expect(unread).toEqual([
      'spec.e2e.ts:12 sends passedIn',
      'spec.e2e.ts:13 sends LONG',
      'spec.e2e.ts:14 sends pages.ready',
    ]);
    expect(pagesSentBy('harness.ts', scans).unread).toEqual([]);
  });

  const scans = new Map(
    files.map((file) => [file, scan(file, readFileSync(join(dir, file), 'utf8'))]),
  );

  it.each(files)(
    '%s: sends only page functions the check can read, naming only what the page has',
    async (file) => {
      const { pages, unread } = pagesSentBy(file, scans);
      const refused: Array<string> = [...unread];
      for (const { file: home, node } of pages) {
        const { imports, source } = scans.get(home)!;
        const sent = await asSent(source.slice(node.start, node.end));
        const names = [
          ...refusedNames(sent),
          // An import the transform would rename, even one called like a page global.
          ...[...freeNames(sent)].filter(
            (name) => imports.has(name) && !refusedNames(sent).includes(name),
          ),
        ];
        if (names.length > 0) {
          refused.push(`${home}:${String(lineOf(source, node.start))} names ${names.join(', ')}`);
        }
      }
      expect(refused).toEqual([]);
    },
  );
});
