/**
 * Static build: one SSR bundle of `src/entry-server.tsx` (with its CSS,
 * fonts and images emitted as hashed assets), then every route rendered to
 * `dist/<route>/index.html`. The site ships no JavaScript.
 *
 *   pnpm --filter @calendar/web build
 */
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

type ServerEntry = {
  render: (route: string, options: { css: ReadonlyArray<string> }) => string;
  routes: ReadonlyArray<string>;
};

const root = path.resolve(import.meta.dirname, '..');
const ssrOut = path.join(root, '.build', 'ssr');
const dist = path.join(root, 'dist');

await build({
  build: {
    emptyOutDir: true,
    outDir: ssrOut,
    ssr: 'src/entry-server.tsx',
    ssrEmitAssets: true,
  },
  configFile: path.join(root, 'vite.config.ts'),
  logLevel: 'warn',
  root,
});

const assets = path.join(ssrOut, 'assets');
const css = (await readdir(assets))
  .filter((file) => file.endsWith('.css'))
  .map((file) => `/assets/${file}`);
if (css.length === 0) {
  throw new Error(`The SSR build emitted no stylesheet under ${assets}.`);
}

const { render, routes } = (await import(
  pathToFileURL(path.join(ssrOut, 'entry-server.js')).href
)) as ServerEntry;

await rm(dist, { force: true, recursive: true });
await cp(assets, path.join(dist, 'assets'), { recursive: true });
for (const route of routes) {
  const file =
    route === '/'
      ? path.join(dist, 'index.html')
      : path.join(dist, ...route.split('/').filter(Boolean), 'index.html');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, render(route, { css }));
}
process.stdout.write(`Built ${routes.length} pages into ${path.relative(process.cwd(), dist)}\n`);
