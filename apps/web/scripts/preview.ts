import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * `vp preview` serves `dist/` like a static host would: `/privacy` is
 * `dist/privacy/index.html`. Vite's own preview only tries `privacy.html`
 * for a path without a trailing slash and then falls back to the home page.
 */
export function staticRoutes(): Plugin {
  return {
    configurePreviewServer(server) {
      const outDir = path.resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((request, _response, next) => {
        const url = request.url?.split('?')[0] ?? '';
        if (
          url.length > 1 &&
          !url.endsWith('/') &&
          !path.extname(url) &&
          existsSync(path.join(outDir, url, 'index.html'))
        ) {
          request.url = `${url}/index.html${request.url?.slice(url.length) ?? ''}`;
        }
        next();
      });
    },
    name: 'solunivo:static-routes',
  };
}
