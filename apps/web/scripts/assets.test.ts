import { describe, expect, it } from 'vite-plus/test';
import {
  cssEscape,
  glyphText,
  hashedName,
  missingClasses,
  pageFile,
  undefinedVariables,
} from './assets.ts';

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

  it('keeps the glyphs the browser draws without the text holding them', () => {
    const text = glyphText([]);
    // `truncate` draws an ellipsis; named entities land in these ranges.
    for (const character of ['…', '—', '•', '→', '€', '™']) {
      expect(text).toContain(character);
    }
  });

  it('reads numeric entities as the characters they stand for', () => {
    expect(glyphText(['&#x2603; &#9731; &#X2604;'])).toContain('☃');
    expect(glyphText(['&#X2604;'])).toContain('☄');
  });

  it('gives the same text for the same pages', () => {
    expect(glyphText(['b → a'])).toBe(glyphText(['b → a']));
  });
});

describe('cssEscape', () => {
  it('escapes a class name the way the stylesheet writes it', () => {
    expect(cssEscape('px-8')).toBe('px-8');
    expect(cssEscape('-left-1')).toBe('-left-1');
    expect(cssEscape('sm:px-8')).toBe(String.raw`sm\:px-8`);
    expect(cssEscape('max-w-[1200px]')).toBe(String.raw`max-w-\[1200px\]`);
    expect(cssEscape('text-on-primary/70')).toBe(String.raw`text-on-primary\/70`);
    expect(cssEscape('leading-[1.3]')).toBe(String.raw`leading-\[1\.3\]`);
    expect(cssEscape('2xl:p-4')).toBe(String.raw`\32 xl\:p-4`);
    expect(cssEscape('-')).toBe(String.raw`\-`);
  });
});

describe('missingClasses', () => {
  const css = String.raw`.px-8{padding:2rem}.sm\:px-8{padding:2rem}.max-w-\[1200px\]{max-width:1200px}`;

  it('passes classes the stylesheet selects', () => {
    expect(missingClasses(['<div class="px-8 sm:px-8 max-w-[1200px]"></div>'], css)).toEqual([]);
  });

  it('names classes no rule selects, once each', () => {
    const pages = ['<p class="px-8 bg-canvsa"></p>', '<p class="bg-canvsa  text-inq"></p>'];
    expect(missingClasses(pages, css)).toEqual(['bg-canvsa', 'text-inq']);
  });

  it('does not take a class name that is a prefix of a rule for a match', () => {
    expect(missingClasses(['<p class="px-8"></p>'], '.px-80{padding:20rem}')).toEqual(['px-8']);
  });

  it('reads class names the way React escapes them in an attribute', () => {
    // React writes `[&>svg]:size-4 after:content-['·']` like this.
    const page = '<p class="[&amp;&gt;svg]:size-4 after:content-[&#x27;·&#x27;]"></p>';
    const tailwind = String.raw`.\[\&\>svg\]\:size-4>svg{width:1rem}.after\:content-\[\'·\'\]::after{content:"·"}`;
    expect(missingClasses([page], tailwind)).toEqual([]);
  });
});

describe('undefinedVariables', () => {
  it('passes variables that are defined or read with a fallback', () => {
    const css =
      ':root{--canvas:#fff}@property --tw-shadow{syntax:"*";inherits:false}' +
      '.a{color:var(--canvas)}.b{box-shadow:var(--tw-shadow)}.c{color:var(--tw-ring, red)}';
    expect(undefinedVariables(css)).toEqual([]);
  });

  it('names variables read without a fallback that nothing defines', () => {
    expect(undefinedVariables(':root{--surface:#fff}.a{background:var(--canvas)}')).toEqual([
      '--canvas',
    ]);
  });
});
