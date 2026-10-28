import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { markdown } from './scripts/markdown.ts';

// The dev server (`vp dev`) renders the site client-side from index.html;
// the production build (`scripts/build.ts`) renders every route to static
// HTML with this same config and ships no JavaScript. `vp preview` serves
// that output (`/privacy` → `privacy.html`).
export default defineConfig(({ command, isSsrBuild }) => {
  if (command === 'build' && !isSsrBuild) {
    // A plain `vp build` would bundle the dev-only index.html as a
    // client-rendered app into dist/, in place of the static pages.
    throw new Error(
      'Build the website with `pnpm --filter @calendar/web build` (scripts/build.ts), not `vp build`.',
    );
  }
  return {
    plugins: [markdown(), tailwindcss(), react()],
  };
});
