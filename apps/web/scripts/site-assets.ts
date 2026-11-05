import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import type { AstroIntegration } from 'astro';
import subsetFont from 'subset-font';
import { glyphText, hashedName, missingClasses, undefinedVariables } from './assets.ts';

/** Check Astro's rendered pages and subset the shared brand font to their actual text. */
export function checkSiteAssets(): AstroIntegration {
  const publicDir = new URL('../public/', import.meta.url);
  const stylesheets = new Set<string>();
  let originalFont: string | undefined;
  const checkPublic = (file: string) => {
    if (existsSync(new URL(file, publicDir))) {
      throw new Error(`Generated file collides with public/${file}`);
    }
  };
  return {
    hooks: {
      'astro:build:done': async ({ assets, dir }) => {
        const outputs = [...assets.values()].flat();
        for (const output of outputs) {
          checkPublic(output.href.slice(dir.href.length));
        }

        const pages = await Promise.all(
          outputs
            .filter((file) => file.pathname.endsWith('.html'))
            .map(async (file) => ({ file, html: await readFile(file, 'utf8') })),
        );
        const html = pages.map((page) => page.html);
        const styles = await Promise.all(
          [...stylesheets].map((file) => readFile(new URL(file, dir), 'utf8')),
        );
        const css = styles.join('\n');
        const unstyled = missingClasses(html, css);
        if (unstyled.length) {
          throw new Error(`Classes with no CSS rule: ${unstyled.join(', ')}`);
        }
        const unresolved = undefinedVariables(css);
        if (unresolved.length) {
          throw new Error(`CSS variables used but never defined: ${unresolved.join(', ')}`);
        }

        if (!originalFont) {
          throw new Error('Missing the bundled Inter font.');
        }
        const source = new URL(originalFont, dir);
        const font = await subsetFont(await readFile(source), glyphText(html), {
          targetFormat: 'woff2',
        });
        const subset = hashedName('InterVariable', '.woff2', font);
        const subsetUrl = new URL(subset, source);
        await writeFile(subsetUrl, font, { flag: 'wx' });
        // The preload and inline @font-face are the only references. The external
        // stylesheets keep their original content hashes.
        for (const page of pages) {
          await writeFile(
            page.file,
            page.html.replaceAll(`/${originalFont}`, `/${subsetUrl.href.slice(dir.href.length)}`),
          );
        }
        await rm(source);
      },
      'astro:build:setup': ({ updateConfig }) => {
        updateConfig({
          plugins: [
            {
              generateBundle(_options, bundle) {
                for (const entry of Object.values(bundle)) {
                  if (entry.type === 'asset' || this.environment.name === 'client') {
                    checkPublic(entry.fileName);
                  }
                  if (entry.fileName.endsWith('.css')) {
                    stylesheets.add(entry.fileName);
                  }
                  if (
                    entry.type === 'asset' &&
                    entry.originalFileNames.some((file) => file.endsWith('/InterVariable.woff2'))
                  ) {
                    originalFont = entry.fileName;
                  }
                }
              },
              name: 'solunivo-public-assets',
            },
          ],
        });
      },
    },
    name: 'solunivo-site-assets',
  };
}
