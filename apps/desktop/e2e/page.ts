/**
 * Page code as functions. What a spec runs in the app's window is a
 * TypeScript function; the harness sends its source (`toString()`) with
 * the arguments as JSON (`Cdp.evaluate`, `waitUntil`), so the type checker
 * and the lint read it like any other code. A wait's predicate returns a
 * boolean, which makes both ways a `??` fallback took in what followed it
 * type errors: `x ?? null === 'v'` (`x ?? (null === 'v')`) and
 * `x ?? ''.includes('v')` are a string or a boolean (#230, #317).
 *
 * A page function runs in the page, not here: it sees the page's globals,
 * the kit below and its arguments, never a variable of the spec's. So it
 * may name only what it binds itself, JavaScript's own globals and the
 * page's listed below (`PAGE_GLOBALS`); any other name is refused before
 * it is sent (`freeNames`). That covers a spec constant the page also has
 * a global for — `name`, `status`, `event`, an element's id — which would
 * otherwise read the page's value without a word. Pass the value as an
 * argument; the page's own property is `window.name`.
 *
 * The source is sent as vitest's transform prints it: types stripped, its
 * own quotes, no syntax lowered and no helper added (`page.test.ts` holds
 * it to that). Coverage instrumentation would put its counters in, which
 * the page does not have: the e2e specs never run under it, and a source
 * with them is refused.
 */

import { runInNewContext } from 'node:vm';
import { parseAst } from 'vite';

/**
 * A value that travels to the page and back as JSON: `undefined` inside an
 * array or object, and a number that is not finite, do not survive it.
 */
export type PageValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<PageValue>
  | { readonly [key: string]: PageValue };

export type PageArgs = ReadonlyArray<PageValue>;

/**
 * The helpers every page function gets as its first parameter (`$`): the
 * DOM reads and writes the specs share, made in the page for each call.
 * Self-contained, like any page function: they call one another, and
 * nothing outside.
 */
export const pageKit = () => {
  const el = <E extends Element = HTMLElement>(selector: string): E | null =>
    document.querySelector<E>(selector);
  const all = <E extends Element = HTMLElement>(selector: string): Array<E> => [
    ...document.querySelectorAll<E>(selector),
  ];
  return {
    all,
    /** The first button whose trimmed text is `label`. */
    button: (label: string): HTMLButtonElement | null =>
      all<HTMLButtonElement>('button').find((button) => button.textContent?.trim() === label) ??
      null,
    count: (selector: string): number => document.querySelectorAll(selector).length,
    el,
    has: (selector: string): boolean => el(selector) !== null,
    /**
     * Sets a field's value as typing or a pick would, all at once: through
     * the element's own setter, which React watches, then the event React
     * listens for (`change` on a select, `input` otherwise).
     */
    setValue: (selector: string, value: string): void => {
      const field = el<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
      if (!field) {
        throw new Error(`setValue: nothing matches ${selector}`);
      }
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(
        field,
        value,
      );
      field.dispatchEvent(
        new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
      );
    },
    /** The element's text, or '' when nothing matches. */
    text: (selector: string): string => el(selector)?.textContent ?? '',
    /** A field's value (an input, a select, a text area), or '' when nothing matches. */
    value: (selector: string): string =>
      el<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector)?.value ?? '',
  };
};

export type PageKit = ReturnType<typeof pageKit>;

/** Code for the page: called there with the kit, then the arguments. */
export type PageFunction<A extends PageArgs, R> = ($: PageKit, ...args: A) => R;

/** What vitest's transform makes of a closed-over import, and istanbul's counters. */
const FOREIGN = /__vite_ssr_|\bcov_\w+\(\)|__coverage__/;
/** A built-in, or a bound function: no source to send. */
const NATIVE = /\{\s*\[native code\]\s*\}$/;
/** An arrow or a function expression: what can be called where it is written. */
const CALLABLE = /^(?:async\s*)?(?:function\b|\(|[\w$]+\s*=>)/;

/** JavaScript's own globals, as a fresh V8 context has them (`Math`, `JSON`, `undefined`, …). */
const SCRIPT_GLOBALS: ReadonlyArray<string> = runInNewContext(
  'Object.getOwnPropertyNames(globalThis)',
) as Array<string>;

/**
 * The page's own globals a page function may name bare. Never a word a
 * spec could have meant as its own (`name`, `status`, `event`, `open`,
 * `location`, `history`): those are read as `window.name`. Add one here
 * when a page function needs it.
 */
const PAGE_GLOBALS = new Set([
  ...SCRIPT_GLOBALS,
  'AudioContext',
  'CSS',
  'DataTransfer',
  'DOMRect',
  'Element',
  'MutationObserver',
  'Node',
  'ResizeObserver',
  'arguments',
  'atob',
  'btoa',
  'cancelAnimationFrame',
  'clearInterval',
  'clearTimeout',
  'console',
  'document',
  'getComputedStyle',
  'navigator',
  'performance',
  'requestAnimationFrame',
  'setInterval',
  'setTimeout',
  'window',
]);
/** The element and event classes: `HTMLInputElement`, `KeyboardEvent`, `Event`. */
const PAGE_CLASS = /^(?:(?:HTML|SVG)[A-Za-z]*Element|(?:[A-Z][a-z]+)*Event)$/;

interface AstNode {
  readonly [key: string]: unknown;
  readonly type: string;
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';

const nodesIn = (value: unknown): ReadonlyArray<AstNode> =>
  Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [];

/**
 * The names a function's source uses without binding them anywhere in it.
 * Scopes are not told apart: a name bound in one helper counts as bound in
 * all of it, which can only let a name through, never refuse a bound one.
 */
export const freeNames = (source: string): ReadonlySet<string> => {
  const bound = new Set<string>();
  const used = new Set<string>();
  const visit = (node: AstNode): void => {
    switch (node.type) {
      case 'Identifier':
        used.add(node['name'] as string);
        return;
      case 'MemberExpression':
        nodesIn(node['object']).forEach(visit);
        if (node['computed']) {
          nodesIn(node['property']).forEach(visit);
        }
        return;
      case 'Property':
      case 'PropertyDefinition':
      case 'MethodDefinition':
        if (node['computed']) {
          nodesIn(node['key']).forEach(visit);
        }
        nodesIn(node['value']).forEach(visit);
        return;
      case 'LabeledStatement':
        nodesIn(node['body']).forEach(visit);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
        return;
      case 'VariableDeclarator':
        nodesIn(node['id']).forEach(bind);
        nodesIn(node['init']).forEach(visit);
        return;
      case 'ArrowFunctionExpression':
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ClassDeclaration':
      case 'ClassExpression':
      case 'CatchClause':
        nodesIn(node['id']).forEach(bind);
        nodesIn(node['params']).forEach(bind);
        nodesIn(node['param']).forEach(bind);
        nodesIn(node['superClass']).forEach(visit);
        nodesIn(node['body']).forEach(visit);
        return;
      default:
        for (const value of Object.values(node)) {
          nodesIn(value).forEach(visit);
        }
    }
  };
  // A binding pattern: its names are bound, its defaults and computed keys are used.
  const bind = (pattern: AstNode): void => {
    switch (pattern.type) {
      case 'Identifier':
        bound.add(pattern['name'] as string);
        return;
      case 'ObjectPattern':
        for (const property of nodesIn(pattern['properties'])) {
          if (property.type === 'RestElement') {
            nodesIn(property['argument']).forEach(bind);
            continue;
          }
          if (property['computed']) {
            nodesIn(property['key']).forEach(visit);
          }
          nodesIn(property['value']).forEach(bind);
        }
        return;
      case 'ArrayPattern':
        nodesIn(pattern['elements']).forEach(bind);
        return;
      case 'AssignmentPattern':
        nodesIn(pattern['left']).forEach(bind);
        nodesIn(pattern['right']).forEach(visit);
        return;
      case 'RestElement':
        nodesIn(pattern['argument']).forEach(bind);
        return;
      default:
        visit(pattern);
    }
  };
  parseAst(`(${source})`).body.forEach((statement) => visit(statement as unknown as AstNode));
  return new Set([...used].filter((name) => !bound.has(name)));
};

/** Sources already checked: a wait sends the same one on every try. */
const checked = new Set<string>();

/** A function's source, refused when it could not run in the page as written. */
export const pageSource = (page: (...args: never) => unknown): string => {
  const source = page.toString();
  if (!CALLABLE.test(source) || NATIVE.test(source)) {
    throw new Error(
      `A page function is an arrow or a function expression, not a method or a bound function: ${source.slice(0, 120)}`,
    );
  }
  const foreign = FOREIGN.exec(source);
  if (foreign) {
    throw new Error(
      `A page function names an import (or was instrumented for coverage: \`${foreign[0]}\`), which the page does not have — pass the value as an argument: ${source.slice(0, 120)}`,
    );
  }
  if (!checked.has(source)) {
    const outside = [...freeNames(source)].filter(
      (name) => !PAGE_GLOBALS.has(name) && !PAGE_CLASS.test(name),
    );
    if (outside.length > 0) {
      throw new Error(
        `A page function names ${outside.map((name) => `\`${name}\``).join(', ')}, which is not its own and not a page global it may use: pass the value as an argument (the page's own property as \`window.${String(outside[0])}\`, or list a page global in PAGE_GLOBALS): ${source.slice(0, 160)}`,
      );
    }
    checked.add(source);
  }
  return source;
};

let kitSource: string | undefined;

/** The expression that calls `page` in the page with a fresh kit and `args`, each as JSON. */
export const pageExpression = (
  page: (...args: never) => unknown,
  args: ReadonlyArray<unknown>,
): string => {
  kitSource ??= pageSource(pageKit);
  const sent = args.map((arg) => `, ${JSON.stringify(arg) ?? 'undefined'}`).join('');
  return `(${pageSource(page)})((${kitSource})()${sent})`;
};
