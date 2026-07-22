import type { Address, Hex } from "viem";
import type { PublishMode } from "../components/publish/ModeToggle";
import type { PolicyInput } from "@ward/sdk";
import { openWardDB, PUBLISHED_CACHE_STORE } from "./persistence";

/**
 * Per-browser cache of full publish results, keyed by `(chainId, oracle, policyId)`.
 *
 * The reveal panel needs more data than the EventStore preserves: the
 * yamlText (for `download policy.md`), the original tx hash (for the
 * explorer link), the mode (enforce vs watch — gates the WatchAgentBinding
 * vs Solidity-snippet panel), and the policyInputJSON (for the watcher's
 * bind-time policy capture). EventStore.getPolicy only retains
 * `{policyId, owner, label, publishedBlock, lastUpdatedBlock}`.
 *
 * Cross-browser revisits fall through to an EventStore lookup in the
 * consumer, which renders a lightweight reveal (policyId + label +
 * publisher; no download, no watch binding). The cache is the path for
 * the SAME browser to revisit the SAME publish moment in full.
 *
 * Storage: IndexedDB (object store `publishedCache` in the shared ward
 * DB, see persistence.ts). Previous versions used `localStorage`, which
 * was lost whenever the user cleared site data — even though the
 * EventStore (in IDB) survived. Unifying both onto IDB makes persistence
 * consistent: one "clear site data" wipes everything, but partial clears
 * no longer create skewed reveal/event state.
 *
 * Migration: on first read with the new code, any pre-existing
 * `ward-published:*` localStorage entries are copied into IDB and the
 * originals deleted. The migration runs at most once per browser via a
 * module-scoped guard.
 *
 * No size cap. A typical user publishes a few policies; if this ever
 * becomes a real problem we can add an LRU eviction keyed on
 * `publishedAtMs`.
 */

const LEGACY_PREFIX = "ward-published";

export interface PublishedCacheEntry {
  policyId: Hex;
  txHash: Hex;
  publisher: Address;
  label: string;
  yamlText: string;
  mode: PublishMode;
  policyInputJSON?: string;
  publishedAtMs: number;
  /** Set when the entry was recovered from on-chain calldata rather than
   *  written by the original publish flow. Consumers can use this to
   *  distinguish a synthesized cache record (no yamlText, no PublishedReveal
   *  context) from a first-party publish — e.g. to hide "download policy.md"
   *  or to show a "recovered from chain" badge. Round-trips through IDB as
   *  a plain boolean. */
  recoveredFromChain?: boolean;
}

interface CacheRecord extends PublishedCacheEntry {
  /** IDB object-store key — `${chainId}:${oracle}:${policyId}` lowercase. */
  key: string;
}

function cacheKey(chainId: number, oracle: Address, policyId: Hex): string {
  return `${chainId}:${oracle.toLowerCase()}:${policyId.toLowerCase()}`;
}

/**
 * Parse a legacy localStorage key back into its (chainId, oracle, policyId)
 * parts. Returns null if the key isn't shaped like one of ours — defensive
 * against unrelated `ward-published`-prefixed keys (none currently exist,
 * but the prefix is generic enough to want to be safe). Exposed for tests.
 */
export function parseLegacyKey(
  legacyKey: string,
): { chainId: number; oracle: Address; policyId: Hex } | null {
  if (!legacyKey.startsWith(`${LEGACY_PREFIX}:`)) return null;
  const rest = legacyKey.slice(LEGACY_PREFIX.length + 1);
  const parts = rest.split(":");
  if (parts.length !== 3) return null;
  const [chainStr, oracle, policyId] = parts;
  const chainId = Number(chainStr);
  if (!Number.isInteger(chainId) || chainId <= 0) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(oracle)) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(policyId)) return null;
  return {
    chainId,
    oracle: oracle as Address,
    policyId: policyId as Hex,
  };
}

function isValidEntry(parsed: Partial<PublishedCacheEntry> | null): parsed is PublishedCacheEntry {
  if (!parsed) return false;
  // Match the same field guards readPublished applied previously — the
  // reveal only renders if these three are present.
  return Boolean(parsed.policyId && parsed.txHash && parsed.publisher);
}

let migrationPromise: Promise<number> | null = null;

/**
 * Read every legacy `ward-published:*` localStorage entry, write each into
 * IDB, then delete the originals. Idempotent: subsequent invocations short-
 * circuit through the cached promise. Returns the count migrated this call
 * (0 on every call after the first per browser).
 *
 * Exposed for tests so the migration can be triggered deterministically
 * without going through a read.
 */
export async function migrateLocalStorageIfNeeded(): Promise<number> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    if (typeof localStorage === "undefined") return 0;
    const toMigrate: Array<{ legacyKey: string; record: CacheRecord }> = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const legacyKey = localStorage.key(i);
      if (!legacyKey) continue;
      const parsed = parseLegacyKey(legacyKey);
      if (!parsed) continue;
      const raw = localStorage.getItem(legacyKey);
      if (!raw) continue;
      let entry: Partial<PublishedCacheEntry> | null = null;
      try {
        entry = JSON.parse(raw) as Partial<PublishedCacheEntry>;
      } catch {
        // Corrupt JSON. Skip and leave the legacy key in place — deleting
        // unparseable data without copying would silently destroy it.
        continue;
      }
      if (!isValidEntry(entry)) continue;
      toMigrate.push({
        legacyKey,
        record: {
          ...entry,
          key: cacheKey(parsed.chainId, parsed.oracle, parsed.policyId),
        },
      });
    }
    if (toMigrate.length === 0) return 0;

    const db = await openWardDB();
    let migratedCount = 0;
    const migratedLegacyKeys: string[] = [];
    try {
      const tx = db.transaction(PUBLISHED_CACHE_STORE, "readwrite");
      for (const { record, legacyKey } of toMigrate) {
        // Non-clobbering: if an IDB entry already exists under this key,
        // the IDB entry is presumed newer (a write happened after the
        // legacy localStorage write — possibly via the new-code path) and
        // we leave it alone. The legacy localStorage entry is then stale
        // and we drop it from the legacy store as part of this migration.
        // Without this guard, going (new code → IDB write) → (legacy code
        // → localStorage write) → (new code reload → migration) would
        // overwrite the newer IDB entry with the older localStorage one.
        const existing = (await tx.store.get(record.key)) as CacheRecord | undefined;
        if (!existing) {
          await tx.store.put(record);
          migratedCount += 1;
        }
        migratedLegacyKeys.push(legacyKey);
      }
      await tx.done;
    } finally {
      db.close();
    }
    // Only delete legacy keys AFTER the IDB tx commits — if the tx threw
    // mid-write we'd have lost both copies. Includes keys whose record was
    // skipped because IDB already had a (newer) entry — that legacy copy is
    // now stale and we don't want it resurrected on a future migration run.
    for (const legacyKey of migratedLegacyKeys) {
      try {
        localStorage.removeItem(legacyKey);
      } catch {
        // Quota/access errors on removal are non-fatal — the IDB copy is
        // authoritative; the leftover legacy keys are inert.
      }
    }
    console.log(
      `[publishedCache] migrated ${migratedCount}/${toMigrate.length} entries to IndexedDB`,
    );
    return migratedCount;
  })();
  return migrationPromise;
}

/** Internal: reset the migration latch. Tests only. */
export function __resetMigrationForTests(): void {
  migrationPromise = null;
}

export async function cachePublished(
  chainId: number,
  oracle: Address,
  entry: PublishedCacheEntry,
): Promise<void> {
  try {
    const db = await openWardDB();
    try {
      const tx = db.transaction(PUBLISHED_CACHE_STORE, "readwrite");
      const record: CacheRecord = { ...entry, key: cacheKey(chainId, oracle, entry.policyId) };
      await tx.store.put(record);
      await tx.done;
    } finally {
      db.close();
    }
  } catch {
    // IDB unavailable (private browsing in some Firefox configs, or quota
    // exceeded). Silent — same-browser revisit simply falls through to the
    // EventStore lightweight path, matching the previous localStorage behaviour.
  }
}

/**
 * Cache a `PolicyInput` recovered from on-chain calldata (universal recovery).
 *
 * Synthesizes a minimal `PublishedCacheEntry`: `policyInputJSON` is the
 * recovered struct serialized with the same bigint→string-with-`n` convention
 * the SDK and the rest of the dashboard use, plus a `recoveredFromChain: true`
 * flag so downstream readers can distinguish a recovered record from an
 * original publish (no yamlText, no original tx context). `txHash`/`publisher`
 * are populated from the recovered tx/event so the entry passes
 * `isValidEntry` on round-trip; `label`/`yamlText`/`mode` are placeholders
 * because there is no chain source for them. Subsequent edits via the
 * EditPolicy modals will rewrite this entry with full original-publish-shaped
 * data once the user performs any owner action.
 */
export async function cacheRecoveredPolicy(opts: {
  chainId: number;
  oracleAddress: Address;
  policyId: Hex;
  policyInput: PolicyInput;
  txHash: Hex;
  publisher: Address;
}): Promise<void> {
  const { chainId, oracleAddress, policyId, policyInput, txHash, publisher } = opts;
  // Match the bigint serialization convention used by the publish flow and
  // by the edit/pause/extend modals: bigint → plain decimal string, no `n`
  // suffix. PolicyDrawer's reviver handles both shapes, but staying with the
  // simpler one keeps the cache representation uniform across all writers.
  const policyInputJSON = JSON.stringify(policyInput, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  const entry: PublishedCacheEntry = {
    policyId,
    txHash,
    publisher,
    label: "",
    yamlText: "",
    mode: "enforce",
    policyInputJSON,
    publishedAtMs: Date.now(),
    recoveredFromChain: true,
  };
  await cachePublished(chainId, oracleAddress, entry);
}

export async function readPublished(
  chainId: number,
  oracle: Address,
  policyId: Hex,
): Promise<PublishedCacheEntry | null> {
  try {
    // Lazy migration on first read. After the initial run this is a
    // single in-flight promise resolution so it doesn't add latency.
    await migrateLocalStorageIfNeeded();
    const db = await openWardDB();
    try {
      const rec = (await db.get(PUBLISHED_CACHE_STORE, cacheKey(chainId, oracle, policyId))) as
        | CacheRecord
        | undefined;
      if (!rec) return null;
      if (!isValidEntry(rec)) return null;
      // Strip the IDB-internal `key` field so callers see the same shape
      // they did under localStorage.
      const { key: _key, ...entry } = rec;
      void _key;
      return entry;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
