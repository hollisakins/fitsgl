/**
 * One fpacked FITS file: lazy metadata, a cached tile index, and per-tile
 * fetch+decode over HTTP range requests.
 *
 * Lifecycle:
 *   1. `FpackFile.open(url, fetcher)` — range-fetch the first ~16 KB, parse the
 *      primary + BINTABLE headers, read the Z, N, and T keywords, and reject any
 *      compression type other than RICE_1 / GZIP_2.
 *   2. `loadTileIndex()` — range-fetch the BINTABLE row table once and parse each
 *      tile's descriptor (+ ZSCALE/ZZERO/ZBLANK for RICE). Cached for O(1) lookup.
 *   3. `getTile(x, y)` — range-fetch just that tile's heap bytes and dispatch on
 *      the compression type to a Float32Array.
 */

import { parseFitsHeader, IncompleteHeaderError, type FitsHeader } from './fits-header.js';
import {
  parseBinTableLayout,
  readDescriptor,
  readFloat64BE,
  type BinTableLayout,
} from './bintable.js';
import { decodeRiceTile } from './decode-rice.js';
import { decodeGzip2Tile } from './decode-gzip2.js';
import { ditherMethodFromZquantiz, NO_DITHER } from './dither.js';

export type CompressionType = 'RICE_1' | 'GZIP_2';

/**
 * Range fetcher: return bytes `[start, endInclusive]` of `url`. Implementations
 * must reject a server that ignores the Range header (HTTP 200). Injectable so
 * tests can serve from a local buffer instead of HTTP.
 */
export type RangeFetcher = (url: string, start: number, endInclusive: number) => Promise<Uint8Array>;

/** Default HTTP range fetcher. Verifies 206 (Partial Content). */
export async function httpRangeFetch(
  url: string,
  start: number,
  endInclusive: number,
): Promise<Uint8Array> {
  const resp = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
  if (resp.status === 200) {
    throw new Error(
      `range request for ${url} returned 200, not 206: the server ignored the ` +
        `Range header. Refusing to download the whole file.`,
    );
  }
  if (resp.status !== 206) {
    throw new Error(`range request for ${url} failed: ${resp.status} ${resp.statusText}`);
  }
  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}

interface TileIndexEntry {
  nBytes: number;
  heapOffset: number;
  zscale: number; // RICE only; NaN otherwise
  zzero: number;
  zblank: number; // NaN when the file declares no blank value
  gzipNBytes: number;
  gzipHeapOffset: number;
}

export interface FpackOpenOptions {
  initialBytes?: number;
}

export class FpackFile {
  readonly url: string;
  readonly compressionType: CompressionType;
  readonly znaxis1: number; // image columns (fast axis)
  readonly znaxis2: number; // image rows (slow axis)
  readonly ztile1: number;
  readonly ztile2: number;
  readonly nTilesX: number;
  readonly nTilesY: number;
  readonly blockSize: number; // RICE ZBLOCKSIZE
  readonly ditherMethod: number; // ZQUANTIZ: NO_DITHER | SUBTRACTIVE_DITHER_1 | _2
  readonly zdither0: number; // ZDITHER0 dither seed (0 when absent / no dither)

  private readonly fetcher: RangeFetcher;
  private readonly layout: BinTableLayout;
  private readonly zblankHeader: number; // NaN if absent
  private readonly headBuffer: Uint8Array;
  private readonly headLen: number;
  private index: TileIndexEntry[] | null = null;
  private indexPromise: Promise<TileIndexEntry[]> | null = null;

  private constructor(args: {
    url: string;
    fetcher: RangeFetcher;
    bintable: FitsHeader;
    layout: BinTableLayout;
    headBuffer: Uint8Array;
    compressionType: CompressionType;
  }) {
    const { url, fetcher, bintable, layout, headBuffer, compressionType } = args;
    this.url = url;
    this.fetcher = fetcher;
    this.layout = layout;
    this.headBuffer = headBuffer;
    this.headLen = headBuffer.length;
    this.compressionType = compressionType;

    this.znaxis1 = bintable.requireInt('ZNAXIS1');
    this.znaxis2 = bintable.requireInt('ZNAXIS2');
    this.ztile1 = bintable.getInt('ZTILE1') ?? this.znaxis1;
    this.ztile2 = bintable.getInt('ZTILE2') ?? 1;
    this.blockSize = bintable.getInt('ZBLOCKSIZE') ?? 32;
    this.zblankHeader = bintable.getInt('ZBLANK') ?? NaN;
    this.ditherMethod = ditherMethodFromZquantiz(bintable.getString('ZQUANTIZ'));
    this.zdither0 = bintable.getInt('ZDITHER0') ?? 0;

    this.nTilesX = Math.ceil(this.znaxis1 / this.ztile1);
    this.nTilesY = Math.ceil(this.znaxis2 / this.ztile2);

    const expectedRows = this.nTilesX * this.nTilesY;
    if (layout.nRows !== expectedRows) {
      throw new Error(
        `fpack ${url}: BINTABLE has ${layout.nRows} rows but the tile grid is ` +
          `${this.nTilesX}x${this.nTilesY} = ${expectedRows}`,
      );
    }

    // A float RICE pyramid quantizes to int32 and stores per-tile ZSCALE/ZZERO
    // columns. A RICE file without them is lossless/integer RICE: there is no
    // linear mapping back to floats, so decoding would silently yield NaN. Reject
    // it loudly rather than emitting a blank tile. (This is a structural check on
    // column presence, not on per-tile values, so a legitimately all-blank tile —
    // whose pixels are caught by the ZBLANK check before dequantization — is
    // unaffected.)
    if (compressionType === 'RICE_1' && !layout.byName.has('ZSCALE')) {
      throw new Error(
        `fpack ${url}: RICE_1 file has no per-tile ZSCALE/ZZERO quantization ` +
          `columns (lossless or integer RICE), which this float pipeline cannot ` +
          `reconstruct to floats`,
      );
    }
  }

  static async open(
    url: string,
    fetcher: RangeFetcher = httpRangeFetch,
    options: FpackOpenOptions = {},
  ): Promise<FpackFile> {
    const initial = options.initialBytes ?? 16384;
    let requested = initial;
    let head = await fetcher(url, 0, requested - 1);

    for (let attempt = 0; ; attempt++) {
      try {
        const primary = parseFitsHeader(head, 0);
        const bintable = parseFitsHeader(head, primary.dataStart);

        const zcmp = bintable.getString('ZCMPTYPE');
        if (zcmp !== 'RICE_1' && zcmp !== 'GZIP_2') {
          throw new Error(
            `fpack ${url}: unsupported ZCMPTYPE ${zcmp === undefined ? '(missing)' : `"${zcmp}"`}; ` +
              `only RICE_1 and GZIP_2 are supported`,
          );
        }
        const layout = parseBinTableLayout(bintable);
        return new FpackFile({
          url,
          fetcher,
          bintable,
          layout,
          headBuffer: head,
          compressionType: zcmp,
        });
      } catch (e) {
        if (!(e instanceof IncompleteHeaderError) || attempt >= 5) throw e;
        const prevLen = head.length;
        requested *= 4;
        head = await fetcher(url, 0, requested - 1);
        if (head.length <= prevLen) throw e; // whole file read, still no END → malformed
      }
    }
  }

  /** Return bytes `[start, start+len)`, served from the head buffer when covered. */
  private async getBytes(start: number, len: number): Promise<Uint8Array> {
    if (start >= 0 && start + len <= this.headLen) {
      return this.headBuffer.subarray(start, start + len);
    }
    const bytes = await this.fetcher(this.url, start, start + len - 1);
    if (bytes.length < len) {
      throw new Error(
        `fpack ${this.url}: expected ${len} bytes at offset ${start}, got ${bytes.length}`,
      );
    }
    return bytes.length === len ? bytes : bytes.subarray(0, len);
  }

  /** Parse and cache the tile index (idempotent; concurrent calls share one fetch). */
  async loadTileIndex(): Promise<TileIndexEntry[]> {
    if (this.index !== null) return this.index;
    if (this.indexPromise !== null) return this.indexPromise;

    this.indexPromise = (async () => {
      const { layout } = this;
      const rowTableLen = layout.rowBytes * layout.nRows;
      const rowBuf = await this.getBytes(layout.dataStart, rowTableLen);

      const cd = layout.byName.get('COMPRESSED_DATA');
      if (cd === undefined) throw new Error(`fpack ${this.url}: BINTABLE has no COMPRESSED_DATA column`);
      const gzipCol = layout.byName.get('GZIP_COMPRESSED_DATA');
      const zscaleCol = layout.byName.get('ZSCALE');
      const zzeroCol = layout.byName.get('ZZERO');
      const zblankCol = layout.byName.get('ZBLANK');
      const rowView = new DataView(rowBuf.buffer, rowBuf.byteOffset, rowBuf.byteLength);

      const entries: TileIndexEntry[] = [];
      for (let r = 0; r < layout.nRows; r++) {
        const rowOff = r * layout.rowBytes;
        const main = readDescriptor(rowBuf, rowOff + cd.offset, cd.kind);
        const gzip =
          gzipCol !== undefined
            ? readDescriptor(rowBuf, rowOff + gzipCol.offset, gzipCol.kind)
            : { nElements: 0, heapOffset: 0 };
        const zscale = zscaleCol !== undefined ? readFloat64BE(rowBuf, rowOff + zscaleCol.offset) : NaN;
        const zzero = zzeroCol !== undefined ? readFloat64BE(rowBuf, rowOff + zzeroCol.offset) : NaN;
        const zblank =
          zblankCol !== undefined ? rowView.getInt32(rowOff + zblankCol.offset, false) : this.zblankHeader;
        entries.push({
          nBytes: main.nElements,
          heapOffset: main.heapOffset,
          zscale,
          zzero,
          zblank,
          gzipNBytes: gzip.nElements,
          gzipHeapOffset: gzip.heapOffset,
        });
      }
      this.index = entries;
      return entries;
    })();

    try {
      return await this.indexPromise;
    } finally {
      this.indexPromise = null;
    }
  }

  /** Pixel dimensions of tile (x, y), accounting for partial edge tiles. */
  tileDims(tileX: number, tileY: number): { width: number; height: number } {
    const width = Math.min(this.ztile1, this.znaxis1 - tileX * this.ztile1);
    const height = Math.min(this.ztile2, this.znaxis2 - tileY * this.ztile2);
    return { width, height };
  }

  async getTile(tileX: number, tileY: number): Promise<Float32Array> {
    if (!Number.isInteger(tileX) || !Number.isInteger(tileY) || tileX < 0 || tileY < 0 || tileX >= this.nTilesX || tileY >= this.nTilesY) {
      throw new Error(
        `fpack ${this.url}: tile (${tileX}, ${tileY}) is out of range for a ` +
          `${this.nTilesX}x${this.nTilesY} grid`,
      );
    }
    const index = await this.loadTileIndex();
    const row = tileY * this.nTilesX + tileX;
    const entry = index[row]!;
    const { width, height } = this.tileDims(tileX, tileY);
    const nPixels = width * height;

    if (entry.nBytes === 0) {
      if (entry.gzipNBytes > 0) {
        throw new Error(
          `fpack ${this.url}: tile (${tileX}, ${tileY}) uses a per-tile GZIP fallback ` +
            `(non-empty GZIP_COMPRESSED_DATA), which is not supported`,
        );
      }
      throw new Error(`fpack ${this.url}: tile (${tileX}, ${tileY}) has empty COMPRESSED_DATA`);
    }

    const start = this.layout.heapStart + entry.heapOffset;
    const bytes = await this.getBytes(start, entry.nBytes);

    if (this.compressionType === 'RICE_1') {
      // `row` (computed above) is the 0-based row-major tile index = the tile's
      // BINTABLE row, which is exactly the index the dither sequence keys off.
      const dither =
        this.ditherMethod === NO_DITHER
          ? undefined
          : { method: this.ditherMethod, seed: this.zdither0, tileIndex: row };
      return decodeRiceTile(
        bytes,
        entry.zscale,
        entry.zzero,
        entry.zblank,
        nPixels,
        this.blockSize,
        dither,
      );
    }
    return decodeGzip2Tile(bytes, nPixels);
  }
}
