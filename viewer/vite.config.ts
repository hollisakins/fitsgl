import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// The vendored bundle the Python package ships and `fitsgl build` copies into each
// dataset directory. Built straight into pyramid_gen so `npm run build-vendor`
// regenerates the committed artifact in place.
const vendorDir = resolve(repoRoot, 'pyramid_gen', 'src', 'pyramid_gen', '_viewer');

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
    // fresh): core via `fits-pyramid`, the React tier via `fits-pyramid/react`.
    // Anchored regexes so the `/react` subpath isn't swallowed by the bare alias.
    alias: [
      { find: /^fits-pyramid\/react$/, replacement: resolve(repoRoot, 'fits-pyramid', 'dist', 'react', 'index.js') },
      { find: /^fits-pyramid$/, replacement: resolve(repoRoot, 'fits-pyramid', 'dist', 'index.js') },
    ],
  },
  server: {
    // The aliased library output lives above this root.
    fs: { allow: [repoRoot] },
  },
});
