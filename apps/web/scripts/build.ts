/**
 * Static build: one SSR bundle of `src/entry-server.tsx` (with its CSS,
 * fonts and images emitted as hashed assets), then every route rendered to
 * `dist/` (`index.html`, `privacy.html`). The site ships no JavaScript.
 * The brand's Inter is cut down to the characters the pages draw, renamed
 * after its new bytes, and preloaded; the stylesheet that points at it is
 * renamed after its new bytes too. Files in `public/` are copied as they are.
 *
 *   pnpm --filter @calendar/web build
 */
import { existsSync } from 'node:fs';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import subsetFont from 'subset-font';
import { build, type Rolldown } from 'vite';
import { glyphText, hashedName, pageFile } from './assets.ts';

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
const fontFile = output.find(
  (item) =>
    item.type === 'asset' &&
    item.originalFileNames.some((name) => name.endsWith('/InterVariable.woff2')),
)?.fileName;

const { render, routes } = (await import(
  pathToFileURL(path.join(ssrOut, entry.fileName)).href
)) as ServerEntry;
const url = (fileName: string) => `/${fileName}`;

await rm(dist, { force: true, recursive: true });
await cp(path.join(ssrOut, 'assets'), path.join(dist, 'assets'), { recursive: true });

let css = cssFiles.map(url);
let font: string | undefined;
let fontReport = '';
if (fontFile) {
  // A first pass for the text alone; the final pages carry the new names.
  const pages = routes.map((route) => render(route, { css }));
  const full = await readFile(path.join(ssrOut, fontFile));
  const subset = await subsetFont(full, glyphText(pages), { targetFormat: 'woff2' });
  const subsetFile = `assets/${hashedName('InterVariable', '.woff2', subset)}`;
  const subsetUrl = url(subsetFile);
  await writeFile(path.join(dist, subsetFile), subset);
  await rm(path.join(dist, fontFile));

  // The stylesheets name the font by its old file, and a stylesheet's own
  // name must change with its bytes, or a cached one asks for a font this
  // deploy no longer has.
  let pointers = 0;
  css = [];
  for (const cssFile of cssFiles) {
    const source = await readFile(path.join(dist, cssFile), 'utf8');
    pointers += source.split(url(fontFile)).length - 1;
    const rewritten = source.replaceAll(url(fontFile), subsetUrl);
    const stem = path.basename(cssFile, '.css').replace(/-[\w-]{8}$/, '');
    const renamed = `assets/${hashedName(stem, '.css', rewritten)}`;
    await rm(path.join(dist, cssFile));
    await writeFile(path.join(dist, renamed), rewritten);
    css.push(url(renamed));
  }
  if (pointers === 0) {
    throw new Error(`No stylesheet points at ${url(fontFile)}, so the subset would be unused.`);
  }
  font = subsetUrl;
  fontReport = `, Inter ${Math.round(full.length / 1024)} → ${Math.round(subset.length / 1024)} KB`;
}

for (const route of routes) {
  await writeFile(path.join(dist, pageFile(route)), render(route, { css, font }));
}
if (existsSync(publicDir)) {
  await cp(publicDir, dist, { recursive: true });
}
process.stdout.write(
  `Built ${routes.length} pages into ${path.relative(process.cwd(), dist)}${fontReport}\n`,
);
