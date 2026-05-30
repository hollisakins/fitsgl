import { defineConfig } from 'vitest/config';

// Vitest config only. The library itself is built with `tsc`
// (`tsc -p tsconfig.build.json`), which preserves the module tree so the
// worker URL (`new URL('../worker.js', import.meta.url)`) resolves to the
// emitted `dist/worker.js` in a consumer's bundler.
//
// Tests run under Node; Phase 2b modules that need browser globals
// (DecompressionStream, fetch, Response) rely on those being present in modern
// Node (>=18), which they are.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
