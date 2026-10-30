import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Tailwind's own palette (`bg-amber-50`, `text-red-600`, `text-white`, …)
 * looks the same in both appearances: a box drawn with it stays a bright
 * box in dark mode, and the theme's text on it all but vanishes. The
 * renderer draws with the brand tokens brand/tokens/tailwind.css maps (`bg-surface-raised`,
 * `text-danger`, `text-on-warning`, …). Black is left alone: a scrim dims
 * in either appearance.
 */
const RAW_PALETTE =
  /-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b|\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|caret)-white\b/;

/**
 * A text action that draws its own hover underline (`text-primary
 * hover:underline`, the look before the shared ones): since `primary` is
 * the text's own charcoal, that reads as plain text until hovered. The
 * link and action looks in `ui/buttonStyles.ts` add the missing cue. A
 * bare `text-primary` button still passes; this only keeps the old idiom
 * from coming back.
 */
const OWN_TEXT_ACTION = /\bhover:underline\b/;

const sources = (): ReadonlyArray<string> =>
  readdirSync(import.meta.dirname, { encoding: 'utf8', recursive: true }).filter(
    (path) => /\.tsx?$/.test(path) && !path.includes('.test.'),
  );

/** Every source line `pattern` matches, as `path:line: text`. */
const linesMatching = (pattern: RegExp, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.flatMap((path) =>
    readFileSync(join(import.meta.dirname, path), 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        pattern.test(line) ? [`${path}:${String(index + 1)}: ${line.trim()}`] : [],
      ),
  );

describe('renderer colors', () => {
  it('come from the brand tokens, never from Tailwind’s palette', () => {
    expect(linesMatching(RAW_PALETTE, sources())).toEqual([]);
  });
});

describe('renderer text actions', () => {
  it('leave hover underlines to the shared link and action looks', () => {
    const paths = sources().filter((path) => path !== join('ui', 'buttonStyles.ts'));
    expect(linesMatching(OWN_TEXT_ACTION, paths)).toEqual([]);
  });
});
