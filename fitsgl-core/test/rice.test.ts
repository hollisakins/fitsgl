import { describe, it, expect } from 'vitest';
import { riceDecompress } from '../src/rice/index.js';
import fixturesData from './fixtures/rice_fixtures.json';

interface RiceFixture {
  name: string;
  n_values: number;
  block_size: number;
  expected_b64: string;
  compressed_b64: string;
}

const fixtures = (fixturesData as { fixtures: RiceFixture[] }).fixtures;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode little-endian int32 bytes into a plain number[] (endianness-safe). */
function expectedInts(b64: string): number[] {
  const bytes = b64ToBytes(b64);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength / 4;
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt32(i * 4, true);
  return out;
}

describe('riceDecompress — fixture decode is bit-exact', () => {
  it('has a non-trivial, deduplicated fixture set', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
    expect(new Set(fixtures.map((f) => f.name)).size).toBe(fixtures.length);
  });

  for (const fx of fixtures) {
    it(`decodes ${fx.name} (n=${fx.n_values}, block=${fx.block_size}) exactly`, () => {
      const compressed = b64ToBytes(fx.compressed_b64);
      const expected = expectedInts(fx.expected_b64);
      expect(expected.length).toBe(fx.n_values);

      const decoded = riceDecompress(compressed, fx.n_values, fx.block_size);
      expect(decoded).toBeInstanceOf(Int32Array);
      expect(decoded.length).toBe(fx.n_values);

      // No tolerance — RICE is lossless. Compare every element.
      let firstMismatch = -1;
      for (let i = 0; i < fx.n_values; i++) {
        if (decoded[i] !== expected[i]) {
          firstMismatch = i;
          break;
        }
      }
      if (firstMismatch !== -1) {
        const i = firstMismatch;
        throw new Error(
          `mismatch at index ${i}: decoded=${decoded[i]} expected=${expected[i]}`,
        );
      }
    });
  }
});

describe('riceDecompress — edge-case lengths', () => {
  it('n=0 returns an empty Int32Array without reading the buffer', () => {
    const out = riceDecompress(new Uint8Array(0), 0);
    expect(out).toBeInstanceOf(Int32Array);
    expect(out.length).toBe(0);
  });

  it('covers n=1, n=blockSize, n=blockSize+1 via fixtures', () => {
    const byName = new Map(fixtures.map((f) => [f.name, f]));
    for (const name of ['single_zero', 'all_zeros_32', 'ramp_up_33']) {
      const fx = byName.get(name);
      expect(fx, `missing fixture ${name}`).toBeDefined();
    }
    // single value
    const one = byName.get('single_neg')!;
    expect(Array.from(riceDecompress(b64ToBytes(one.compressed_b64), 1))).toEqual(
      expectedInts(one.expected_b64),
    );
    // exactly one block
    const block = byName.get('all_zeros_32')!;
    expect(riceDecompress(b64ToBytes(block.compressed_b64), 32).length).toBe(32);
    // one full + one partial block
    const plus1 = byName.get('ramp_up_33')!;
    expect(Array.from(riceDecompress(b64ToBytes(plus1.compressed_b64), 33))).toEqual(
      expectedInts(plus1.expected_b64),
    );
  });

  it('handles a length far larger than the block size (100000)', () => {
    const fx = fixtures.find((f) => f.name === 'rand_small_100000')!;
    const decoded = riceDecompress(b64ToBytes(fx.compressed_b64), fx.n_values, fx.block_size);
    expect(Array.from(decoded)).toEqual(expectedInts(fx.expected_b64));
  });
});

describe('riceDecompress — argument validation', () => {
  const sample = b64ToBytes(fixtures[0]!.compressed_b64);

  it('rejects a negative or non-integer nValues', () => {
    expect(() => riceDecompress(sample, -1)).toThrow(/non-negative integer/i);
    expect(() => riceDecompress(sample, 1.5)).toThrow(/non-negative integer/i);
  });

  it('rejects a non-positive or non-integer blockSize', () => {
    expect(() => riceDecompress(sample, 10, 0)).toThrow(/positive integer/i);
    expect(() => riceDecompress(sample, 10, -32)).toThrow(/positive integer/i);
    expect(() => riceDecompress(sample, 10, 32.5)).toThrow(/positive integer/i);
  });
});

describe('riceDecompress — malformed input throws descriptively', () => {
  it('throws when the buffer is shorter than the 4-byte first-pixel header', () => {
    expect(() => riceDecompress(Uint8Array.from([0x00, 0x01]), 5)).toThrow(/first 4 bytes|first-pixel/i);
  });

  it('throws on a truncated bitstream (high-entropy fixture cut short)', () => {
    const fx = fixtures.find((f) => f.name === 'rand_full_int32_1024')!;
    const full = b64ToBytes(fx.compressed_b64);
    const truncated = full.subarray(0, 12); // header + a few bytes only
    expect(() => riceDecompress(truncated, fx.n_values, fx.block_size)).toThrow(
      /past end|truncated|requested/i,
    );
  });

  it('throws on an invalid FS / k-parameter (out of range)', () => {
    // 4-byte header (first pixel 0) then a byte whose top 5 bits = 31 -> fs = 30 > 25.
    const bytes = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0xf8]);
    expect(() => riceDecompress(bytes, 1, 32)).toThrow(/invalid FS|corrupt/i);
  });

  it('throws when more values are requested than the stream encodes', () => {
    const fx = fixtures.find((f) => f.name === 'rand_small_1024')!;
    const bytes = b64ToBytes(fx.compressed_b64);
    expect(() => riceDecompress(bytes, fx.n_values + 50_000, fx.block_size)).toThrow(
      /past end|truncated|requested/i,
    );
  });

  it('does NOT throw on trailing bytes after the last decoded value', () => {
    const fx = fixtures.find((f) => f.name === 'ramp_up_1024')!;
    const bytes = b64ToBytes(fx.compressed_b64);
    const padded = new Uint8Array(bytes.length + 16);
    padded.set(bytes, 0); // 16 trailing zero bytes
    expect(Array.from(riceDecompress(padded, fx.n_values, fx.block_size))).toEqual(
      expectedInts(fx.expected_b64),
    );
  });
});
