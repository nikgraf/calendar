import { describe, expect, it } from 'vite-plus/test';
import { glyphText, hashedName, pageFile } from './assets.ts';

describe('pageFile', () => {
  it('writes the home page as index.html and every other route as <name>.html', () => {
    expect(pageFile('/')).toBe('index.html');
    expect(pageFile('/privacy')).toBe('privacy.html');
    expect(pageFile('/privacy/')).toBe('privacy.html');
  });
});

describe('hashedName', () => {
  it('names a file after its content', () => {
    const name = hashedName('InterVariable', '.woff2', 'a');
    expect(name).toMatch(/^InterVariable-[0-9a-f]{8}\.woff2$/);
    expect(hashedName('InterVariable', '.woff2', 'a')).toBe(name);
    expect(hashedName('InterVariable', '.woff2', 'b')).not.toBe(name);
  });
});

describe('glyphText', () => {
  it('covers ASCII, Latin-1 and every character on the pages, once each', () => {
    const text = glyphText(['<p>“Lunch” – 10–11:30 · ‹ Today ›</p>', '<p>“again”</p>']);
    for (const character of ['A', 'z', '~', 'é', 'ÿ', '“', '”', '–', '·', '‹', '›']) {
      expect(text).toContain(character);
    }
    expect([...text].filter((character) => character === '“')).toHaveLength(1);
    expect(text).not.toContain('\n');
  });

  it('gives the same text for the same pages', () => {
    expect(glyphText(['b → a'])).toBe(glyphText(['b → a']));
  });
});
