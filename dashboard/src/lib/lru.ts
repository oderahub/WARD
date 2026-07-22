/**
 * Bounded LRU insert for a Map<key, lastUsedMs>.
 *
 * Keeps the map size below `cap` by evicting the entry with the OLDEST value
 * (interpreted as a wall-clock timestamp in ms) before inserting a new key.
 * Updating an existing key never triggers eviction — only growth past the cap
 * does.
 *
 * Edge cases:
 *   - cap <= 0: the eviction loop drops the single oldest entry (which, if
 *     this insert is the only one, ends up being a no-op pre-insert), then
 *     the new entry is set — so the map ends at size 1, not 0. Callers that
 *     want "no cache" should simply not call this helper.
 *   - cap >= map.size and key absent: plain insert, no eviction.
 *   - key present: value is overwritten, size unchanged.
 */
export function setWithLruCap<K>(
  map: Map<K, number>,
  key: K,
  value: number,
  cap: number,
): void {
  if (!map.has(key) && map.size >= cap) {
    let oldestKey: K | undefined;
    let oldestValue = Infinity;
    for (const [k, v] of map.entries()) {
      if (v < oldestValue) {
        oldestValue = v;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

/**
 * Bounded FIFO insert for a Map<K, V> where the VALUE is the payload (not
 * an LRU-age marker). Eviction order is INSERTION order — the first-inserted
 * key is dropped first — relying on the Map iteration-order spec (insertion
 * order).
 *
 * Why this exists separately from `setWithLruCap`: that helper's value slot
 * IS the LRU-age, so it can't also store arbitrary payloads (e.g. mapping
 * blockNumber -> blockTimestamp). For a "remember the last N
 * (bigint key -> bigint value) lookups" cache, this FIFO discipline is what
 * we want — recency-of-access doesn't matter, only bounding memory does.
 *
 * Edge cases:
 *   - `cap <= 0`: pre-insert eviction drops the (at most) one entry, then
 *     the new entry is set, so size ends at 1. Callers wanting no cache
 *     should skip this helper.
 *   - `cap >= map.size` and key absent: plain insert, no eviction.
 *   - key already present: value is overwritten in place, size unchanged,
 *     insertion order is NOT refreshed (Map.set on an existing key keeps
 *     the original position). This means an "update" doesn't reset the
 *     entry's eviction priority — perfect for a content-addressed cache
 *     where the value never changes for a given key (blockNumber's
 *     timestamp is immutable post-finalisation).
 */
export function setWithFifoCap<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  cap: number,
): void {
  if (!map.has(key) && map.size >= cap) {
    // Map preserves insertion order; `keys().next()` gives the oldest.
    const oldestKey = map.keys().next().value as K | undefined;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}
