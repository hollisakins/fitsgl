import { bench, describe } from 'vitest';
import { decodeGzip2Tile } from '../src/fpack/decode-gzip2.js';
import { decodeRiceTile } from '../src/fpack/decode-rice.js';
import { loadExpected, b64ToBytes } from './helpers.js';

const e = loadExpected();
const gzipBytes = b64ToBytes(e.sampleGzip2Tile.compressed_b64);
const riceBytes = b64ToBytes(e.sampleRiceTile.compressed_b64);
const r = e.sampleRiceTile;

describe('256x256 tile decode latency', () => {
  bench('GZIP_2 tile (gunzip + unshuffle + BE float32)', async () => {
    await decodeGzip2Tile(gzipBytes, e.sampleGzip2Tile.nPixels);
  });
  bench('RICE_1 tile (RICE decode + dequantize)', () => {
    decodeRiceTile(riceBytes, r.zscale, r.zzero, r.zblank, r.nPixels, r.blockSize);
  });
});
