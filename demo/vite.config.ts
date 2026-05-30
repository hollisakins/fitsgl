import { defineConfig, type Plugin, type Connect } from 'vite';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { dirname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pyramidDir = resolve(here, 'public', 'pyramid');

/**
 * Serve `demo/public/pyramid/*.fits.fz` with byte-accurate HTTP Range (206)
 * support.
 *
 * The Phase 2b fetcher (`httpRangeFetch`) *hard-rejects* a 200 response — it
 * refuses to download a whole file when it asked for a byte range — so a dev
 * server that silently ignored the `Range` header would break every tile fetch.
 * Rather than trust the static handler to honour Range for this extension, we
 * serve these files ourselves: parse `Range: bytes=a-b` (incl. open-ended and
 * suffix forms), reply 206 with `Content-Range`/`Content-Length`, and stream
 * just the requested slice. Registered as a pre-middleware so it intercepts
 * before Vite's static handler, and on the preview server too.
 */
const rangeMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  const url = (req.url ?? '').split('?')[0];
  if (!url.startsWith('/pyramid/') || !url.endsWith('.fits.fz')) {
    next();
    return;
  }

  const rel = decodeURIComponent(url.slice('/pyramid/'.length));
  const filePath = normalize(resolve(pyramidDir, rel));
  // Lexical path-traversal guard: the resolved path must stay inside pyramidDir.
  if (filePath !== pyramidDir && !filePath.startsWith(pyramidDir + sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  // Symlink-safe guard: resolve the real path (collapsing any symlinks) and
  // re-check containment, so a symlink planted inside pyramidDir can't escape it
  // and serve an arbitrary file. realpathSync throws for a missing file -> 404.
  let size: number;
  let etag: string;
  try {
    const realDir = realpathSync(pyramidDir);
    const realPath = realpathSync(filePath);
    if (realPath !== realDir && !realPath.startsWith(realDir + sep)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    const st = statSync(realPath);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
    // Validator from size + mtime; changes whenever the pyramid is rebuilt.
    etag = `"${size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  } catch {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('ETag', etag);
  // Mirror how the production R2/CDN origin will behave so local dev exercises
  // the real browser-cache path: the browser stores tile bytes but revalidates
  // each load, so a rebuilt pyramid (new ETag) is re-fetched while unchanged
  // tiles return 304 (no body). Production uses `immutable` + versioned paths
  // instead — see notes/phase4.md "Production deployment (R2 + Cloudflare)".
  res.setHeader('Cache-Control', 'no-cache');

  // Conditional revalidation: if the cached copy is still current, 304 with no
  // body and the browser serves the requested range from its own cache.
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  const range = req.headers.range;
  if (range === undefined) {
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
    // suffix range: bytes=-N  → last N bytes
    const n = parseInt(m[2], 10);
    start = Math.max(0, size - n);
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

function pyramidRange(): Plugin {
  return {
    name: 'pyramid-range',
    configureServer(server) {
      server.middlewares.use(rangeMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rangeMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [pyramidRange()],
  resolve: {
    // Consume the library's built output. The package was designed so its worker
    // reference (`new URL('../worker.js', import.meta.url)` in tile-source) only
    // resolves against the compiled tree, where `dist/worker.js` exists — Vite's
    // worker plugin can't resolve it from the raw `.ts` source. The npm pre-build
    // hooks keep `dist/` fresh. (The demo runs the engine inline, so that worker
    // is bundled but never instantiated.)
    alias: {
      'fits-pyramid': resolve(repoRoot, 'fits-pyramid', 'dist', 'index.js'),
    },
  },
  server: {
    // The aliased library source lives above the demo root.
    fs: { allow: [repoRoot] },
  },
});
