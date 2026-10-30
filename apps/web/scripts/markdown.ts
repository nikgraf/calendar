import { marked } from 'marked';
import type { Plugin } from 'vite';

/**
 * Markdown → HTML for the pages that are Markdown files in the repo (the
 * privacy policy). GitHub-flavored, synchronous, no HTML sanitizing: the
 * sources are our own files, never user input.
 */
export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false, gfm: true });
}

/** `import html from './file.md'` → the rendered HTML as a string. */
export function markdown(): Plugin {
  return {
    name: 'solunivo:markdown',
    transform(code, id) {
      if (!id.endsWith('.md')) {
        return null;
      }
      return {
        code: `export default ${JSON.stringify(renderMarkdown(code))};`,
        map: null,
      };
    },
  };
}
