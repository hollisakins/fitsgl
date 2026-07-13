import { describe, it, expect } from 'vitest';
import {
  encodeShareState,
  decodeShareHash,
  buildShareUrl,
  type ShareState,
} from '../../src/react/share-url.js';

const sample: ShareState = {
  c: [150.123456, -2.654321, 3.5],
  m: 'rgb',
  rgb: ['F444W', 'F277W', 'F150W'],
  s: 'log',
  cm: 'viridis',
  n: 1,
};

describe('share-url encode/decode', () => {
  it('round-trips a full view state through the hash token', () => {
    const hash = `#v=${encodeShareState(sample)}`;
    expect(decodeShareHash(hash)).toEqual(sample);
  });

  it('round-trips trilogy knobs and weighted-composite entries', () => {
    const s: ShareState = {
      m: 'rgb',
      s: 'trilogy',
      tp: [0.12, 0.01, 1, 2],
      w: [
        ['F115W', 0, 0, 1],
        ['F277W', 0, 1, 0],
        ['F444W', 1, 0, 0],
      ],
    };
    expect(decodeShareHash(`#v=${encodeShareState(s)}`)).toEqual(s);
  });

  it('finds the v= param among other hash params', () => {
    const hash = `#a=1&v=${encodeShareState({ m: 'single', b: 'F200W' })}&z=9`;
    expect(decodeShareHash(hash)).toEqual({ m: 'single', b: 'F200W' });
  });

  it('produces a base64url token (no +/= that break in a URL)', () => {
    expect(encodeShareState(sample)).not.toMatch(/[+/=]/);
  });

  it('survives non-ASCII band names (UTF-8 safe)', () => {
    const s: ShareState = { b: 'Hα-narrow' };
    expect(decodeShareHash(`#v=${encodeShareState(s)}`)).toEqual(s);
  });

  it('returns null for an absent or malformed token, never throws', () => {
    expect(decodeShareHash('')).toBeNull();
    expect(decodeShareHash('#foo=bar')).toBeNull();
    expect(decodeShareHash('#v=%%%not-base64%%%')).toBeNull();
  });

  it('buildShareUrl replaces the hash on the base URL', () => {
    const url = buildShareUrl('https://example.com/data/#v=old', { b: 'F200W' });
    expect(url.startsWith('https://example.com/data/#v=')).toBe(true);
    expect(decodeShareHash(new URL(url).hash)).toEqual({ b: 'F200W' });
  });
});
