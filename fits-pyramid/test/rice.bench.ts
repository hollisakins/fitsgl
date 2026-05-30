import { bench, describe } from 'vitest';
import { riceDecompress } from '../src/rice/index.js';
import fixturesData from './fixtures/rice_fixtures.json';

interface RiceFixture {
  name: string;
  n_values: number;
  block_size: number;
  compressed_b64: string;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const fixtures = (fixturesData as { fixtures: RiceFixture[] }).fixtures;
const pick = (name: string): RiceFixture => fixtures.find((f) => f.name === name)!;

// A realistic high-entropy load (full-range int32) and a typical-image load
// (small random values, what quantized float tiles look like).
const cases = [
  pick('rand_full_int32_32768'),
  pick('rand_small_100000'),
  pick('ramp_100000'),
];

describe('riceDecompress throughput', () => {
  for (const fx of cases) {
    const bytes = b64ToBytes(fx.compressed_b64);
    // Output MB decoded per call = n_values * 4 bytes.
    bench(`${fx.name} (${(fx.n_values * 4) / 1e6} MB out)`, () => {
      riceDecompress(bytes, fx.n_values, fx.block_size);
    });
  }
});
