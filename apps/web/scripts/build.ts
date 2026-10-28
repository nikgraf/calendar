/**
 * Static build: one SSR bundle of `src/entry-server.tsx` (with its CSS,
 * fonts and images emitted as hashed assets), then every route rendered to
 * `dist/` (`index.html`, `privacy.html`). The site ships no JavaScript.
 * The brand's Inter is cut down to the characters the pages draw, renamed
 * after its new bytes, and preloaded; the stylesheet that points at it is
 * renamed after its new bytes too. Files in `public/` are copied as they
 * are, and a generated file may not overwrite one. The build fails on a
 * rendered class no CSS rule selects and on a CSS variable nothing defines.
 *
 *   pnpm --filter @calendar/web build
 */
import { existsSync } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import subsetFont from 'subset-font';
import { build, type Rolldown } from 'vite';
import { glyphText, hashedName, missingClasses, pageFile, undefinedVariables } from './assets.ts';

type ServerEntry = {
  render: (
    route: string,
    options: { css: ReadonlyArray<string>; font?: string | undefined },
  ) => string;
  routes: ReadonlyArray<string>;
};

const root = path.resolve(import.meta.dirname, '..');
const ssrOut = path.join(root, '.build', 'ssr');
const dist = path.join(root, 'dist');
const publicDir = path.join(root, 'public');

const result = await build({
  build: {
    // Copied straight into dist/ below; the SSR out dir is a staging area.
    copyPublicDir: false,
    emptyOutDir: true,
    outDir: ssrOut,
    ssr: 'src/entry-server.tsx',
    ssrEmitAssets: true,
  },
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'warn',
  root,
});
if (!Array.isArray(result) && !('output' in result)) {
  throw new Error('The SSR build started a watcher instead of writing a bundle.');
}
const output = (Array.isArray(result) ? result : [result]).flatMap(
  (bundle: Rolldown.RolldownOutput) => bundle.output,
);
const entry = output.find(
  (item): item is Rolldown.OutputChunk => item.type === 'chunk' && item.isEntry,
);
// The entry's stylesheets in import order, from the bundle's own metadata.
const cssFiles = [...(entry?.viteMetadata?.importedCss ?? [])];
if (!entry || cssFiles.length === 0) {
  throw new Error('The SSR build emitted no entry chunk with a stylesheet.');
}
// The stylesheet always imports brand/fonts/inter.css: no such asset means
// the font moved or was renamed, and the site would ship it whole.
const fontFile = output.find(
  (item) =>
    item.type === 'asset' &&
    item.originalFileNames.some((name) => name.endsWith('/InterVariable.woff2')),
)?.fileName;
if (!fontFile) {
  throw new Error('The SSR build emitted no InterVariable.woff2 to subset.');
}

const { render, routes } = (await import(
  pathToFileURL(path.join(ssrOut, entry.fileName)).href
)) as ServerEntry;
const url = (fileName: string) => `/${fileName}`;

// public/ goes in first, and nothing generated may overwrite it: a file
// there named like a page or an asset is a mistake to stop on, not to win.
await rm(dist, { force: true, recursive: true });
if (existsSync(publicDir)) {
  await cp(publicDir, dist, { recursive: true });
}
const exclusive = { flag: 'wx' } as const;
await cp(path.join(ssrOut, 'assets'), path.join(dist, 'assets'), {
  errorOnExist: true,
  force: false,
  recursive: true,
});

// A first pass for the text alone; the final pages carry the new names.
const draft = routes.map((route) => render(route, { css: cssFiles.map(url) }));
const full = await readFile(path.join(ssrOut, fontFile));
const subset = await subsetFont(full, glyphText(draft), { targetFormat: 'woff2' });
const subsetFile = `assets/${hashedName('InterVariable', '.woff2', subset)}`;
const font = url(subsetFile);
await writeFile(path.join(dist, subsetFile), subset, exclusive);
await rm(path.join(dist, fontFile));

// The stylesheets name the font by its old file, and a stylesheet's own
// name must change with its bytes, or a cached one asks for a font this
// deploy no longer has.
let pointers = 0;
const css: Array<string> = [];
const stylesheets: Array<string> = [];
for (const cssFile of cssFiles) {
  const source = await readFile(path.join(dist, cssFile), 'utf8');
  pointers += source.split(url(fontFile)).length - 1;
  const rewritten = source.replaceAll(url(fontFile), font);
  const stem = path.basename(cssFile, '.css').replace(/-[\w-]{8}$/, '');
  const renamed = `assets/${hashedName(stem, '.css', rewritten)}`;
  await rm(path.join(dist, cssFile));
  await writeFile(path.join(dist, renamed), rewritten, exclusive);
  css.push(url(renamed));
  stylesheets.push(rewritten);
}
if (pointers === 0) {
  throw new Error(`No stylesheet points at ${url(fontFile)}, so the subset would be unused.`);
}

const pages = routes.map((route) => render(route, { css, font }));
// Tailwind emits nothing for a utility it does not know, and a utility
// over a renamed variable compiles to `var(--old)`: both build green and
// draw nothing, so check the output instead.
const allCss = stylesheets.join('\n');
const unstyled = missingClasses(pages, allCss);
if (unstyled.length > 0) {
  throw new Error(`Classes with no CSS rule: ${unstyled.join(' ')}`);
}
const unresolved = undefinedVariables(allCss);
if (unresolved.length > 0) {
  throw new Error(`CSS variables used but never defined: ${unresolved.join(' ')}`);
}
for (const [index, route] of routes.entries()) {
  await writeFile(path.join(dist, pageFile(route)), pages[index] ?? '', exclusive);
}
process.stdout.write(
  `Built ${routes.length} pages into ${path.relative(process.cwd(), dist)}, ` +
    `Inter ${Math.round(full.length / 1024)} → ${Math.round(subset.length / 1024)} KB\n`,
);
