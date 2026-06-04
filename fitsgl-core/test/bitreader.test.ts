import { describe, it, expect } from 'vitest';
import { BitReader } from '../src/rice/index.js';

/** Render bytes as one MSB-first bit string ("10110001..."). */
function bitString(bytes: number[]): string {
  return bytes.map((b) => (b & 0xff).toString(2).padStart(8, '0')).join('');
}

/** Reference MSB-first reader over a bit string, mirroring BitReader semantics. */
class RefReader {
  private pos = 0;
  constructor(private readonly bits: string) {}
  readBits(n: number): number {
    if (n === 0) return 0;
    const slice = this.bits.slice(this.pos, this.pos + n);
    this.pos += n;
    return parseInt(slice, 2) >>> 0;
  }
  readUnary(): number {
    let count = 0;
    while (this.bits[this.pos] === '0') {
      count++;
      this.pos++;
    }
    this.pos++; // consume the terminating '1'
    return count;
  }
}

/** Deterministic small PRNG so randomized cross-checks are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('BitReader — MSB-first reads', () => {
  it('reads the very first bit as bit 7 of byte 0', () => {
    // 0b1000_0000 -> first bit is 1; 0b0000_0001 -> first bit is 0.
    expect(new BitReader(Uint8Array.from([0x80])).readBits(1)).toBe(1);
    expect(new BitReader(Uint8Array.from([0x01])).readBits(1)).toBe(0);
  });

  it('reads a full byte MSB-first', () => {
    expect(new BitReader(Uint8Array.from([0xa5])).readBits(8)).toBe(0xa5);
  });

  it('returns 0 for a zero-width read without consuming bits', () => {
    const r = new BitReader(Uint8Array.from([0xff]));
    expect(r.readBits(0)).toBe(0);
    expect(r.readBits(8)).toBe(0xff);
  });

  it('reads each of the spec widths {1,7,8,9,16,17,32} at byte offset 0', () => {
    const widths = [1, 7, 8, 9, 16, 17, 32];
    const bytes = [0b1011_0010, 0xde, 0xad, 0xbe, 0xef, 0x12, 0x34, 0x56, 0x78, 0x9a];
    for (const w of widths) {
      const r = new BitReader(Uint8Array.from(bytes));
      const ref = new RefReader(bitString(bytes));
      expect(r.readBits(w)).toBe(ref.readBits(w));
    }
  });

  it('reads spanning byte boundaries (9- and 17-bit reads)', () => {
    const bytes = [0xff, 0x00, 0xff, 0x00, 0xff];
    const ref = new RefReader(bitString(bytes));
    const r = new BitReader(Uint8Array.from(bytes));
    // 9 bits: all of byte0 + top bit of byte1 -> 0b1_1111_1110 = 0x1FE.
    expect(r.readBits(9)).toBe(ref.readBits(9));
    // 17 bits crossing two more boundaries.
    expect(r.readBits(17)).toBe(ref.readBits(17));
  });

  it('reads a full 32-bit value with the high bit set (unsigned, no sign flip)', () => {
    const bytes = [0xff, 0xff, 0xff, 0xff];
    expect(new BitReader(Uint8Array.from(bytes)).readBits(32)).toBe(0xffffffff);
    const bytes2 = [0x80, 0x00, 0x00, 0x01];
    expect(new BitReader(Uint8Array.from(bytes2)).readBits(32)).toBe(0x80000001);
  });

  it('honours a byteOffset/byteLength window', () => {
    const bytes = [0x11, 0x22, 0x33, 0x44];
    const r = new BitReader(Uint8Array.from(bytes), 2, 2); // window = [0x33, 0x44]
    expect(r.readBits(8)).toBe(0x33);
    expect(r.readBits(8)).toBe(0x44);
    expect(() => r.readBits(1)).toThrow(RangeError);
  });

  it('rejects an out-of-bounds window', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3]);
    expect(() => new BitReader(bytes, 2, 4)).toThrow(RangeError);
    expect(() => new BitReader(bytes, -1)).toThrow(RangeError);
  });

  it('reads right up to the end, then throws on the next bit', () => {
    const r = new BitReader(Uint8Array.from([0xaa]));
    expect(r.readBits(8)).toBe(0xaa);
    expect(() => r.readBits(1)).toThrow(/past end|truncated/i);
  });

  it('throws on readBits(n) with n outside [0,32]', () => {
    const r = new BitReader(Uint8Array.from([0, 0, 0, 0, 0]));
    expect(() => r.readBits(33)).toThrow(RangeError);
    expect(() => r.readBits(-1)).toThrow(RangeError);
  });
});

describe('BitReader — unary reads', () => {
  it('counts leading zeros up to the terminating one', () => {
    // 0b0001_0000 -> three zeros then a one.
    expect(new BitReader(Uint8Array.from([0b0001_0000])).readUnary()).toBe(3);
    // 0b1000_0000 -> zero leading zeros.
    expect(new BitReader(Uint8Array.from([0b1000_0000])).readUnary()).toBe(0);
  });

  it('counts a unary run spanning a byte boundary', () => {
    // 0x00 then 0b0010_0000 -> 8 + 2 = 10 leading zeros.
    const r = new BitReader(Uint8Array.from([0x00, 0b0010_0000]));
    expect(r.readUnary()).toBe(10);
  });

  it('interleaves unary and fixed-width reads consistently with the reference', () => {
    const bytes = [0b0001_1010, 0b0110_0001, 0xc3, 0x07];
    const r = new BitReader(Uint8Array.from(bytes));
    const ref = new RefReader(bitString(bytes));
    expect(r.readUnary()).toBe(ref.readUnary());
    expect(r.readBits(5)).toBe(ref.readBits(5));
    expect(r.readUnary()).toBe(ref.readUnary());
    expect(r.readBits(8)).toBe(ref.readBits(8));
  });

  it('throws if a unary run never terminates before end of buffer', () => {
    const r = new BitReader(Uint8Array.from([0x00, 0x00]));
    expect(() => r.readUnary()).toThrow(/past end|truncated/i);
  });
});

describe('BitReader — randomized cross-check against a reference reader', () => {
  it('matches the reference over many random byte arrays and read schedules', () => {
    const rand = lcg(0xc0ffee);
    for (let trial = 0; trial < 300; trial++) {
      const len = 4 + Math.floor(rand() * 60);
      const bytes: number[] = [];
      for (let i = 0; i < len; i++) bytes.push(Math.floor(rand() * 256));
      const u8 = Uint8Array.from(bytes);
      const bits = bitString(bytes);
      const r = new BitReader(u8);
      const ref = new RefReader(bits);

      let consumed = 0;
      const totalBits = len * 8;
      while (consumed < totalBits) {
        const useUnary = rand() < 0.2;
        if (useUnary) {
          // Only safe to unary-read if a '1' remains in the rest of the stream.
          if (bits.indexOf('1', consumed) === -1) break;
          const expected = ref.readUnary();
          expect(r.readUnary()).toBe(expected);
          consumed += expected + 1;
        } else {
          const remaining = totalBits - consumed;
          const n = Math.min(remaining, 1 + Math.floor(rand() * 32));
          expect(r.readBits(n)).toBe(ref.readBits(n));
          consumed += n;
        }
      }
      expect(r.bitsRemaining()).toBe(totalBits - consumed);
    }
  });
});
