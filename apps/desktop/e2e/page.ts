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
 * the kit below and its arguments, never a variable of the spec's. One that
 * names a spec's constant throws a ReferenceError there — `evaluate` and
 * every wait fail on it at once — and one that names an import is refused
 * before it is sent. Pass the value as an argument.
 *
 * The source is sent as vitest's transform prints it: types stripped, its
 * own quotes, no syntax lowered and no helper added (`page.test.ts` holds
 * it to that). Coverage instrumentation would put its counters in, which
 * the page does not have: the e2e specs never run under it, and a source
 * with them is refused.
 */

/** A value that travels to the page and back as JSON. */
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
