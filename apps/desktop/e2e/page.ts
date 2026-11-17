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
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
      if (!setter) {
        throw new Error(`setValue: ${selector} is no field`);
      }
      setter.call(field, value);
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

/**
 * JavaScript's own globals, as a fresh V8 context has them (`Math`, `JSON`,
 * `undefined`, …), but for the legacy words a spec could have named a
 * helper of its own (`escape`) and `eval`.
 */
const SCRIPT_GLOBALS: ReadonlyArray<string> = (
  runInNewContext('Object.getOwnPropertyNames(globalThis)') as Array<string>
).filter((name) => !['escape', 'eval', 'unescape'].includes(name));

/**
 * The page's own globals a page function may name bare. Never a word a
 * spec could have meant as its own (`name`, `status`, `event`, `open`,
 * `location`, `history`): those are read as `window.name`. Add one here
 * when a page function needs it.
 */
const PAGE_GLOBALS = new Set([
  ...SCRIPT_GLOBALS,
  'AudioContext',
  'AudioWorkletNode',
  'CSS',
  'DataTransfer',
  'DOMRect',
  'Element',
  'MutationObserver',
  'Node',
  'ResizeObserver',
  'URL',
  'arguments',
  'atob',
  'btoa',
  'cancelAnimationFrame',
  'clearInterval',
  'clearTimeout',
  'console',
  'document',
  'getComputedStyle',
  'localStorage',
  'matchMedia',
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

/** One lexical scope: what it binds, and the scope around it. */
interface Scope {
  /** A function's own scope (where `var` and function declarations land), or the whole source's. */
  readonly function: boolean;
  readonly names: Set<string>;
  readonly parent: Scope | null;
}

const inner = (parent: Scope, isFunction = false): Scope => ({
  function: isFunction,
  names: new Set(),
  parent,
});

const functionScope = (scope: Scope): Scope =>
  scope.function || !scope.parent ? scope : functionScope(scope.parent);

const binds = (scope: Scope | null, name: string): boolean =>
  scope !== null && (scope.names.has(name) || binds(scope.parent, name));

/**
 * The names a function's source uses where no scope around the use binds
 * them. Bindings are gathered for the whole source before any use is
 * resolved, so a helper may call one declared after it.
 */
export const freeNames = (source: string): ReadonlySet<string> => {
  const uses: Array<{ name: string; scope: Scope }> = [];
  const walk = (node: AstNode, scope: Scope): void => {
    const handle = HANDLERS[node.type];
    if (handle) {
      handle(node, scope);
      return;
    }
    for (const value of Object.values(node)) {
      nodesIn(value).forEach((child) => walk(child, scope));
    }
  };
  const walkAll = (value: unknown, scope: Scope) =>
    nodesIn(value).forEach((child) => walk(child, scope));
  // A binding pattern: its names go into `target`, its defaults and computed keys are uses.
  const bind = (pattern: AstNode, target: Scope, scope: Scope): void => {
    const bindAll = (value: unknown) =>
      nodesIn(value).forEach((child) => bind(child, target, scope));
    switch (pattern.type) {
      case 'Identifier':
        target.names.add(pattern['name'] as string);
        return;
      case 'ObjectPattern':
        for (const property of nodesIn(pattern['properties'])) {
          if (property['computed']) {
            walkAll(property['key'], scope);
          }
          bindAll(property.type === 'RestElement' ? property['argument'] : property['value']);
        }
        return;
      case 'ArrayPattern':
        bindAll(pattern['elements']);
        return;
      case 'AssignmentPattern':
        bindAll(pattern['left']);
        walkAll(pattern['right'], scope);
        return;
      case 'RestElement':
        bindAll(pattern['argument']);
        return;
      default:
        walk(pattern, scope);
    }
  };
  const fn = (node: AstNode, scope: Scope) => {
    const own = inner(scope, true);
    if (node.type === 'FunctionDeclaration') {
      nodesIn(node['id']).forEach((id) => bind(id, functionScope(scope), scope));
    } else {
      nodesIn(node['id']).forEach((id) => bind(id, own, own));
    }
    nodesIn(node['params']).forEach((param) => bind(param, own, own));
    walkAll(node['body'], own);
  };
  const cls = (node: AstNode, scope: Scope) => {
    const own = inner(scope);
    nodesIn(node['id']).forEach((id) =>
      bind(id, node.type === 'ClassDeclaration' ? scope : own, scope),
    );
    walkAll(node['superClass'], scope);
    walkAll(node['body'], own);
  };
  const block = (node: AstNode, scope: Scope) => {
    const own = inner(scope);
    for (const value of Object.values(node)) {
      walkAll(value, own);
    }
  };
  const keyed = (node: AstNode, scope: Scope) => {
    if (node['computed']) {
      walkAll(node['key'], scope);
    }
    walkAll(node['value'], scope);
  };
  const skip = () => {};
  const HANDLERS: Readonly<Record<string, (node: AstNode, scope: Scope) => void>> = {
    ArrowFunctionExpression: fn,
    BlockStatement: block,
    BreakStatement: skip,
    CatchClause: (node, scope) => {
      const own = inner(scope);
      nodesIn(node['param']).forEach((param) => bind(param, own, own));
      walkAll(node['body'], own);
    },
    ClassDeclaration: cls,
    ClassExpression: cls,
    ContinueStatement: skip,
    ForInStatement: block,
    ForOfStatement: block,
    ForStatement: block,
    FunctionDeclaration: fn,
    FunctionExpression: fn,
    Identifier: (node, scope) => {
      uses.push({ name: node['name'] as string, scope });
    },
    LabeledStatement: (node, scope) => walkAll(node['body'], scope),
    MemberExpression: (node, scope) => {
      walkAll(node['object'], scope);
      if (node['computed']) {
        walkAll(node['property'], scope);
      }
    },
    MetaProperty: skip,
    MethodDefinition: keyed,
    Property: keyed,
    PropertyDefinition: keyed,
    StaticBlock: block,
    SwitchStatement: block,
    VariableDeclaration: (node, scope) => {
      const target = node['kind'] === 'var' ? functionScope(scope) : scope;
      for (const declarator of nodesIn(node['declarations'])) {
        nodesIn(declarator['id']).forEach((id) => bind(id, target, scope));
        walkAll(declarator['init'], scope);
      }
    },
  };
  const root: Scope = { function: true, names: new Set(), parent: null };
  walkAll(parseAst(`(${source})`).body, root);
  return new Set(uses.filter(({ name, scope }) => !binds(scope, name)).map(({ name }) => name));
};

/**
 * The names a page function's source would read from the spec rather
 * than the page: free in it, and neither JavaScript's nor a listed page
 * global.
 */
export const refusedNames = (source: string): ReadonlyArray<string> =>
  [...freeNames(source)].filter((name) => !PAGE_GLOBALS.has(name) && !PAGE_CLASS.test(name));

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
    const outside = refusedNames(source);
    if (outside.length > 0) {
      throw new Error(
        `A page function names ${outside.map((name) => `\`${name}\``).join(', ')}, which is not its own and not a page global it may use: pass a value as an argument, define a helper inside the page function, read the page's own property as \`window.${String(outside[0])}\`, or list a page global in PAGE_GLOBALS: ${source.slice(0, 160)}`,
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
