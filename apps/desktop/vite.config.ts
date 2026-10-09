import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  base: './',
  // `vp pack` builds Electron main, the agent relay and the preload.
  // Electron main is ESM ("type": "module" → .js); the preload must be
  // CommonJS because sandboxed preload scripts cannot use ESM.
  //
  // The main bundle inlines all workspace/npm deps so the packaged app needs
  // no node_modules besides `effect` (left external for its self-referencing
  // imports; copied in by the forge packageAfterCopy hook). SQLite is Node's
  // built-in node:sqlite — no native modules since the better-sqlite3
  // retirement (#36).
  pack: [
    {
      deps: { alwaysBundle: [/^(?!electron$)/], neverBundle: ['electron'] },
      entry: { main: 'electron/main.ts' },
      format: 'esm',
      outDir: 'dist-electron',
      platform: 'node',
      shims: true,
    },
    // The agent relay (`solunivo-cli`): node built-ins only, so it starts
    // fast under ELECTRON_RUN_AS_NODE and carries none of the main bundle.
    {
      deps: { alwaysBundle: [/.*/] },
      entry: { cli: 'electron/cli.ts' },
      format: 'esm',
      outDir: 'dist-electron',
      platform: 'node',
    },
    {
      deps: { neverBundle: ['electron'] },
      entry: { preload: 'electron/preload.ts' },
      format: 'cjs',
      outDir: 'dist-electron',
      platform: 'node',
    },
  ],
  plugins: [
    babel({
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
    react(),
  ],
});
