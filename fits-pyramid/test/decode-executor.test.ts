import { describe, it, expect } from 'vitest';
import { WorkerPoolDecoder, inlineDecoder } from '../src/fpack/decode-executor.js';
import { FpackFile } from '../src/fpack/fpack-file.js';
import {
  fixtureRangeFetcher,
  createInProcessWorker,
  readFixtureFloat32,
  firstFloatMismatch,
} from './helpers.js';

const Z1_URL = 'https://fixtures.test/p/synthetic_z1.fits.fz';
const z1Decoded = readFixtureFloat32('z1_decoded.bin');

/** The RICE z1 tile's compressed bytes + decode params (the pool's inputs). */
async function z1BytesAndParams(): Promise<{ bytes: Uint8Array; params: Awaited<ReturnType<FpackFile['tileDecodeParams']>> }> {
  const f = await FpackFile.open(Z1_URL, fixtureRangeFetcher().fetch);
  const bytes = await f.fetchCompressedTile(0, 0);
  const params = await f.tileDecodeParams(0, 0);
  return { bytes, params };
}

describe('inlineDecoder', () => {
  it('decodes a RICE tile bit-identically to the fixture', async () => {
    const { bytes, params } = await z1BytesAndParams();
    const floats = await inlineDecoder.decode(bytes, params);
    expect(firstFloatMismatch(floats, z1Decoded, 0)).toBe(-1);
  });
});

describe('WorkerPoolDecoder', () => {
  it('decodes via the pool bit-identically and spins up `size` workers', async () => {
    const workers: Array<ReturnType<typeof createInProcessWorker>> = [];
    const pool = new WorkerPoolDecoder(2, () => {
      const w = createInProcessWorker();
      workers.push(w);
      return w;
    });
    expect(pool.size).toBe(2);
    const { bytes, params } = await z1BytesAndParams();
    const floats = await pool.decode(bytes, params);
    expect(firstFloatMismatch(floats, z1Decoded, 0)).toBe(-1);
    pool.close();
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it('round-robins many decode jobs across workers, all correct', async () => {
    const pool = new WorkerPoolDecoder(3, () => createInProcessWorker());
    const { bytes, params } = await z1BytesAndParams();
    const results = await Promise.all(Array.from({ length: 7 }, () => pool.decode(bytes, params)));
    for (const r of results) expect(firstFloatMismatch(r, z1Decoded, 0)).toBe(-1);
    pool.close();
  });

  it('clamps a non-positive size to at least one worker', () => {
    const pool = new WorkerPoolDecoder(0, () => createInProcessWorker());
    expect(pool.size).toBe(1);
    pool.close();
  });

  it('rejects decode() after close()', async () => {
    const pool = new WorkerPoolDecoder(1, () => createInProcessWorker());
    pool.close();
    const { bytes, params } = await z1BytesAndParams();
    await expect(pool.decode(bytes, params)).rejects.toThrow(/close/i);
  });
});
