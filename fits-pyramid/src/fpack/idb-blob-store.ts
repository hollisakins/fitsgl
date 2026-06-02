/**
 * IndexedDB-backed {@link BlobStore}: the production "disk" tier.
 *
 * Layout — two object stores in one database, both out-of-line keyed by the
 * tile-blob key string:
 *   - `tiles`: the compressed bytes (a `Uint8Array`, the bulk).
 *   - `index`: a tiny `{ size, lastAccess }` record per tile.
 * On open we scan only `index` (small) to build an in-memory map + running byte
 * total, so startup never reads the bytes. `put` writes both stores in one
 * transaction and LRU-trims to the budget via the pure `selectDiskEvictions`.
 *
 * Every operation is wrapped so a failure (quota exceeded, private-mode, a
 * corrupt DB) degrades to a miss / no-op rather than breaking tile loading — the
 * factory returns `null` when IndexedDB is unavailable, and callers treat that as
 * "no disk tier" and fall through to the network.
 */

import type { BlobStore, DiskEntry } from './blob-store.js';
import { selectDiskEvictions } from './blob-store.js';
import { resolveDiskBudget, requestPersistentStorage } from './cache-size.js';

const DB_NAME = 'fitsgl-tile-cache';
const DB_VERSION = 1;
const STORE_TILES = 'tiles';
const STORE_INDEX = 'index';

interface IndexRecord {
  size: number;
  lastAccess: number;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TILES)) db.createObjectStore(STORE_TILES);
      if (!db.objectStoreNames.contains(STORE_INDEX)) db.createObjectStore(STORE_INDEX);
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = (): void => reject(new Error('IndexedDB open blocked'));
  });
}

class IdbBlobStore implements BlobStore {
  private readonly meta = new Map<string, IndexRecord>();
  private total = 0;
  /** Monotonic recency stamp (seeded above any persisted lastAccess on open). */
  private clock = 0;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly budgetBytes: number,
  ) {}

  static async open(budgetBytes: number): Promise<IdbBlobStore> {
    const db = await openDb();
    const store = new IdbBlobStore(db, budgetBytes);
    await store.loadIndex();
    return store;
  }

  private async loadIndex(): Promise<void> {
    const tx = this.db.transaction(STORE_INDEX, 'readonly');
    const os = tx.objectStore(STORE_INDEX);
    const keys = (await promisify(os.getAllKeys())) as IDBValidKey[];
    const vals = (await promisify(os.getAll())) as IndexRecord[];
    for (let i = 0; i < keys.length; i++) {
      const rec = vals[i]!;
      this.meta.set(String(keys[i]), rec);
      this.total += rec.size;
      if (rec.lastAccess > this.clock) this.clock = rec.lastAccess;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const rec = this.meta.get(key);
    if (rec === undefined) return undefined;
    try {
      const tx = this.db.transaction(STORE_TILES, 'readonly');
      const value = (await promisify(tx.objectStore(STORE_TILES).get(key))) as
        | Uint8Array
        | ArrayBuffer
        | undefined;
      if (value === undefined) {
        // index/data drift — forget the stale index entry.
        this.total -= rec.size;
        this.meta.delete(key);
        return undefined;
      }
      // In-memory recency only: cross-session order is by last write (cheap reads).
      rec.lastAccess = ++this.clock;
      return value instanceof Uint8Array ? value : new Uint8Array(value);
    } catch {
      return undefined;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    try {
      // Store a compact copy: `bytes` may be a subarray of a larger buffer, which
      // structured-clone would otherwise persist in full.
      const compact = bytes.slice();
      const rec: IndexRecord = { size: compact.byteLength, lastAccess: ++this.clock };
      await this.write(key, compact, rec);
      const prev = this.meta.get(key);
      if (prev !== undefined) this.total -= prev.size;
      this.meta.set(key, rec);
      this.total += rec.size;
      await this.evictToBudget();
    } catch {
      // Quota/transaction failure — degrade silently; the tile still loads from net.
    }
  }

  private write(key: string, bytes: Uint8Array, rec: IndexRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction([STORE_TILES, STORE_INDEX], 'readwrite');
      tx.objectStore(STORE_TILES).put(bytes, key);
      tx.objectStore(STORE_INDEX).put(rec, key);
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = (): void => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
  }

  private async evictToBudget(): Promise<void> {
    if (this.total <= this.budgetBytes) return;
    const entries: DiskEntry[] = [];
    for (const [key, rec] of this.meta) entries.push({ key, size: rec.size, lastAccess: rec.lastAccess });
    const victims = selectDiskEvictions(entries, this.budgetBytes);
    if (victims.length === 0) return;
    await this.deleteKeys(victims);
    for (const key of victims) {
      const rec = this.meta.get(key);
      if (rec !== undefined) {
        this.total -= rec.size;
        this.meta.delete(key);
      }
    }
  }

  private deleteKeys(keys: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction([STORE_TILES, STORE_INDEX], 'readwrite');
      const tiles = tx.objectStore(STORE_TILES);
      const index = tx.objectStore(STORE_INDEX);
      for (const k of keys) {
        tiles.delete(k);
        index.delete(k);
      }
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error('IndexedDB delete failed'));
      tx.onabort = (): void => reject(tx.error ?? new Error('IndexedDB delete aborted'));
    });
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Construct the default persistent {@link BlobStore} (IndexedDB), sizing the
 * budget from `navigator.storage.estimate()` and requesting durable storage.
 * Returns `null` when IndexedDB is unavailable (Node, some private modes) or the
 * store can't be opened — callers treat `null` as "no disk tier".
 */
export async function openDefaultBlobStore(): Promise<BlobStore | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    await requestPersistentStorage();
    const budget = await resolveDiskBudget();
    return await IdbBlobStore.open(budget);
  } catch {
    return null;
  }
}
