import { defineConfig } from 'tsdown';

// Electron main is ESM ("type": "module" → .js); the preload must be CommonJS
// because sandboxed preload scripts cannot use ESM.
//
// The main bundle inlines all workspace/npm deps so the packaged app needs no
// node_modules besides better-sqlite3 (native, Electron ABI — copied in by the
// forge packageAfterCopy hook; see rebuild:native for the ABI story).
export default [
  defineConfig({
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
