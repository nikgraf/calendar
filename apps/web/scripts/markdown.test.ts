import { describe, expect, it } from 'vite-plus/test';
import { markdown, renderMarkdown } from './markdown.ts';

describe('renderMarkdown', () => {
  it('renders GitHub-flavored Markdown to HTML', () => {
    const html = renderMarkdown(
      '# Title\n\n_Last updated: 2026-10-10_\n\n- **Bold** item\n- [a link](https://example.com)\n',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>Last updated: 2026-10-10</em>');
    expect(html).toContain('<li><strong>Bold</strong> item</li>');
    expect(html).toContain('<a href="https://example.com">a link</a>');
  });
});

describe('markdown plugin', () => {
  const plugin = markdown();
  const transform = plugin.transform as (code: string, id: string) => { code: string } | null;

  it('turns a .md import into a default-exported HTML string', () => {
    const result = transform('## Section\n\nText.', '/repo/PRIVACY.md');
    expect(result?.code).toBe(String.raw`export default "<h2>Section</h2>\n<p>Text.</p>\n";`);
  });

  it('leaves other files alone', () => {
    expect(transform('# not markdown', '/repo/src/App.tsx')).toBeNull();
  });
});
