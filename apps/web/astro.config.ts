import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { checkSiteAssets } from './scripts/site-assets.ts';

export default defineConfig({
  build: { assets: 'assets', format: 'file', inlineStylesheets: 'never' },
  integrations: [react(), checkSiteAssets()],
  site: 'https://solunivo.com',
  vite: { plugins: [tailwindcss()] },
});
