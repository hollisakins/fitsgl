/**
 * Dynamic sizing + durability for the persistent tile cache. Uses the browser
 * Storage API when present (`navigator.storage`), degrading to a fixed cap in
 * Node/tests/older browsers. All functions are safe to call anywhere.
 */

/** Default disk-cache byte budget cap (~1 GiB). */
export const DEFAULT_DISK_CACHE_CAP_BYTES = 1024 * 1024 * 1024;
/** Fraction of the reported storage quota to claim when it is below the cap. */
export const DISK_CACHE_QUOTA_FRACTION = 0.5;

/**
 * Resolve the disk-cache byte budget: `min(cap, quota * fraction)` using
 * `navigator.storage.estimate()` when available, else `cap`.
 */
export async function resolveDiskBudget(
  cap: number = DEFAULT_DISK_CACHE_CAP_BYTES,
  fraction: number = DISK_CACHE_QUOTA_FRACTION,
): Promise<number> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const { quota } = await navigator.storage.estimate();
      if (typeof quota === 'number' && quota > 0) {
        return Math.max(0, Math.min(cap, Math.floor(quota * fraction)));
      }
    }
  } catch {
    // fall through to cap
  }
  return cap;
}

/**
 * Request durable (non-best-effort) storage so the browser does not evict the
 * cache under pressure (Safari's 7-day rule, Chrome's under-pressure LRU).
 * Returns whether durability was granted; a no-op false where unsupported.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // ignore
  }
  return false;
}
