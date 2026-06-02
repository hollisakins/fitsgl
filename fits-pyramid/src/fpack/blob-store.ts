/**
 * Persistent compressed-tile cache — the "disk" tier of the
 * GPU < RAM < disk hierarchy (see docs/multi-tier-cache-plan.md).
 *
 * A `BlobStore` is a string-keyed persistent map of a tile's COMPRESSED bytes.
 * Decode runs downstream of it, so the stored bytes are identical whether they
 * came from the network or disk, and the decode stays bit-exact regardless of
 * source. This module holds the interface plus the pure helpers (key derivation,
 * manifest fingerprint, LRU eviction policy) so they unit-test in Node without
 * IndexedDB; the IndexedDB-backed implementation lives in `idb-blob-store.ts`.
 */

import type { Manifest } from '../manifest.js';

export interface BlobStore {
  /** Compressed bytes for `key`, or `undefined` on a miss. Must never reject. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Store compressed bytes for `key` (LRU-trimmed to budget). Must never reject. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Release underlying resources (e.g. the IDB connection). Optional. */
  close?(): void;
}

/** Stable per-tile cache key: `${fingerprint}/${level}/${tileX}/${tileY}`. */
export function tileBlobKey(
  fingerprint: string,
  level: number,
  tileX: number,
  tileY: number,
): string {
  return `${fingerprint}/${level}/${tileX}/${tileY}`;
}

/** 32-bit FNV-1a hash of a string as 8 hex chars. Dependency-free and stable. */
export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // *= FNV prime, kept in 32 bits
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A short, stable fingerprint of a pyramid's identity, used to namespace its
 * cached tiles so a different (or rebuilt-with-a-changed-manifest) pyramid can't
 * serve another's bytes. Derived from the normalized manifest.
 *
 * Limitation: a rebuild that changes pixel data WITHOUT changing the manifest
 * (same filenames/shapes/WCS) keeps the same fingerprint and would serve stale
 * tiles. A `build_id` stamped by pyramid_gen (plan P6) removes this; until then,
 * bump the manifest (or clear the cache) on such a rebuild.
 */
export function fingerprintManifest(manifest: Manifest): string {
  return fnv1aHex(JSON.stringify(manifest));
}

export interface DiskEntry {
  key: string;
  size: number;
  lastAccess: number;
}

/**
 * Pure LRU eviction policy: when total stored bytes exceed `budgetBytes`, return
 * the keys to evict (least-recently-accessed first) until the total fits; `[]`
 * when already within budget.
 */
export function selectDiskEvictions(entries: DiskEntry[], budgetBytes: number): string[] {
  let total = 0;
  for (const e of entries) total += e.size;
  if (total <= budgetBytes) return [];
  const evict: string[] = [];
  const byOldest = [...entries].sort((a, b) => a.lastAccess - b.lastAccess);
  for (const e of byOldest) {
    if (total <= budgetBytes) break;
    evict.push(e.key);
    total -= e.size;
  }
  return evict;
}
