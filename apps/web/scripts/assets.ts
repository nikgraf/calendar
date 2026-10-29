import { createHash } from 'node:crypto';

/**
 * Where a route's page goes in `dist/`: `/` is `index.html`, `/privacy` is
 * `privacy.html`. Static hosts (GitHub Pages, Cloudflare Pages, Netlify)
 * and `vp preview` serve `/privacy` from `privacy.html` without a
 * redirect, so the canonical URL and every link stay slash-free.
 */
export function pageFile(route: string): string {
  const name = route.replaceAll(/^\/+|\/+$/g, '');
  return name === '' ? 'index.html' : `${name}.html`;
}

/** `stem-<8 hex of the content's SHA-256>.ext`: a new name whenever the bytes change. */
export function hashedName(stem: string, extension: string, content: Uint8Array | string): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  return `${stem}-${hash}${extension}`;
}

/**
 * Code point ranges the font always keeps: printable ASCII and Latin-1
 * (so a plain copy edit never needs a new glyph), typographic punctuation
 * (dashes, quotes, bullets, the ellipsis `truncate` draws, ‹ ›), €, ™ and
 * the four arrows. A named entity in the Markdown (`&hellip;`, `&rarr;`)
 * lands in one of these.
 */
const ALWAYS: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x7e],
  [0xa0, 0xff],
  [0x20_10, 0x20_27],
  [0x20_30, 0x20_3a],
  [0x20_ac, 0x20_ac],
  [0x21_22, 0x21_22],
  [0x21_90, 0x21_93],
];

/**
 * The characters the website's font must cover: the `ALWAYS` ranges plus
 * every character the rendered pages hold, numeric entities decoded.
 * Sorted, so the same pages give the same font file.
 */
export function glyphText(pages: ReadonlyArray<string>): string {
  const characters = new Set<string>();
  for (const [from, to] of ALWAYS) {
    for (let code = from; code <= to; code++) {
      characters.add(String.fromCodePoint(code));
    }
  }
  for (const page of pages) {
    const decoded = page.replaceAll(/&#(x[\da-f]+|\d+);/gi, (_, code: string) =>
      String.fromCodePoint(
        code[0]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number(code),
      ),
    );
    for (const character of decoded) {
      if (character >= ' ') {
        characters.add(character);
      }
    }
  }
  return [...characters].sort().join('');
}

/** A class name as a CSS selector writes it (the CSSOM `CSS.escape`). */
export function cssEscape(name: string): string {
  let out = '';
  for (const [index, character] of [...name].entries()) {
    const code = character.codePointAt(0) ?? 0;
    const startsWithDigit =
      (index === 0 && /\d/.test(character)) ||
      (index === 1 && /\d/.test(character) && name.startsWith('-'));
    if (code <= 0x1f || code === 0x7f || startsWithDigit) {
      out += `\\${code.toString(16)} `;
    } else if (index === 0 && character === '-' && name.length === 1) {
      out += String.raw`\-`;
    } else if (code >= 0x80 || /[\w-]/.test(character)) {
      out += character;
    } else {
      out += `\\${character}`;
    }
  }
  return out;
}

/**
 * Classes the pages use that no rule in the stylesheet selects: a utility
 * Tailwind did not know (a typo, a token missing from tailwind.css) emits
 * nothing and fails silently in the browser.
 */
export function missingClasses(pages: ReadonlyArray<string>, css: string): ReadonlyArray<string> {
  const used = new Set<string>();
  for (const page of pages) {
    for (const [, value = ''] of page.matchAll(/\sclass="([^"]*)"/g)) {
      for (const name of value.split(/\s+/)) {
        if (name) {
          used.add(unescapeAttribute(name));
        }
      }
    }
  }
  return [...used].filter((name) => !selects(css, `.${cssEscape(name)}`)).sort();
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

/**
 * An attribute value back to its characters: React escapes `& < > " '`
 * (`'` as `&#x27;`), so `[&>svg]:size-4` reaches the page as
 * `[&amp;&gt;svg]:size-4`. One pass, so `&amp;lt;` stays `&lt;`.
 */
function unescapeAttribute(value: string): string {
  return value.replaceAll(
    /&(?:#(x[\da-f]+|\d+)|(amp|apos|gt|lt|quot));/gi,
    (entity, code: string | undefined, name: string | undefined) =>
      code
        ? String.fromCodePoint(
            code[0]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number(code),
          )
        : (NAMED[name?.toLowerCase() ?? ''] ?? entity),
  );
}

/** Whether `selector` occurs whole: `.px-8` in `.px-8:hover`, not in `.px-80`. */
function selects(css: string, selector: string): boolean {
  for (let at = css.indexOf(selector); at !== -1; at = css.indexOf(selector, at + 1)) {
    const next = css[at + selector.length] ?? '';
    if (!/[\w\-\\]/.test(next) && next < '\u0080') {
      return true;
    }
  }
  return false;
}

/**
 * Custom properties the stylesheet reads with no fallback and never
 * defines (`--x: …` or `@property --x`): a token renamed in tokens.json
 * but not in brand/tokens/tailwind.css leaves its utilities pointing at a
 * variable that resolves to nothing.
 */
export function undefinedVariables(css: string): ReadonlyArray<string> {
  const defined = new Set<string>();
  for (const [, name = ''] of css.matchAll(/(--[\w-]+)\s*:/g)) {
    defined.add(name);
  }
  for (const [, name = ''] of css.matchAll(/@property\s+(--[\w-]+)/g)) {
    defined.add(name);
  }
  const missing = new Set<string>();
  for (const [, name = '', next] of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
    if (next === ')' && !defined.has(name)) {
      missing.add(name);
    }
  }
  return [...missing].sort();
}
