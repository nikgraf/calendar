import { defineConfig } from 'tsdown';

// Electron main is ESM ("type": "module" → .js); the preload must be CommonJS
// because sandboxed preload scripts cannot use ESM.
//
// better-sqlite3 exists twice: the root copy is compiled for Electron's ABI
// (see rebuild:native), while better-sqlite3-node keeps the system-Node ABI
// for vitest (aliased in the root vite config).
export default [
  defineConfig({
    entry: { main: 'electron/main.ts' },
    external: ['electron'],
    format: 'esm',
    outDir: 'dist-electron',
    platform: 'node',
  }),
  defineConfig({
    entry: { preload: 'electron/preload.ts' },
    external: ['electron'],
    format: 'cjs',
    outDir: 'dist-electron',
    platform: 'node',
  }),
];
