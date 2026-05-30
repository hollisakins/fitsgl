/**
 * Pyramid manifest schema and loader.
 *
 * The manifest is a small JSON sidecar written by the Phase 1 pipeline. It is a
 * convenience index: the client still treats each `.fits.fz` file as
 * self-describing and verifies the real compression type from its `ZCMPTYPE`
 * keyword. We mirror the Phase 1 schema (`pyramid_gen/manifest.py`).
 */

export interface LevelInfo {
  z: number;
  filename: string;
  /** "GZIP_2" or "RICE_1" — a hint; the file's ZCMPTYPE is authoritative. */
  compression: string;
  lossless: boolean;
  /** [H, W] */
  shape: [number, number];
  /** [n_tiles_y, n_tiles_x] */
  fpack_tile_count: [number, number];
  pixel_scale_arcsec: number;
  /** Flat FITS WCS header as {keyword: value}. */
  wcs: Record<string, unknown>;
}

export interface Manifest {
  version: number;
  source_file: string;
  /** [H, W] */
  native_shape: [number, number];
  fpack_tile_size: number;
  /** N, the deepest z index (the pyramid has N+1 levels, z = 0..N). */
  n_levels: number;
  levels: LevelInfo[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asPair(v: unknown, what: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number') {
    throw new Error(`manifest: ${what} must be a [number, number] pair`);
  }
  return [v[0], v[1]];
}

/** Validate and normalize a parsed manifest object. Throws on structural errors. */
export function validateManifest(raw: unknown): Manifest {
  if (!isObject(raw)) throw new Error('manifest: top-level value is not an object');
  if (!Array.isArray(raw.levels)) throw new Error('manifest: "levels" must be an array');

  const levels: LevelInfo[] = raw.levels.map((lvl, idx) => {
    if (!isObject(lvl)) throw new Error(`manifest: level ${idx} is not an object`);
    if (typeof lvl.filename !== 'string') {
      throw new Error(`manifest: level ${idx} is missing a string "filename"`);
    }
    if (typeof lvl.z !== 'number') {
      throw new Error(`manifest: level ${idx} is missing a numeric "z"`);
    }
    return {
      z: lvl.z,
      filename: lvl.filename,
      compression: typeof lvl.compression === 'string' ? lvl.compression : '',
      lossless: lvl.lossless === true,
      shape: asPair(lvl.shape, `level ${idx} shape`),
      fpack_tile_count: asPair(lvl.fpack_tile_count, `level ${idx} fpack_tile_count`),
      pixel_scale_arcsec:
        typeof lvl.pixel_scale_arcsec === 'number' ? lvl.pixel_scale_arcsec : NaN,
      wcs: isObject(lvl.wcs) ? lvl.wcs : {},
    };
  });

  if (levels.length === 0) throw new Error('manifest: "levels" is empty');

  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    source_file: typeof raw.source_file === 'string' ? raw.source_file : '',
    native_shape: asPair(raw.native_shape, 'native_shape'),
    fpack_tile_size: typeof raw.fpack_tile_size === 'number' ? raw.fpack_tile_size : 256,
    n_levels: typeof raw.n_levels === 'number' ? raw.n_levels : levels.length - 1,
    levels,
  };
}

/** Resolve a level filename to an absolute URL relative to the manifest URL. */
export function resolveLevelUrl(manifestUrl: string, filename: string): string {
  return new URL(filename, manifestUrl).toString();
}

/** Fetch and validate a manifest. */
export async function loadManifest(
  manifestUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Manifest> {
  const resp = await fetchImpl(manifestUrl);
  if (!resp.ok) {
    throw new Error(
      `manifest fetch failed: ${resp.status} ${resp.statusText} for ${manifestUrl}`,
    );
  }
  const json: unknown = await resp.json();
  return validateManifest(json);
}
