import { openDB, type IDBPDatabase } from "idb";
import type { Address, Hex } from "viem";
import type { PolicyMeta, QueueRecordHeader, StoreEvent } from "@ward/sdk";

/**
 * Dashboard-only IndexedDB snapshot of the SDK event store. The SDK itself
 * stays browser-free; this adapter wraps it and lets the UI resume scanning
 * from the last persisted cursor across reloads.
 *
 * Keying note: a snapshot is namespaced by (chainId, oracleAddress,
 * queueAddress) so switching RPCs or contracts gets a clean cache.
 *
 * BigInts: IndexedDB structured clone supports BigInt in modern browsers, but
 * we serialize via JSON.stringify with bigint→string replacers to stay portable
 * and keep the on-disk format inspectable.
 */

const DB_NAME = "ward-store";
// v5 adds two stores. `ownerIndex` lets the Watched page resume an owner-
// keyed PolicyPublished scan across reloads (the existing snapshots store
// is keyed by chain/oracle/queue and has no owner facet). `publishedCache`
// replaces the previous localStorage-backed publish-reveal cache so the
// reveal panel persists alongside the EventStore in the same backing
// (clearing localStorage no longer wipes yamlText/mode/policyInputJSON).
// Neither store has v4 data to migrate at the upgrade-tx level — ownerIndex
// rebuilds from chain on the next Discover scan; publishedCache is migrated
// from localStorage lazily on first read (see publishedCache.ts).
// v4 bumped the `watched` key schema to include chainId+oracleAddress so the
// same (policyId, agent) pair can be watched across chains without
// colliding. The `watched` store is REKEYED IN PLACE (it's user-configured
// local state and cannot be rebuilt from chain). spend-daily and violations
// are dropped — they rebuild naturally from on-chain history during the
// next polling cycle.
// v9 re-runs the ownerIndex shape heal unconditionally on every upgrade.
// Previous v8 gated the migration on `oldVersion < 8`, which left dbs
// already stamped v8 (from an earlier broken-migration version that
// bumped the version without rewriting the row) stuck carrying the
// legacy `{policyIds, lastSeenBlock}` shape forever. The shape-detecting
// healer below skips already-correct rows and rewrites the rest, so
// bumping to v9 forces every existing db through the heal exactly once.
// v10 adds cachedAgents store: per-(chainId, registryAddress) snapshot of
// WardAgentRegistry for the Tier 3 fallback in agents-catalog.ts.
// Rebuilds from chain on first Tier-2 success — safe to skip if missing.
// Pure additive store: no data migration, no rewrite of existing records.
// v11 adds watchSubscriptions: per-(chainId, agent) record of the operator-
// supplied Slack incoming webhook URL + selected tier from the Watch Wizard.
// The Slack webhook is an OPERATOR SECRET — never log it, mask after entry.
// Distinct from the `watched` store (which holds policy-binding watch flags
// keyed by `${chainId}:${oracleAddress}:${policyId}:${agent}`); this store
// is keyed by `${chainId}:${agent}` and holds Slack-webhook subscriptions.
// Pure additive store, no migration of existing rows.
// v12 is a HEAL bump: re-enters the upgrade callback so users whose db was
// already stamped v11 by an earlier dev-server session — before line 214's
// `watchSubscriptions` create landed — pick up the missing store via the
// idempotent contains-guard. Same pattern as the v5 → v6 heal documented at
// lines 154-161. No new stores beyond v11.
// v13 extends WatchSubscriptionRecord with an optional `telegram` field
// alongside the existing (now-optional) `slackWebhookUrl`, so each
// subscription carries EXACTLY ONE alert channel (Slack OR Telegram —
// enforced by saveWatchSubscription, not by the schema). Purely additive at
// the field level — pre-v13 rows with only `slackWebhookUrl` deserialize
// unchanged because the new `telegram` field is optional. No upgrade-
// callback work is needed (no new store, no key change); the version bump
// is here only to force re-entry into the upgrade callback for symmetry
// with the v6/v9/v12 heal pattern. Every additive bump goes through the
// contains-guarded `watchSubscriptions` create at the bottom of the
// upgrade callback, which stays a no-op for healthy dbs.
const DB_VERSION = 13;
const STORE = "snapshots";
const WATCHED_STORE = "watched";
const SPEND_DAILY_STORE = "spend-daily";
const VIOLATIONS_STORE = "violations";
const OWNER_INDEX_STORE = "ownerIndex";
export const PUBLISHED_CACHE_STORE = "publishedCache";
export const CONTRACT_NAME_STORE = "contractName";
export const CACHED_AGENTS_STORE = "cachedAgents";
export const WATCH_SUBSCRIPTIONS_STORE = "watchSubscriptions";

export const REORG_DEPTH = 12n;

export interface Snapshot {
  schemaVersion: 1;
  cursor: bigint;
  headBlockAtCursor: bigint;
  policiesJSON: string;
  queueRecordsJSON: string;
  eventLogJSON: string;
  chainId: number;
  oracleAddress: string;
  queueAddress: string;
  savedAtMs: number;
}

interface NamespacedRecord {
  namespace: string;
  schemaVersion: 1;
  cursor: string;
  headBlockAtCursor: string;
  policiesJSON: string;
  queueRecordsJSON: string;
  eventLogJSON: string;
  chainId: number;
  oracleAddress: string;
  queueAddress: string;
  savedAtMs: number;
}

interface NamespaceOpts {
  chainId: number;
  oracleAddress: Address;
  queueAddress: Address;
}

function namespaceKey(opts: NamespaceOpts): string {
  return `${opts.chainId}:${opts.oracleAddress.toLowerCase()}:${opts.queueAddress.toLowerCase()}`;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export async function openWardDB(): Promise<IDBPDatabase> {
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "namespace" });
      }
      if (!db.objectStoreNames.contains(WATCHED_STORE)) {
        db.createObjectStore(WATCHED_STORE, { keyPath: "key" });
      }
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains(SPEND_DAILY_STORE)) {
          db.createObjectStore(SPEND_DAILY_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(VIOLATIONS_STORE)) {
          db.createObjectStore(VIOLATIONS_STORE, { keyPath: "key" });
        }
      }
      if (oldVersion > 0 && oldVersion < 4) {
        // v4 widened the watched-store key from `${policyId}:${agent}` to
        // `${chainId}:${oracleAddress}:${policyId}:${agent}` (see
        // watched-policies.ts → watchedKey). The watched store is user-
        // configured local state — it cannot be rebuilt from chain — so we
        // rekey in place using the chainId + oracleAddress fields already
        // present on each record, on the upgrade `versionchange` tx.
        //
        // Collision note: if a v3 db happened to contain two records that
        // would map to the same v4 key (e.g. the same (policyId, agent) was
        // written under two different (chainId, oracle) values due to the
        // prior schema bug), the LAST cursor entry wins. This is a one-time
        // consequence of the missing scope in v3 keys.
        if (db.objectStoreNames.contains(WATCHED_STORE)) {
          // Returned promise is intentionally not awaited — idb's upgrade
          // callback is typed `void`, but the underlying IDB
          // version-change transaction stays alive as long as requests
          // are chained off it within microtasks (which the awaits below
          // do). openDB's outer promise only resolves after the txn
          // commits, so callers still observe a fully-migrated db.
          void rekeyWatchedStoreV3toV4(tx.objectStore(WATCHED_STORE));
        }
        // spend-daily + violations are derived from watch polling and
        // rebuild naturally from on-chain history — safe to drop.
        for (const name of [SPEND_DAILY_STORE, VIOLATIONS_STORE]) {
          if (db.objectStoreNames.contains(name)) {
            db.deleteObjectStore(name);
          }
          db.createObjectStore(name, { keyPath: "key" });
        }
      }
      // v5 added ownerIndex + publishedCache; v6 re-runs the check to heal
      // databases that landed at v5 mid-Wave-1 deploy where one parallel
      // workstream bumped the version before the other had added the store.
      // The contains-guards make this idempotent — running on every upgrade
      // is safe and self-heals any missing store regardless of how the DB
      // got there. Future store additions should follow the same pattern
      // (unconditional contains-guarded create at the BOTTOM of the upgrade
      // callback) and bump DB_VERSION to force re-entry.
      if (!db.objectStoreNames.contains(OWNER_INDEX_STORE)) {
        db.createObjectStore(OWNER_INDEX_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(PUBLISHED_CACHE_STORE)) {
        db.createObjectStore(PUBLISHED_CACHE_STORE, { keyPath: "key" });
      }
      // v7 adds contractName: per-(chainId, address) cache of resolved
      // contract names from the Somnia explorer. Same idempotent contains-
      // guarded create pattern as ownerIndex/publishedCache.
      if (!db.objectStoreNames.contains(CONTRACT_NAME_STORE)) {
        db.createObjectStore(CONTRACT_NAME_STORE, { keyPath: "key" });
      }
      // v8 enriches ownerIndex records: the old shape was
      // `{ policyIds: Hex[], lastSeenBlock }`; the new shape stores
      // `{ entries: { policyId, publishedBlock, lastUpdatedBlock? }[], lastSeenBlock }`
      // so the stale-rehydrate path can feed publishedBlock as a hint into
      // lookupPolicyOnChain and skip the multi-million-block backward walk
      // that previously made a cold reload time out.
      //
      // v9 bumps the version specifically to re-enter this upgrade callback
      // for users whose db was already stamped v8 by an earlier broken
      // migration cycle (the version bumped but the rewrite never landed,
      // leaving rows in legacy `policyIds[]` shape forever — the
      // `oldVersion < 8` guard meant the corrected v8 code couldn't reach
      // them). The healer is SHAPE-detecting, not version-detecting: it
      // runs unconditionally on every upgrade and the cursor iteration
      // skips rows already carrying `entries[]`. That means future schema
      // bumps don't need to re-flag this step, and a db that's already
      // fully migrated pays only the cost of one empty cursor scan.
      if (db.objectStoreNames.contains(OWNER_INDEX_STORE)) {
        void healOwnerIndexShape(tx.objectStore(OWNER_INDEX_STORE));
      }
      // v10 adds cachedAgents: per-(chainId, registryAddress) snapshot of
      // WardAgentRegistry for the Tier 3 fallback in agents-catalog.ts.
      // Same idempotent contains-guarded create pattern as the v5/v6/v7
      // stores above — NOT gated on `oldVersion < 10` per the anti-gate-
      // guard note at lines 144-148. Pure additive: no migration of
      // existing data is needed because nothing previously wrote to this
      // store name.
      if (!db.objectStoreNames.contains(CACHED_AGENTS_STORE)) {
        db.createObjectStore(CACHED_AGENTS_STORE, { keyPath: "key" });
      }
      // v11 adds watchSubscriptions: per-(chainId, agent) record of the
      // operator's Slack incoming webhook URL + tier selected via the
      // Watch Wizard. Same idempotent contains-guarded create pattern as
      // the v5/v6/v7/v10 stores above — NOT gated on `oldVersion < 11`
      // per the anti-gate-guard note at lines 144-148. Pure additive:
      // no migration of existing rows, no data loss, no version-gated
      // guard. The `watched` store is unrelated (it holds policy-binding
      // watch flags keyed by `${chainId}:${oracleAddress}:${policyId}:${agent}`;
      // watchSubscriptions holds Slack webhook bindings keyed by
      // `${chainId}:${agent}`).
      if (!db.objectStoreNames.contains(WATCH_SUBSCRIPTIONS_STORE)) {
        db.createObjectStore(WATCH_SUBSCRIPTIONS_STORE, { keyPath: "key" });
      }
    },
  });
  // Runtime heal: redundant with the upgrade-callback heal, but bullet-proof
  // against IDB lifecycle quirks that occasionally leave the upgrade-callback
  // heal failing silently. The heal is idempotent + shape-detecting so it
  // costs ~0 on healthy dbs.
  try {
    const result = await runtimeHealOwnerIndex(db);
    if (result.migrated > 0 || result.dropped > 0) {
      console.warn(
        `[ward-store] runtime ownerIndex heal: migrated ${result.migrated}, dropped ${result.dropped}, already-clean ${result.alreadyClean}`,
      );
    }
  } catch (err) {
    // Heal failure is non-fatal — the db still works, just slower until next
    // heal attempt. Surface to console for diagnosis.
    console.warn("[ward-store] runtime ownerIndex heal failed:", err);
  }
  return db;
}

/**
 * Runtime (post-open) ownerIndex shape heal. Runs as a regular readwrite
 * transaction on the OWNER_INDEX_STORE, NOT during the version-change
 * upgrade callback. The upgrade-callback healer above is correct in source
 * but has been observed to silently fail to commit on some real-world IDB
 * states — moving the heal to a regular tx removes that ambiguity because
 * regular txs don't carry the version-change lifecycle quirks.
 *
 * Uses getAllKeys + get-per-key instead of a cursor: regular txs survive
 * sequential awaited puts/deletes fine, and the per-key get/put pattern is
 * simpler to reason about than cursor.update with concurrent iteration.
 *
 * Shape-detecting and idempotent: rows already carrying `entries[]` are
 * counted as `alreadyClean` and skipped (no write). Rows with the legacy
 * `policyIds[]` shape are rewritten to `entries[]` with publishedBlock=0n
 * sentinels. Rows missing both fields are deleted as corrupt.
 *
 * Returns counts so the caller can log only when work happened, keeping
 * devtools quiet for healthy dbs.
 */
export async function runtimeHealOwnerIndex(
  db: IDBPDatabase,
): Promise<{ migrated: number; dropped: number; alreadyClean: number }> {
  let migrated = 0;
  let dropped = 0;
  let alreadyClean = 0;
  const tx = db.transaction(OWNER_INDEX_STORE, "readwrite");
  const store = tx.store;
  const keys = await store.getAllKeys();
  for (const key of keys) {
    const row = (await store.get(key)) as
      | {
          key?: string;
          policyIds?: Hex[];
          entries?: unknown[];
          lastSeenBlock?: string;
          savedAtMs?: number;
        }
      | undefined;
    if (!row) continue;
    if (Array.isArray(row.entries)) {
      alreadyClean += 1;
      continue;
    }
    if (Array.isArray(row.policyIds) && typeof row.key === "string") {
      const entries = row.policyIds.map((pid) => ({
        policyId: pid,
        publishedBlock: "0",
      }));
      await store.put({
        key: row.key,
        entries,
        lastSeenBlock: row.lastSeenBlock ?? "0",
        savedAtMs: row.savedAtMs ?? Date.now(),
      });
      migrated += 1;
    } else {
      console.warn(
        "[ward-store] runtime ownerIndex heal: dropping record missing policyIds or key",
        key,
      );
      await store.delete(key);
      dropped += 1;
    }
  }
  await tx.done;
  return { migrated, dropped, alreadyClean };
}

/**
 * SHAPE-detecting ownerIndex healer. Iterates the cursor and rewrites each
 * record IN PLACE from the old `{ policyIds: Hex[], lastSeenBlock }` shape
 * to the new `{ entries: { policyId, publishedBlock: 0n }[], lastSeenBlock }`
 * shape. `publishedBlock: 0n` is the "unknown" sentinel — refreshOwnerIndex
 * sees it and falls back to the legacy chunked backward walk for that
 * entry, then UPDATES the record with the real publishedBlock once
 * recovered.
 *
 * Runs unconditionally on every upgrade (no `oldVersion < N` gate). The
 * cursor's `Array.isArray(value.entries)` short-circuit makes already-
 * migrated rows a no-op, so re-running on a healthy db is just one empty
 * scan. The reason this is shape-detecting rather than version-gated: an
 * earlier broken-migration cycle landed at version=8 on some users' dbs
 * WITHOUT rewriting the row, and a version-gated migration could never
 * heal those rows because the upgrade callback wouldn't fire at all.
 * Bumping DB_VERSION to 9 (or any future bump) forces re-entry; the
 * healer then catches whatever shape the row is actually in.
 *
 * IMPORTANT: writes happen via `cursor.update(rewritten)` DURING iteration,
 * NOT via a second pass of `await store.put(...)` after iteration finishes.
 * idb's upgrade-tx version-change transaction stays alive only as long as
 * requests are chained off it within microtasks; a deferred second pass of
 * standalone puts can race the tx commit and silently drop the writes
 * (which is the bug that left a v8-versioned db carrying v7-shaped rows).
 * Same pattern as rekeyWatchedStoreV3toV4 — the cursor's update keeps the
 * tx alive across each read+write pair.
 *
 * Records already in the new shape (e.g. a partial deploy that wrote a v8
 * record before the version bump propagated) are left untouched. Records
 * with neither `policyIds` nor `entries` are deleted as corrupt.
 *
 * The store argument is intentionally typed loosely (`any`) for the same
 * reason rekeyWatchedStoreV3toV4 uses it — idb's cursor generics are
 * unstable across upgrade-tx flavours and we don't carry a typed schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function healOwnerIndexShape(store: any): Promise<number> {
  let migrated = 0;
  let dropped = 0;
  let cursor = await store.openCursor();
  while (cursor) {
    const value = cursor.value as {
      key?: string;
      policyIds?: Hex[];
      entries?: unknown[];
      lastSeenBlock?: string;
      savedAtMs?: number;
    };
    if (Array.isArray(value.entries)) {
      // Already in v8 shape — skip (idempotent on re-run).
      cursor = await cursor.continue();
      continue;
    }
    if (Array.isArray(value.policyIds) && typeof value.key === "string") {
      const entries = value.policyIds.map((pid) => ({
        policyId: pid,
        publishedBlock: "0",
      }));
      // In-place rewrite via cursor.update keeps the version-change tx
      // alive across the read+write pair. Awaiting the update request
      // before advancing the cursor is the same microtask-chain pattern
      // rekeyWatchedStoreV3toV4 uses.
      await cursor.update({
        key: value.key,
        entries,
        lastSeenBlock: value.lastSeenBlock ?? "0",
        savedAtMs: value.savedAtMs ?? Date.now(),
      });
      migrated += 1;
    } else {
      console.warn(
        "[ward-store] ownerIndex heal: dropping record missing policyIds or key",
        cursor.key,
      );
      await cursor.delete();
      dropped += 1;
    }
    cursor = await cursor.continue();
  }

  // Only log when work happened — an empty pass over an already-healed db
  // shouldn't spam devtools on every open.
  if (migrated > 0 || dropped > 0) {
    const droppedSuffix = dropped > 0 ? `, dropped ${dropped} corrupt record(s)` : "";
    console.log(
      `[ward-store] ownerIndex heal: enriched ${migrated} record(s)${droppedSuffix}`,
    );
  }
  return migrated;
}

/**
 * v3→v4 watched-store rekey. Iterates the cursor and rewrites each record
 * to its new wide key (chainId+oracleAddress+policyId+agent). Records
 * missing chainId/oracleAddress/policyId/agent cannot be rekeyed (no valid
 * new key can be computed) and are DELETED from the store during the same
 * upgrade transaction — leaving them would later crash listWatchedPolicies
 * at `r.oracleAddress.toLowerCase()`.
 *
 * The store argument is intentionally typed loosely (`any`) because the
 * cursor's generic parameters are unstable across idb's upgrade-tx flavour
 * and we don't carry a typed schema. The runtime contract is: cursor
 * iteration + delete + put on the same version-change transaction.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rekeyWatchedStoreV3toV4(store: any): Promise<number> {
  // First pass: collect work (old key → new value). We don't mutate the
  // store during cursor iteration because put-during-iterate can cause the
  // cursor to re-visit newly-inserted records when the new key sorts ahead
  // of the cursor's current position, double-counting them.
  const rewrites: Array<{ oldKey: IDBValidKey; newKey: string; value: unknown }> = [];
  const corruptKeys: IDBValidKey[] = [];
  let cursor = await store.openCursor();
  while (cursor) {
    const value = cursor.value as {
      chainId?: number;
      oracleAddress?: string;
      policyId?: string;
      watchedAgentAddress?: string;
    };
    const { chainId, oracleAddress, policyId, watchedAgentAddress } = value;
    if (
      typeof chainId === "number" &&
      typeof oracleAddress === "string" &&
      typeof policyId === "string" &&
      typeof watchedAgentAddress === "string"
    ) {
      const newKey = `${chainId}:${oracleAddress.toLowerCase()}:${policyId.toLowerCase()}:${watchedAgentAddress.toLowerCase()}`;
      rewrites.push({ oldKey: cursor.key as IDBValidKey, newKey, value });
    } else {
      console.warn(
        "[ward-store] v4 migration: dropping watched record missing chainId/oracleAddress/policyId/agent",
        cursor.key,
      );
      corruptKeys.push(cursor.key as IDBValidKey);
    }
    cursor = await cursor.continue();
  }

  // Second pass: apply. Delete-then-put so the wide key replaces the legacy
  // narrow key. If two records would collide on the new key, the LAST one
  // wins — a one-time consequence of the missing scope in v3 keys. Corrupt
  // records are deleted outright (no salvageable new key).
  let rekeyed = 0;
  for (const { oldKey, newKey, value } of rewrites) {
    if (oldKey !== newKey) {
      await store.delete(oldKey);
    }
    await store.put({ ...(value as Record<string, unknown>), key: newKey });
    rekeyed += 1;
  }
  let dropped = 0;
  for (const oldKey of corruptKeys) {
    await store.delete(oldKey);
    dropped += 1;
  }
  const droppedSuffix = dropped > 0 ? `, dropped ${dropped} corrupt record(s)` : "";
  console.log(
    `[ward-store] v4 migration: rekeyed ${rekeyed} watched record(s)${droppedSuffix}`,
  );
  return rekeyed;
}

export async function loadSnapshot(opts: NamespaceOpts): Promise<Snapshot | null> {
  const db = await openWardDB();
  try {
    const key = namespaceKey(opts);
    const rec = (await db.get(STORE, key)) as NamespacedRecord | undefined;
    if (!rec) return null;
    if (rec.schemaVersion !== 1) return null;
    return {
      schemaVersion: 1,
      cursor: BigInt(rec.cursor),
      headBlockAtCursor: BigInt(rec.headBlockAtCursor),
      policiesJSON: rec.policiesJSON,
      queueRecordsJSON: rec.queueRecordsJSON,
      eventLogJSON: rec.eventLogJSON,
      chainId: rec.chainId,
      oracleAddress: rec.oracleAddress,
      queueAddress: rec.queueAddress,
      savedAtMs: rec.savedAtMs,
    };
  } finally {
    db.close();
  }
}

export interface SaveSnapshotOpts extends NamespaceOpts {
  cursor: bigint;
  headBlockAtCursor: bigint;
  policies: PolicyMeta[];
  queueRecords: QueueRecordHeader[];
  eventLog: StoreEvent[];
}

export async function saveSnapshot(opts: SaveSnapshotOpts): Promise<void> {
  const db = await openWardDB();
  try {
    const rec: NamespacedRecord = {
      namespace: namespaceKey(opts),
      schemaVersion: 1,
      cursor: opts.cursor.toString(),
      headBlockAtCursor: opts.headBlockAtCursor.toString(),
      policiesJSON: JSON.stringify(opts.policies, bigintReplacer),
      queueRecordsJSON: JSON.stringify(opts.queueRecords, bigintReplacer),
      eventLogJSON: JSON.stringify(opts.eventLog, bigintReplacer),
      chainId: opts.chainId,
      oracleAddress: opts.oracleAddress,
      queueAddress: opts.queueAddress,
      savedAtMs: Date.now(),
    };
    const tx = db.transaction(STORE, "readwrite");
    await tx.store.put(rec);
    await tx.done;
  } finally {
    db.close();
  }
}

export async function clearSnapshot(opts: NamespaceOpts): Promise<void> {
  const db = await openWardDB();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await tx.store.delete(namespaceKey(opts));
    await tx.done;
  } finally {
    db.close();
  }
}

/* ----------------------------- ownerIndex ----------------------------- */

/**
 * Per-(chain, oracle, owner) cache of discovered policyIds. Populated by the
 * Watched page's "Discover my policies" flow which fires a topic-filtered
 * eth_getLogs against PolicyPublished(owner=...) and chunks across the
 * Shannon 1000-block cap. `lastSeenBlock` is the highest reorg-safe block
 * the scan covered, so subsequent runs only need to scan the tail.
 *
 * bigints (`lastSeenBlock`) are serialized as decimal strings to stay
 * inspectable in devtools and consistent with the snapshot store format.
 *
 * v8 enriches the per-id payload with `publishedBlock` + optional
 * `lastUpdatedBlock` so the stale-rehydrate path in refreshOwnerIndex can
 * pass them as hints into lookupPolicyOnChain and avoid the full
 * deployment-to-head backward walk. The old `OwnerIndex` shape stays as a
 * back-compat view derived from the rich entries — callers that only need
 * the list of policyIds keep working unchanged.
 */
export interface OwnerIndexEntry {
  policyId: Hex;
  /** Block at which PolicyPublished fired for this policyId. `0n` is the
   *  migration sentinel meaning "unknown" — refreshOwnerIndex falls back
   *  to the legacy chunked backward walk for those entries and updates the
   *  record with the real value once recovered. */
  publishedBlock: bigint;
  /** Highest block at which we observed a PolicyUpdated for this policyId.
   *  Optional because the v8 migration leaves it undefined for legacy
   *  entries; refreshOwnerIndex sets it as the live watcher advances. */
  lastUpdatedBlock?: bigint;
}

export interface OwnerIndexRichRecord {
  entries: OwnerIndexEntry[];
  lastSeenBlock: bigint;
}

export interface OwnerIndex {
  policyIds: Hex[];
  lastSeenBlock: bigint;
}

interface OwnerIndexStoredEntry {
  policyId: Hex;
  publishedBlock: string;
  lastUpdatedBlock?: string;
}

interface OwnerIndexRecord {
  key: string;
  /** v8+ shape. Always present on records written by saveOwnerIndexRich. */
  entries?: OwnerIndexStoredEntry[];
  /** v7 legacy shape; kept on disk only until the v8 migration runs over
   *  the upgrade tx. Live reads of v8 records should never see this. */
  policyIds?: Hex[];
  lastSeenBlock: string;
  savedAtMs: number;
}

interface OwnerIndexOpts {
  chainId: number;
  oracleAddress: Address;
  owner: Address;
}

function ownerIndexKey(opts: OwnerIndexOpts): string {
  return `${opts.chainId}:${opts.oracleAddress.toLowerCase()}:${opts.owner.toLowerCase()}`;
}

function entriesFromRecord(rec: OwnerIndexRecord): OwnerIndexEntry[] {
  if (Array.isArray(rec.entries)) {
    return rec.entries.map((e) => ({
      policyId: e.policyId,
      publishedBlock: BigInt(e.publishedBlock),
      lastUpdatedBlock:
        e.lastUpdatedBlock !== undefined ? BigInt(e.lastUpdatedBlock) : undefined,
    }));
  }
  // v7-shaped record read before the migration tx commits (shouldn't
  // happen during normal flow, but harmless to handle). Treat publishedBlock
  // as the 0n "unknown" sentinel — the rehydrate path falls back to the
  // backward walk for these.
  if (Array.isArray(rec.policyIds)) {
    return rec.policyIds.map((pid) => ({ policyId: pid, publishedBlock: 0n }));
  }
  return [];
}

/**
 * v8 rich-shape load. Returns entries with `publishedBlock` + optional
 * `lastUpdatedBlock` so the stale-rehydrate path can feed hints into
 * lookupPolicyOnChain. Migrated v7 records report `publishedBlock: 0n`
 * (the "unknown" sentinel) — the caller falls back to the legacy
 * backward walk for those entries.
 */
export async function loadOwnerIndexRich(
  opts: OwnerIndexOpts,
): Promise<OwnerIndexRichRecord | null> {
  const db = await openWardDB();
  try {
    const rec = (await db.get(OWNER_INDEX_STORE, ownerIndexKey(opts))) as
      | OwnerIndexRecord
      | undefined;
    if (!rec) return null;
    return {
      entries: entriesFromRecord(rec),
      lastSeenBlock: BigInt(rec.lastSeenBlock),
    };
  } finally {
    db.close();
  }
}

export interface SaveOwnerIndexRichOpts extends OwnerIndexOpts {
  value: OwnerIndexRichRecord;
}

export async function saveOwnerIndexRich(opts: SaveOwnerIndexRichOpts): Promise<void> {
  const db = await openWardDB();
  try {
    // Defensive dedupe (case-insensitive) keyed by policyId. First-seen
    // metadata wins so a re-scan that re-emits the same publish log doesn't
    // clobber a richer in-memory entry with the same id.
    const deduped = new Map<string, OwnerIndexEntry>();
    for (const entry of opts.value.entries) {
      const k = entry.policyId.toLowerCase();
      if (!deduped.has(k)) deduped.set(k, entry);
    }
    const rec: OwnerIndexRecord = {
      key: ownerIndexKey(opts),
      entries: [...deduped.values()].map((e) => ({
        policyId: e.policyId,
        publishedBlock: e.publishedBlock.toString(),
        ...(e.lastUpdatedBlock !== undefined
          ? { lastUpdatedBlock: e.lastUpdatedBlock.toString() }
          : {}),
      })),
      lastSeenBlock: opts.value.lastSeenBlock.toString(),
      savedAtMs: Date.now(),
    };
    const tx = db.transaction(OWNER_INDEX_STORE, "readwrite");
    await tx.store.put(rec);
    await tx.done;
  } finally {
    db.close();
  }
}

/**
 * Back-compat wrapper that returns the legacy `{ policyIds, lastSeenBlock }`
 * view derived from the v8 rich entries. Existing callers that only need the
 * list of policyIds keep working unchanged while the rich-shape rollout
 * progresses.
 */
export async function loadOwnerIndex(opts: OwnerIndexOpts): Promise<OwnerIndex | null> {
  const rich = await loadOwnerIndexRich(opts);
  if (!rich) return null;
  return {
    policyIds: rich.entries.map((e) => e.policyId),
    lastSeenBlock: rich.lastSeenBlock,
  };
}

export interface SaveOwnerIndexOpts extends OwnerIndexOpts {
  value: OwnerIndex;
}

/**
 * Back-compat wrapper around saveOwnerIndexRich. Each policyId becomes an
 * entry with `publishedBlock: 0n` (the "unknown" sentinel) — callers that
 * have the real publishedBlock should switch to `saveOwnerIndexRich`
 * directly so the stale-rehydrate fast-path can use it.
 */
export async function saveOwnerIndex(opts: SaveOwnerIndexOpts): Promise<void> {
  await saveOwnerIndexRich({
    chainId: opts.chainId,
    oracleAddress: opts.oracleAddress,
    owner: opts.owner,
    value: {
      entries: opts.value.policyIds.map((pid) => ({
        policyId: pid,
        publishedBlock: 0n,
      })),
      lastSeenBlock: opts.value.lastSeenBlock,
    },
  });
}

/* ---------------------------- contractName ---------------------------- */

/**
 * Per-(chainId, address) cache of resolved contract names from the Somnia
 * explorer's Etherscan-style `getsourcecode` endpoint. The hot-path
 * resolveContractName() reads this before issuing a network call so the UI
 * stays snappy across page reloads. TTL enforcement lives in the caller
 * (contractName.ts) so this layer stays a dumb key/value store.
 */
export interface ContractNameRecord {
  name: string | null;
  verified: boolean;
  source: "local" | "explorer" | "unknown";
  fetchedAtMs: number;
}

interface ContractNameStored extends ContractNameRecord {
  key: string;
}

function contractNameKey(chainId: number, address: Address): string {
  return `${chainId}:${address.toLowerCase()}`;
}

export async function loadContractName(
  chainId: number,
  address: Address,
): Promise<ContractNameRecord | null> {
  const db = await openWardDB();
  try {
    const rec = (await db.get(CONTRACT_NAME_STORE, contractNameKey(chainId, address))) as
      | ContractNameStored
      | undefined;
    if (!rec) return null;
    return {
      name: rec.name,
      verified: rec.verified,
      source: rec.source,
      fetchedAtMs: rec.fetchedAtMs,
    };
  } finally {
    db.close();
  }
}

export async function saveContractName(
  chainId: number,
  address: Address,
  record: ContractNameRecord,
): Promise<void> {
  const db = await openWardDB();
  try {
    const rec: ContractNameStored = {
      key: contractNameKey(chainId, address),
      name: record.name,
      verified: record.verified,
      source: record.source,
      fetchedAtMs: record.fetchedAtMs,
    };
    const tx = db.transaction(CONTRACT_NAME_STORE, "readwrite");
    await tx.store.put(rec);
    await tx.done;
  } finally {
    db.close();
  }
}

/* ---------------------------- cachedAgents ---------------------------- */

/**
 * Per-(chainId, registryAddress) snapshot of the WardAgentRegistry, used as
 * the Tier 2 cold-start fallback by agents-catalog.ts when the on-chain walk
 * (Tier 1) is unavailable / mid-flight.
 *
 * Lifecycle: written on every successful Tier-1 load so a
 * subsequent reload can paint the agents grid instantly from cache while the
 * live load resolves in the background. Safe to be missing — the catalog
 * still works, the UI just shows a loading state instead of a stale snapshot.
 *
 * Address normalization (per design review issue): `agent`, `registrar`,
 * `oracle` are stored LOWERCASED; `policyId` is stored as a 0x-prefixed
 * lowercased hex string. This keeps the cache key + per-row addresses
 * key-stable across reloads regardless of whether the chain source returned
 * checksummed or lowercased forms. Renderers re-checksum
 * via viem on display.
 *
 * `sourceTier` is retained on the schema for forward-compatibility but
 * always equals "chain" after v0.10.4.
 *
 * bigints: `updatedAt` (uint64 on-chain) serialized as decimal string,
 * matching the OwnerIndex pattern. Deserialize with `BigInt(s)`.
 */
export interface CachedAgentSerialized {
  /** Lowercased 0x-prefixed address. */
  agent: string;
  /** Lowercased 0x-prefixed address. */
  registrar: string;
  /** Lowercased 0x-prefixed address. */
  oracle: string;
  /** Lowercased 0x-prefixed hex (bytes32). */
  policyId: string;
  name: string;
  metadataURI: string;
  tags: string[];
  /** bigint serialized as decimal string (uint64 updatedAt from the registry struct). */
  updatedAt: string;
  active: boolean;
}

export interface CachedAgentsRecord {
  /** `${chainId}:${registryAddress.toLowerCase()}` */
  key: string;
  chainId: number;
  /** Lowercased 0x-prefixed address (matches the key suffix). */
  registryAddress: string;
  agents: CachedAgentSerialized[];
  cachedAtMs: number;
  sourceTier: "chain";
}

/**
 * Structural shape of an agent as supplied by the catalog. Matches
 * `RegistryAgent` from @ward/sdk field-for-field, but typed
 * locally so this module doesn't have to depend on the catalog's eventual
 * `CatalogAgent` type — any object with these fields can be persisted.
 */
interface CatalogAgentLike {
  agent: Address;
  registrar: Address;
  oracle: Address;
  policyId: Hex;
  name: string;
  metadataURI: string;
  tags: readonly string[];
  updatedAt: bigint;
  active: boolean;
}

function agentsCacheKey(chainId: number, registryAddress: Address): string {
  return `${chainId}:${registryAddress.toLowerCase()}`;
}

export async function loadCachedAgents(
  chainId: number,
  registryAddress: Address,
): Promise<CachedAgentsRecord | null> {
  const db = await openWardDB();
  try {
    const rec = (await db.get(CACHED_AGENTS_STORE, agentsCacheKey(chainId, registryAddress))) as
      | CachedAgentsRecord
      | undefined;
    return rec ?? null;
  } finally {
    db.close();
  }
}

export async function saveCachedAgents(
  chainId: number,
  registryAddress: Address,
  agents: CatalogAgentLike[],
  sourceTier: "chain",
): Promise<void> {
  const db = await openWardDB();
  try {
    const rec: CachedAgentsRecord = {
      key: agentsCacheKey(chainId, registryAddress),
      chainId,
      registryAddress: registryAddress.toLowerCase(),
      agents: agents.map((a) => ({
        agent: a.agent.toLowerCase(),
        registrar: a.registrar.toLowerCase(),
        oracle: a.oracle.toLowerCase(),
        policyId: a.policyId.toLowerCase(),
        name: a.name,
        metadataURI: a.metadataURI,
        tags: [...a.tags],
        updatedAt: a.updatedAt.toString(),
        active: a.active,
      })),
      cachedAtMs: Date.now(),
      sourceTier,
    };
    const tx = db.transaction(CACHED_AGENTS_STORE, "readwrite");
    await tx.store.put(rec);
    await tx.done;
  } finally {
    db.close();
  }
}

/**
 * Watch Wizard subscription record. Persists the operator's binding between
 * a watched agent and an alert channel + tier. Keyed by
 * `${chainId}:${agent.toLowerCase()}` — one subscription per (chain, agent).
 *
 * Each subscription carries EXACTLY ONE of:
 *   - `slackWebhookUrl`: Slack incoming-webhook URL.
 *   - `telegram`: { botToken, chatId } — a Telegram bot binding.
 *
 * The exclusive-or is enforced by `saveWatchSubscription`, not by the
 * schema — both fields are declared optional so v12-shaped rows (which
 * only carry `slackWebhookUrl`) deserialize unchanged after the v13 bump.
 *
 * SECURITY: every channel field is an OPERATOR SECRET. Never log them. The
 * UI must mask after entry (show only a fingerprint after save).
 *
 * Distinct from the `watched` store, which holds policy-binding watch flags
 * keyed by `${chainId}:${oracleAddress}:${policyId}:${agent}`.
 */
export interface WatchSubscriptionTelegram {
  /** Telegram bot API token (`<botid>:<secret>`). OPERATOR SECRET. */
  botToken: string;
  /** Telegram chat_id (numeric id or @username). OPERATOR SECRET. */
  chatId: string;
}

export interface WatchSubscriptionRecord {
  /** `${chainId}:${agent.toLowerCase()}` */
  key: string;
  chainId: number;
  /** Lowercased 0x-prefixed address. */
  agent: Address;
  /** Lowercased 0x-prefixed hex (bytes32). */
  policyId: Hex;
  /** Slack incoming webhook URL. OPERATOR SECRET. Optional iff `telegram` is set. */
  slackWebhookUrl?: string;
  /** Telegram bot binding. OPERATOR SECRET (both fields). Optional iff `slackWebhookUrl` is set. */
  telegram?: WatchSubscriptionTelegram;
  tier: "conservative" | "balanced" | "aggressive";
  /** Date.now() ms at save time. */
  createdAt: number;
}

function watchSubscriptionKey(chainId: number, agent: Address): string {
  return `${chainId}:${agent.toLowerCase()}`;
}

export interface SaveWatchSubscriptionOpts {
  chainId: number;
  agent: Address;
  policyId: Hex;
  slackWebhookUrl?: string;
  telegram?: WatchSubscriptionTelegram;
  tier: "conservative" | "balanced" | "aggressive";
}

export async function saveWatchSubscription(
  opts: SaveWatchSubscriptionOpts,
): Promise<void> {
  // Enforce EXACTLY one channel — letting both persist would make later
  // dispatch priority ambiguous and is not a user flow the wizard exposes.
  // Throwing surfaces the caller bug immediately in dev rather than
  // silently writing both fields.
  const hasSlack = typeof opts.slackWebhookUrl === "string" && opts.slackWebhookUrl.length > 0;
  const hasTelegram = !!opts.telegram;
  if (hasSlack === hasTelegram) {
    throw new Error(
      "saveWatchSubscription: exactly one alert channel required (slackWebhookUrl XOR telegram)",
    );
  }
  const db = await openWardDB();
  try {
    const agentLower = opts.agent.toLowerCase() as Address;
    const policyLower = opts.policyId.toLowerCase() as Hex;
    const rec: WatchSubscriptionRecord = {
      key: watchSubscriptionKey(opts.chainId, agentLower),
      chainId: opts.chainId,
      agent: agentLower,
      policyId: policyLower,
      tier: opts.tier,
      createdAt: Date.now(),
      ...(hasSlack ? { slackWebhookUrl: opts.slackWebhookUrl } : {}),
      ...(hasTelegram ? { telegram: opts.telegram } : {}),
    };
    const tx = db.transaction(WATCH_SUBSCRIPTIONS_STORE, "readwrite");
    await tx.store.put(rec);
    await tx.done;
  } finally {
    db.close();
  }
}

export async function loadWatchSubscription(
  chainId: number,
  agent: Address,
): Promise<WatchSubscriptionRecord | null> {
  const db = await openWardDB();
  try {
    const rec = (await db.get(
      WATCH_SUBSCRIPTIONS_STORE,
      watchSubscriptionKey(chainId, agent),
    )) as WatchSubscriptionRecord | undefined;
    return rec ?? null;
  } finally {
    db.close();
  }
}

/**
 * Returns every subscription scoped to the given chainId. Used by a future
 * "My watch subscriptions" panel; exposed now for API symmetry with the
 * other store helpers.
 */
export async function loadAllWatchSubscriptions(
  chainId: number,
): Promise<WatchSubscriptionRecord[]> {
  const db = await openWardDB();
  try {
    const all = (await db.getAll(WATCH_SUBSCRIPTIONS_STORE)) as WatchSubscriptionRecord[];
    return all.filter((rec) => rec.chainId === chainId);
  } finally {
    db.close();
  }
}

export async function removeWatchSubscription(
  chainId: number,
  agent: Address,
): Promise<void> {
  const db = await openWardDB();
  try {
    const tx = db.transaction(WATCH_SUBSCRIPTIONS_STORE, "readwrite");
    await tx.store.delete(watchSubscriptionKey(chainId, agent));
    await tx.done;
  } finally {
    db.close();
  }
}

/**
 * If the persisted cursor sits inside the reorg-unsafe tail near head, rewind
 * so the next backfill re-processes blocks that could still re-org. Never
 * returns a negative block.
 */
export function reorgSafeStartBlock(
  cursor: bigint,
  headBlock: bigint,
  reorgDepth: bigint = REORG_DEPTH,
): bigint {
  const safeHead = headBlock > reorgDepth ? headBlock - reorgDepth : 0n;
  const candidate = cursor < safeHead ? cursor : safeHead;
  return candidate < 0n ? 0n : candidate;
}
