/**
 * Where a `??` fallback takes in what follows it. A comparison and a member
 * access both bind tighter than `??`: `x ?? null === 'v'` reads as
 * `x ?? (null === 'v')`, and `x ?? ''.includes('v')` asks `''` alone, so
 * either is `x` whenever the page has it, and a wait on it passes on any
 * text (#230, #317).
 *
 * The specs build their CDP expressions as template strings, where neither
 * tsc nor the lint looks, and the usual way in is a constant ending in
 * `?? null` that reads right on its own and wrong once interpolated before
 * `=== 'v'`. So `Cdp.eval` refuses an expression with either shape as it
 * is sent, interpolations resolved, and `fallbackPrecedence.test.ts` fails
 * on one written out in the e2e sources. The way out is parentheses:
 * `(x ?? null) === 'v'`, or `x ?? (a === b)` when the comparison is the
 * fallback.
 *
 * A pattern, not a parser. A fallback is one operand: a string, a decimal
 * number, a name, `[]` or `{}`, with its member accesses and calls; or an
 * interpolation, a parenthesised group or an array literal; after `!`,
 * `typeof` or `new`. Calls and groups nest one level, an index and an
 * interpolation none. A member access counts only after a literal fallback
 * (`?? ''.includes(…)`): after `?? [...list]` or `?? a.b` it is the
 * fallback's own. So a longer fallback goes unseen (`?? '' + s === 'v'`,
 * `?? 'a' in o`, `?? 1e3 > y`), as does a template with text (a comment's
 * code spans would read as one) and a comment between the fallback and the
 * operator. `<` and `>` count only after a space, which keeps a TypeScript
 * generic call (`?? createStore<State>()`) and a shift out. It cannot tell
 * code from text: `??` and a comparison inside a string or a comment the
 * expression sends are flagged too.
 */

const STRING = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60\x60`;
const NAME = String.raw`[A-Za-z_$][\w$]*`;
const PARENS = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const ARRAY = String.raw`\[[^[\]]*\]`;
const ACCESS = String.raw`\??\.${NAME}|(?:\?\.)?${PARENS}|(?:\?\.)?${ARRAY}`;
const OPERAND = String.raw`(?:!\s*|typeof\s+|new\s+)*(?:${STRING}|-?\d[\d_]*(?:\.\d+)?|${NAME}|\$\{[^{}]*\}|${PARENS}|${ARRAY}|\{\})(?:${ACCESS})*`;
/** Equality, or a relational operator after a space: not a generic's `<`, not a shift. */
const COMPARISON = String.raw`\s*[!=]==?|\s+[<>](?![<>])=?`;
/**
 * Fallbacks a member access would apply to alone. Not a number (its `.` is
 * its fraction), and of arrays only `[]`: `?? [...list].find(…)` means it.
 */
const LITERAL = String.raw`null|undefined|${STRING}|\[\]|\{\}`;

const MISREAD = new RegExp(
  String.raw`\?\?\s*(?:${OPERAND})(?:${COMPARISON})|\?\?\s*(?:${LITERAL})\??\.[A-Za-z_$]`,
  'g',
);

/** Each misread fallback in `source`: where its `??` is, and its text up to the operator. */
export const misreadFallbacks = (source: string): ReadonlyArray<{ index: number; text: string }> =>
  [...source.matchAll(MISREAD)].map((match) => ({
    index: match.index,
    text: match[0].replaceAll(/\s+/g, ' '),
  }));

/** Throws on an expression with a misread fallback, before it reaches the page. */
export const refuseMisreadFallback = (expression: string): void => {
  const [first] = misreadFallbacks(expression);
  if (first !== undefined) {
    throw new Error(
      `\`${first.text}\` compares or reads the fallback alone — parenthesise it, \`(x ?? null) === 'v'\`: …${expression.slice(Math.max(0, first.index - 120), first.index + 120)}…`,
    );
  }
};
