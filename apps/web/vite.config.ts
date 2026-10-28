import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { markdown } from './scripts/markdown.ts';
import { staticRoutes } from './scripts/preview.ts';

// The dev server (`vp dev`) renders the site client-side from index.html;
// the production build (`scripts/build.ts`) renders every route to static
// HTML with this same config and ships no JavaScript. `vp preview` serves
// that output.
export default defineConfig({
  plugins: [markdown(), staticRoutes(), tailwindcss(), react()],
});
