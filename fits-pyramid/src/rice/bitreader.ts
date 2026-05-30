/**
 * Powers of two up to 2**40. Reads never buffer more than 32 + 7 = 39 bits, so
 * index 40 is a safe upper bound. Precomputed to keep `2 ** k` out of the hot
 * decode loop.
 */
const POW2: readonly number[] = Array.from({ length: 41 }, (_, k) => 2 ** k);

/**
 * MSB-first bit reader over a `Uint8Array`.
 *
 * The RICE bitstream produced by CFITSIO packs bits most-significant-first
 * within each byte: the very first bit read is bit 7 of byte 0, then bit 6, and
 * so on down to bit 0 before advancing to the next byte. Getting this byte order
 * wrong is the single most common RICE porting bug, so the bit order lives here
 * in one small, exhaustively-tested place and nothing downstream re-implements
 * it.
 *
 * The reader keeps a numeric accumulator holding the next up-to-~40 buffered
 * bits in its low `nbits` bits. All combination is done with exact double
 * arithmetic (`* 2 ** k`, `Math.floor`) rather than 32-bit bitwise operators so
 * that a full 32-bit read (the RICE high-entropy case) returns a correct
 * unsigned value without sign-bit surprises. Reads never need more than 32 bits
 * at once, so the accumulator never exceeds 32 + 7 = 39 valid bits, well within
 * the 53-bit exact-integer range of a JS number.
 */
export class BitReader {
  private readonly data: Uint8Array;
  /** Exclusive index of one past the last readable byte. */
  private readonly end: number;
  /** Index of the next byte to pull into the accumulator. */
  private bytePos: number;
  /** Bit accumulator: the low `nbits` bits hold the buffered, not-yet-read bits. */
  private acc: number;
  /** Number of valid buffered bits currently in `acc`. */
  private nbits: number;

  /**
   * @param data       backing buffer
   * @param byteOffset first readable byte (default 0)
   * @param byteLength number of readable bytes (default: to end of `data`)
   */
  constructor(data: Uint8Array, byteOffset = 0, byteLength: number = data.length - byteOffset) {
    if (byteOffset < 0 || byteLength < 0 || byteOffset + byteLength > data.length) {
      throw new RangeError(
        `BitReader: window [${byteOffset}, ${byteOffset + byteLength}) is out of bounds ` +
          `for a buffer of length ${data.length}`,
      );
    }
    this.data = data;
    this.bytePos = byteOffset;
    this.end = byteOffset + byteLength;
    this.acc = 0;
    this.nbits = 0;
  }

  /** Buffer a single byte into the accumulator, or throw if the stream is exhausted. */
  private pull(): void {
    if (this.bytePos >= this.end) {
      throw new RangeError(
        `BitReader: ran past end of buffer (read beyond ${this.end} bytes); ` +
          `the stream is truncated or more values were requested than it encodes`,
      );
    }
    // Exact: acc < 2**nbits <= 2**39, * 256 + byte < 2**47, all exact in a double.
    this.acc = this.acc * 256 + this.data[this.bytePos++]!;
    this.nbits += 8;
  }

  /**
   * Read `n` bits (0 <= n <= 32), MSB-first, returning them as an unsigned
   * integer in [0, 2**n).
   */
  readBits(n: number): number {
    if (n === 0) return 0;
    if (n < 0 || n > 32) {
      throw new RangeError(`BitReader.readBits: n must be in [0, 32], got ${n}`);
    }
    while (this.nbits < n) this.pull();
    this.nbits -= n;
    const divisor = POW2[this.nbits]!;
    const result = Math.floor(this.acc / divisor); // top n bits
    this.acc -= result * divisor; // keep the low nbits bits
    return result >>> 0;
  }

  /**
   * Read a unary-coded run: count consecutive 0 bits up to and including the
   * terminating 1 bit, and return the number of leading zeros (the 1 is
   * consumed). This is the RICE "fundamental sequence" prefix.
   */
  readUnary(): number {
    let count = 0;
    for (;;) {
      if (this.nbits === 0) this.pull();
      this.nbits -= 1;
      const divisor = POW2[this.nbits]!;
      const bit = Math.floor(this.acc / divisor); // top bit, 0 or 1
      this.acc -= bit * divisor;
      if (bit === 1) return count;
      count++;
    }
  }

  /** Total number of bits not yet consumed (buffered + still in the backing buffer). */
  bitsRemaining(): number {
    return this.nbits + (this.end - this.bytePos) * 8;
  }

  /**
   * Number of whole bytes consumed from the backing buffer so far, counting a
   * partially-consumed byte as consumed. Used only for diagnostics/notes.
   */
  bytesConsumed(): number {
    const wholeBufferedBytes = Math.floor(this.nbits / 8);
    return this.bytePos - wholeBufferedBytes;
  }
}
