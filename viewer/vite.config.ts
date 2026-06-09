import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// The vendored bundle the Python package ships and `fitsgl build` copies into each
// dataset directory. Built straight into fitsgl-py so `npm run build-vendor`
// regenerates the committed artifact in place.
const vendorDir = resolve(repoRoot, 'fitsgl-py', 'src', 'fitsgl', '_viewer');

export default defineConfig({
  // RELATIVE asset URLs (`./assets/...`) so the built site deploys under an
  // arbitrary subpath on a university web server (e.g. /~user/cosmos/), not just
  // a domain root. The viewer also fetches its config relative to document.baseURI.
  base: './',
  plugins: [react()],
  build: {
    outDir: vendorDir,
    emptyOutDir: true, // outDir is outside this project root; opt in explicitly.
  },
  resolve: {
    // Consume the library's COMPILED output (the npm pre-build hooks keep dist/
    // fresh): core via `@fitsgl/core`, the React tier via `@fitsgl/core/react`.
    // Anchored regexes so the `/react` subpath isn't swallowed by the bare alias.
    // The `/worker` alias captures and re-appends the query ($1) so App.tsx's
    // `@fitsgl/core/worker?worker` import keeps the `?worker` suffix Vite's
    // worker plugin dispatches on.
    alias: [
      { find: /^@fitsgl\/core\/react$/, replacement: resolve(repoRoot, 'fitsgl-core', 'dist', 'react', 'index.js') },
      { find: /^@fitsgl\/core\/worker(\?.*)?$/, replacement: `${resolve(repoRoot, 'fitsgl-core', 'dist', 'worker.js')}$1` },
      { find: /^@fitsgl\/core$/, replacement: resolve(repoRoot, 'fitsgl-core', 'dist', 'index.js') },
    ],
  },
  server: {
    // The aliased library output lives above this root.
    fs: { allow: [repoRoot] },
  },
});
