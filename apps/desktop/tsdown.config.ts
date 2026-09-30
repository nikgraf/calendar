import { defineConfig } from 'tsdown';

// Electron main is ESM ("type": "module" → .js); the preload must be CommonJS
// because sandboxed preload scripts cannot use ESM.
//
// The main bundle inlines all workspace/npm deps so the packaged app needs
// no node_modules besides `effect` (left external for its self-referencing
// imports; copied in by the forge packageAfterCopy hook). SQLite is Node's
// built-in node:sqlite — no native modules since the better-sqlite3
// retirement (#36).
export default [
  defineConfig({
    // jsonc-parser's `main` is a UMD build that requires its parts by
    // relative path at runtime; the bundle needs the ESM entry.
    alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
    entry: { main: 'electron/main.ts' },
    external: ['electron'],
    format: 'esm',
    noExternal: [/^(?!electron$)/],
    outDir: 'dist-electron',
    platform: 'node',
    shims: true,
  }),
  defineConfig({
    entry: { preload: 'electron/preload.ts' },
    external: ['electron'],
    format: 'cjs',
    outDir: 'dist-electron',
    platform: 'node',
  }),
];
