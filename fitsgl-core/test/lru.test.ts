import { describe, it, expect } from 'vitest';
import { LRUCache } from '../src/lru.js';

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const c = new LRUCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
    expect(c.get('missing')).toBeUndefined();
    expect(c.size).toBe(2);
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const c = new LRUCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3); // evicts 'a'
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
    expect(c.size).toBe(2);
  });

  it('a get refreshes recency so the other entry is evicted next', () => {
    const c = new LRUCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // 'a' is now most-recent
    c.set('c', 3); // evicts 'b', not 'a'
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.keys()).toEqual(['a', 'c']);
  });

  it('re-setting an existing key updates value and recency', () => {
    const c = new LRUCache<string, number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 10); // refresh 'a'
    c.set('c', 3); // evicts 'b'
    expect(c.get('a')).toBe(10);
    expect(c.has('b')).toBe(false);
  });

  it('rejects an invalid capacity', () => {
    expect(() => new LRUCache<string, number>(0)).toThrow(/positive integer/i);
    expect(() => new LRUCache<string, number>(-1)).toThrow(/positive integer/i);
  });
});
