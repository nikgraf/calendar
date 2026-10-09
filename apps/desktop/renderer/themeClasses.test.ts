import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Tailwind's own palette (`bg-amber-50`, `text-red-600`, `text-white`, …)
 * looks the same in both appearances: a box drawn with it stays a bright
 * box in dark mode, and the theme's text on it all but vanishes. The
 * renderer draws with the brand tokens App.css maps (`bg-surface-raised`,
 * `text-danger`, `text-on-warning`, …). Black is left alone: a scrim dims
 * in either appearance.
 */
const RAW_PALETTE =
  /-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b|\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|caret)-white\b/;

const sources = (): ReadonlyArray<string> =>
  readdirSync(import.meta.dirname, { encoding: 'utf8', recursive: true }).filter(
    (path) => /\.tsx?$/.test(path) && !path.includes('.test.'),
  );

describe('renderer colors', () => {
  it('come from the brand tokens, never from Tailwind’s palette', () => {
    const found = sources().flatMap((path) =>
      readFileSync(join(import.meta.dirname, path), 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          RAW_PALETTE.test(line) ? [`${path}:${String(index + 1)}: ${line.trim()}`] : [],
        ),
    );
    expect(found).toEqual([]);
  });
});
