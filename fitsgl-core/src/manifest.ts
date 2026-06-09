/**
 * Pyramid manifest schema and loader.
 *
 * The manifest is a small JSON sidecar written by the Phase 1 pipeline. It is a
 * convenience index: the client still treats each `.fits.fz` file as
 * self-describing and verifies the real compression type from its `ZCMPTYPE`
 * keyword. We mirror the Phase 1 schema (`fitsgl/manifest.py`).
 */

/**
 * One supertile: a standalone `.fits.fz` holding a contiguous rectangle of a
 * level's render-tiles. A v1 level is one supertile covering the whole grid; a v2
 * level (a chunked or pre-tiled level) carries a
 * disjoint list that paves the grid. The file's tiles are addressed *local* to the
 * supertile, so `tile_origin` (the one fact the `.fits.fz` cannot self-supply) maps
 * a global tile to its local position.
 */
export interface SupertileInfo {
  filename: string;
  /** [tile_x0, tile_y0] — this supertile's local (0,0) tile in the level's grid. */
  tile_origin: [number, number];
  /** [n_tiles_x, n_tiles_y] — this supertile's own tile grid. */
  tile_count: [number, number];
}

export interface LevelInfo {
  z: number;
  /** First supertile's filename; on v1 levels, the level's single file. */
  filename: string;
  /** "GZIP_2" or "RICE_1" — a hint; the file's ZCMPTYPE is authoritative. */
  compression: string;
  lossless: boolean;
  /** [H, W] */
  shape: [number, number];
  /** [n_tiles_y, n_tiles_x] — the level's TOTAL grid (across all supertiles). */
  fpack_tile_count: [number, number];
  pixel_scale_arcsec: number;
  /** Flat FITS WCS header as {keyword: value}. */
  wcs: Record<string, unknown>;
  /** Disjoint supertiles paving the level grid (v1 synthesizes a single one). */
  supertiles: SupertileInfo[];
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

/**
 * Per-pyramid manifest schema versions this client can read. **v1** = one
 * `.fits.fz` file per level. **v2** = each level carries a `supertiles[]` list (a
 * level chunked under the CDN object-size limit, or parsed from a pre-tiled input
 * mosaic). v1 and version-less manifests are read
 * by synthesizing a single supertile per level, so every existing pyramid keeps
 * working with no migration (decision D9). `SUPPORTED_MANIFEST_VERSION` is the
 * latest the producer writes; both 1 and 2 are accepted.
 */
export const SUPPORTED_MANIFEST_VERSION = 2;
const SUPPORTED_MANIFEST_VERSIONS = new Set<number>([1, 2]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asPair(v: unknown, what: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number') {
    throw new Error(`manifest: ${what} must be a [number, number] pair`);
  }
  return [v[0], v[1]];
}

/**
 * A level's supertiles, with the v1 back-compat shim. A v1 level (single
 * `filename`, no `supertiles`) becomes one supertile covering the whole grid; a v2
 * level carries an explicit disjoint list. `fpackTileCount` is the level's total
 * `[n_tiles_y, n_tiles_x]`.
 */
function parseSupertiles(
  lvl: Record<string, unknown>,
  idx: number,
  fpackTileCount: [number, number],
): SupertileInfo[] {
  const [nTilesY, nTilesX] = fpackTileCount;
  if (lvl.supertiles === undefined) {
    if (typeof lvl.filename !== 'string') {
      throw new Error(`manifest: level ${idx} needs a string "filename" or a "supertiles" array`);
    }
    return [{ filename: lvl.filename, tile_origin: [0, 0], tile_count: [nTilesX, nTilesY] }];
  }
  if (!Array.isArray(lvl.supertiles) || lvl.supertiles.length === 0) {
    throw new Error(`manifest: level ${idx} "supertiles" must be a non-empty array`);
  }
  return lvl.supertiles.map((st, j) => {
    if (!isObject(st)) throw new Error(`manifest: level ${idx} supertile ${j} is not an object`);
    if (typeof st.filename !== 'string') {
      throw new Error(`manifest: level ${idx} supertile ${j} is missing a string "filename"`);
    }
    return {
      filename: st.filename,
      tile_origin: asPair(st.tile_origin, `level ${idx} supertile ${j} tile_origin`),
      tile_count: asPair(st.tile_count, `level ${idx} supertile ${j} tile_count`),
    };
  });
}

/** Validate and normalize a parsed manifest object. Throws on structural errors. */
export function validateManifest(raw: unknown): Manifest {
  if (!isObject(raw)) throw new Error('manifest: top-level value is not an object');
  if (!Array.isArray(raw.levels)) throw new Error('manifest: "levels" must be an array');

  const levels: LevelInfo[] = raw.levels.map((lvl, idx) => {
    if (!isObject(lvl)) throw new Error(`manifest: level ${idx} is not an object`);
    if (typeof lvl.z !== 'number') {
      throw new Error(`manifest: level ${idx} is missing a numeric "z"`);
    }
    const fpackTileCount = asPair(lvl.fpack_tile_count, `level ${idx} fpack_tile_count`);
    const supertiles = parseSupertiles(lvl, idx, fpackTileCount);
    return {
      z: lvl.z,
      // v1 levels carry a top-level filename; for v2 it defaults to the first
      // supertile's so consumers reading `.filename` keep working.
      filename: typeof lvl.filename === 'string' ? lvl.filename : supertiles[0]!.filename,
      compression: typeof lvl.compression === 'string' ? lvl.compression : '',
      lossless: lvl.lossless === true,
      shape: asPair(lvl.shape, `level ${idx} shape`),
      fpack_tile_count: fpackTileCount,
      pixel_scale_arcsec:
        typeof lvl.pixel_scale_arcsec === 'number' ? lvl.pixel_scale_arcsec : NaN,
      wcs: isObject(lvl.wcs) ? lvl.wcs : {},
      supertiles,
    };
  });

  if (levels.length === 0) throw new Error('manifest: "levels" is empty');

  // Version: a MISSING field is a legacy (v1) pyramid → coerce to 1 (D9; every
  // existing pyramid stays valid, read via the single-supertile shim). An EXPLICIT
  // version must be one this client supports, so an unknown future schema surfaces
  // immediately instead of being silently mis-parsed.
  let version = 1;
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) {
      throw new Error(`manifest: "version" must be an integer (got ${JSON.stringify(raw.version)})`);
    }
    if (!SUPPORTED_MANIFEST_VERSIONS.has(raw.version)) {
      throw new Error(
        `manifest: unsupported version ${raw.version} (this client supports ${[...SUPPORTED_MANIFEST_VERSIONS].join(', ')}).`,
      );
    }
    version = raw.version;
  }

  // n_levels is the deepest z index, so a well-formed manifest has exactly
  // n_levels + 1 levels. Cross-check (a missing field is derived) to reject an
  // internally inconsistent manifest rather than mis-select levels later.
  const expectedNLevels = levels.length - 1;
  if (raw.n_levels !== undefined) {
    if (typeof raw.n_levels !== 'number' || raw.n_levels !== expectedNLevels) {
      throw new Error(
        `manifest: n_levels ${JSON.stringify(raw.n_levels)} disagrees with ${levels.length} level(s) (expected ${expectedNLevels}).`,
      );
    }
  }

  return {
    version,
    source_file: typeof raw.source_file === 'string' ? raw.source_file : '',
    native_shape: asPair(raw.native_shape, 'native_shape'),
    fpack_tile_size: typeof raw.fpack_tile_size === 'number' ? raw.fpack_tile_size : 256,
    n_levels: expectedNLevels,
    levels,
  };
}

/** A supertile that covers a global tile, plus that tile's supertile-local coords. */
export interface SupertileMatch {
  supertile: SupertileInfo;
  /** Index of the supertile within the level's `supertiles` array. */
  index: number;
  /** Tile coordinates local to the supertile's own grid. */
  localX: number;
  localY: number;
}

/**
 * Find the supertile of `level` containing global tile (tileX, tileY) and that
 * tile's coordinates local to the supertile's own grid; `undefined` if no
 * supertile covers it (out of the level grid). Pure — unit-tested directly. A
 * linear scan: a level has at most a few hundred supertiles and this runs once per
 * uncached tile, so the cost is negligible.
 */
export function resolveSupertile(
  level: LevelInfo,
  tileX: number,
  tileY: number,
): SupertileMatch | undefined {
  for (let index = 0; index < level.supertiles.length; index++) {
    const st = level.supertiles[index]!;
    const [tx0, ty0] = st.tile_origin;
    const [snx, sny] = st.tile_count;
    if (tileX >= tx0 && tileX < tx0 + snx && tileY >= ty0 && tileY < ty0 + sny) {
      return { supertile: st, index, localX: tileX - tx0, localY: tileY - ty0 };
    }
  }
  return undefined;
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
