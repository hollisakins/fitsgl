/**
 * Minimal insertion-order LRU cache.
 *
 * Backed by a `Map`, whose iteration order is insertion order. On `get` we
 * delete-then-reinsert the key so the most-recently-used entry moves to the end;
 * eviction removes the first (oldest) key. Small and dependency-free by design —
 * the tile cache only needs get/set/eviction.
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`LRUCache: capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency: move to the end.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * Read a value WITHOUT refreshing its recency — a non-mutating peek. Unlike
   * `get`, the entry is not moved to the most-recent end, so the eviction order
   * is untouched. For cheap, high-frequency reads (e.g. a per-pointer-move pixel
   * value peek) where bumping recency would distort which tiles get evicted.
   */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** Keys in LRU order (oldest first). Exposed for tests/diagnostics. */
  keys(): K[] {
    return [...this.map.keys()];
  }
}
