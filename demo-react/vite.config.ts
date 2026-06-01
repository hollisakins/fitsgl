import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
// Reuse the pyramid the vanilla `demo/` builds (run its `npm run build-pyramid`).
const pyramidDir = resolve(repoRoot, 'demo', 'public', 'pyramid');

const CONTENT_TYPE: Record<string, string> = {
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.fz': 'application/octet-stream',
};

/**
 * Serve `demo/public/pyramid/*` for this harness. The tile `.fits.fz` files MUST
 * answer `Range` with a 206 — the Phase 2b fetcher (`httpRangeFetch`) hard-rejects
 * a 200 to a ranged request — so we stream the requested slice ourselves rather
 * than trust the static handler. The small `dataset.json`/`manifest.json`/
 * `catalog.csv` metadata are served whole. (Same approach as `demo/vite.config.ts`,
 * pointed at the shared pyramid directory so a pyramid is built only once.)
 */
const servePyramid: Connect.NextHandleFunction = (req, res, next) => {
  const url = (req.url ?? '').split('?')[0];
  if (!url.startsWith('/pyramid/')) {
    next();
    return;
  }
  const rel = decodeURIComponent(url.slice('/pyramid/'.length));
  const filePath = normalize(resolve(pyramidDir, rel));
  // Lexical path-traversal guard: stay inside pyramidDir.
  if (filePath !== pyramidDir && !filePath.startsWith(pyramidDir + sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let size: number;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  res.setHeader('Content-Type', CONTENT_TYPE[extname(filePath)] ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  const range = req.headers.range;
  // Metadata (or an un-ranged request): serve the whole file.
  if (!url.endsWith('.fits.fz') || range === undefined) {
    res.statusCode = 200;
    res.setHeader('Content-Length', String(size));
    createReadStream(filePath).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m === null || (m[1] === '' && m[2] === '')) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - parseInt(m[2], 10)); // suffix range bytes=-N
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }
  end = Math.min(end, size - 1);
  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', String(end - start + 1));
  createReadStream(filePath, { start, end }).pipe(res);
};

function pyramidServer(): Plugin {
  return {
    name: 'demo-react-pyramid',
    configureServer(server) {
      server.middlewares.use(servePyramid);
    },
    configurePreviewServer(server) {
      server.middlewares.use(servePyramid);
    },
  };
}

export default defineConfig({
  plugins: [react(), pyramidServer()],
  resolve: {
    // Consume the library's COMPILED output (like the vanilla demo): the core via
    // `fits-pyramid`, the React tier via `fits-pyramid/react`. Anchored regexes so
    // the `/react` subpath isn't swallowed by the bare-specifier alias. The npm
    // pre-build hooks keep `dist/` fresh.
    alias: [
      {
        find: /^fits-pyramid\/react$/,
        replacement: resolve(repoRoot, 'fits-pyramid', 'dist', 'react', 'index.js'),
      },
      { find: /^fits-pyramid$/, replacement: resolve(repoRoot, 'fits-pyramid', 'dist', 'index.js') },
    ],
  },
  server: {
    // The aliased library output and the shared pyramid live above this root.
    fs: { allow: [repoRoot] },
  },
});
