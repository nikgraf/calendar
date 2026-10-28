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
 * The characters the website's font must cover: printable ASCII and
 * Latin-1 (so a copy edit in plain Latin never needs a new glyph), plus
 * every character the rendered pages hold. Sorted, so the same pages give
 * the same font file.
 */
export function glyphText(pages: ReadonlyArray<string>): string {
  const characters = new Set<string>();
  for (let code = 0x20; code <= 0x7e; code++) {
    characters.add(String.fromCodePoint(code));
  }
  for (let code = 0xa0; code <= 0xff; code++) {
    characters.add(String.fromCodePoint(code));
  }
  for (const page of pages) {
    for (const character of page) {
      if (character >= ' ') {
        characters.add(character);
      }
    }
  }
  return [...characters].sort().join('');
}
