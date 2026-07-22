import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import type { Address, Hex } from "viem";

import {
  loadOwnerIndex,
  loadOwnerIndexRich,
  openWardDB,
  runtimeHealOwnerIndex,
  saveOwnerIndex,
  saveOwnerIndexRich,
} from "../../src/lib/persistence";

const DB_NAME = "ward-store";
const ORACLE = "0x1111111111111111111111111111111111111111" as Address;
const ORACLE_UPPER = "0x1111111111111111111111111111111111111111".toUpperCase() as Address;
const ALICE = "0x000000000000000000000000000000000000A11C" as Address;
const ALICE_UPPER = "0x000000000000000000000000000000000000A11C".toUpperCase() as Address;
const BOB = "0x000000000000000000000000000000000000B0B0" as Address;
const POLICY_A = ("0x" + "aa".repeat(32)) as Hex;
const POLICY_B = ("0x" + "bb".repeat(32)) as Hex;
const CHAIN_ID = 43113;

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe("ownerIndex IDB ops", () => {
  it("save then load round-trips policyIds + lastSeenBlock (bigint)", async () => {
    await saveOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: {
        policyIds: [POLICY_A, POLICY_B],
        lastSeenBlock: 12_345_678n,
      },
    });
    const loaded = await loadOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.lastSeenBlock).toBe(12_345_678n);
    expect(loaded!.policyIds.sort()).toEqual([POLICY_A, POLICY_B].sort());
  });

  it("returns null for unseen (chain, oracle, owner) keys", async () => {
    const loaded = await loadOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(loaded).toBeNull();
  });

  it("namespacing: changing owner or oracle yields a separate record", async () => {
    await saveOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: { policyIds: [POLICY_A], lastSeenBlock: 1n },
    });
    await saveOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: BOB,
      value: { policyIds: [POLICY_B], lastSeenBlock: 2n },
    });

    const fromAlice = await loadOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    const fromBob = await loadOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: BOB,
    });
    expect(fromAlice!.policyIds).toEqual([POLICY_A]);
    expect(fromAlice!.lastSeenBlock).toBe(1n);
    expect(fromBob!.policyIds).toEqual([POLICY_B]);
    expect(fromBob!.lastSeenBlock).toBe(2n);
  });

  it("key is case-insensitive for owner + oracleAddress", async () => {
    await saveOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: { policyIds: [POLICY_A], lastSeenBlock: 7n },
    });
    const loaded = await loadOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE_UPPER,
      owner: ALICE_UPPER,
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.policyIds).toEqual([POLICY_A]);
    expect(loaded!.lastSeenBlock).toBe(7n);
  });

  it("save dedupes policyIds (case-insensitive) on the way in", async () => {
    await saveOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: {
        policyIds: [POLICY_A, POLICY_A.toUpperCase() as Hex, POLICY_B, POLICY_A],
        lastSeenBlock: 1n,
      },
    });
    const loaded = await loadOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(loaded!.policyIds).toHaveLength(2);
    const lowered = new Set(loaded!.policyIds.map((p) => p.toLowerCase()));
    expect(lowered).toEqual(new Set([POLICY_A.toLowerCase(), POLICY_B.toLowerCase()]));
  });

  it("save overwrites prior record under the same key", async () => {
    await saveOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: { policyIds: [POLICY_A], lastSeenBlock: 100n },
    });
    await saveOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: { policyIds: [POLICY_A, POLICY_B], lastSeenBlock: 200n },
    });
    const loaded = await loadOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(loaded!.policyIds.sort()).toEqual([POLICY_A, POLICY_B].sort());
    expect(loaded!.lastSeenBlock).toBe(200n);
  });

  it("v5 migration: the ownerIndex object store is created on upgrade", async () => {
    // openWardDB triggers the upgrade path on a fresh db.
    const db = await openWardDB();
    expect(db.objectStoreNames.contains("ownerIndex")).toBe(true);
    db.close();
  });
});

/* ------------------------- v8 rich-shape ownerIndex ------------------------- */

describe("ownerIndex v8 rich shape", () => {
  it("save then load rich entries round-trips publishedBlock + lastUpdatedBlock (bigint)", async () => {
    await saveOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: {
        entries: [
          { policyId: POLICY_A, publishedBlock: 1_000_000n, lastUpdatedBlock: 1_000_500n },
          { policyId: POLICY_B, publishedBlock: 2_000_000n },
        ],
        lastSeenBlock: 2_500_000n,
      },
    });
    const loaded = await loadOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(loaded).not.toBeNull();
    expect(loaded!.lastSeenBlock).toBe(2_500_000n);
    const byId = new Map(loaded!.entries.map((e) => [e.policyId, e]));
    expect(byId.get(POLICY_A)).toEqual({
      policyId: POLICY_A,
      publishedBlock: 1_000_000n,
      lastUpdatedBlock: 1_000_500n,
    });
    expect(byId.get(POLICY_B)).toEqual({
      policyId: POLICY_B,
      publishedBlock: 2_000_000n,
      lastUpdatedBlock: undefined,
    });
  });

  it("rich save dedupes by lowercase policyId (first-seen wins, preserves richer metadata)", async () => {
    await saveOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: {
        entries: [
          { policyId: POLICY_A, publishedBlock: 1_000n, lastUpdatedBlock: 1_500n },
          // Same id (uppercase) — should be skipped, NOT overwrite the first.
          { policyId: POLICY_A.toUpperCase() as Hex, publishedBlock: 9_000n },
        ],
        lastSeenBlock: 10_000n,
      },
    });
    const loaded = await loadOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0].publishedBlock).toBe(1_000n);
    expect(loaded!.entries[0].lastUpdatedBlock).toBe(1_500n);
  });

  it("loadOwnerIndex back-compat wrapper extracts policyIds from rich entries", async () => {
    await saveOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: {
        entries: [
          { policyId: POLICY_A, publishedBlock: 100n },
          { policyId: POLICY_B, publishedBlock: 200n, lastUpdatedBlock: 250n },
        ],
        lastSeenBlock: 300n,
      },
    });
    const legacy = await loadOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(legacy).not.toBeNull();
    expect(legacy!.policyIds.sort()).toEqual([POLICY_A, POLICY_B].sort());
    expect(legacy!.lastSeenBlock).toBe(300n);
  });

  it("saveOwnerIndex back-compat wrapper writes entries with publishedBlock=0n sentinel", async () => {
    // Callers that don't yet know the publishedBlock keep using the legacy
    // save shape; the wrapper translates each id to a v8 entry with the
    // "unknown" sentinel so the rehydrate path takes the slow walk.
    await saveOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: { policyIds: [POLICY_A, POLICY_B], lastSeenBlock: 42n },
    });
    const rich = await loadOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(rich).not.toBeNull();
    expect(rich!.lastSeenBlock).toBe(42n);
    for (const entry of rich!.entries) {
      expect(entry.publishedBlock).toBe(0n);
      expect(entry.lastUpdatedBlock).toBeUndefined();
    }
    expect(rich!.entries.map((e) => e.policyId).sort()).toEqual(
      [POLICY_A, POLICY_B].sort(),
    );
  });
});

/* ---------------------- v7 → v8 migration of ownerIndex ---------------------- */

const OWNER_INDEX_STORE = "ownerIndex";

/** Seed a fresh v7 db with a legacy `{ policyIds, lastSeenBlock }` ownerIndex
 *  record so the next openWardDB() triggers the v7→v8 upgrade callback. */
async function seedV7OwnerIndex(record: {
  key: string;
  policyIds: Hex[];
  lastSeenBlock: string;
}) {
  const db = await openDB(DB_NAME, 7, {
    upgrade(db) {
      for (const name of [
        "snapshots",
        "watched",
        "spend-daily",
        "violations",
        "ownerIndex",
        "publishedCache",
        "contractName",
      ]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: name === "snapshots" ? "namespace" : "key" });
        }
      }
    },
  });
  await db.put(OWNER_INDEX_STORE, {
    key: record.key,
    policyIds: record.policyIds,
    lastSeenBlock: record.lastSeenBlock,
    savedAtMs: 1_700_000_000_000,
  });
  db.close();
}

describe("ownerIndex v7 → v8 migration", () => {
  it("converts legacy policyIds[] to entries[] with publishedBlock=0n sentinel", async () => {
    const KEY = `${CHAIN_ID}:${ORACLE.toLowerCase()}:${ALICE.toLowerCase()}`;
    await seedV7OwnerIndex({
      key: KEY,
      policyIds: [POLICY_A, POLICY_B],
      lastSeenBlock: "1234",
    });

    // Triggers v7 → v8 upgrade.
    const db = await openWardDB();
    db.close();

    // After migration, the rich load returns entries with the 0n sentinel.
    const rich = await loadOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(rich).not.toBeNull();
    expect(rich!.lastSeenBlock).toBe(1234n);
    expect(rich!.entries).toHaveLength(2);
    for (const entry of rich!.entries) {
      expect(entry.publishedBlock).toBe(0n);
      expect(entry.lastUpdatedBlock).toBeUndefined();
    }
    expect(rich!.entries.map((e) => e.policyId).sort()).toEqual(
      [POLICY_A, POLICY_B].sort(),
    );
  });

  it("post-migration: loadOwnerIndex back-compat view still works for legacy callers", async () => {
    const KEY = `${CHAIN_ID}:${ORACLE.toLowerCase()}:${ALICE.toLowerCase()}`;
    await seedV7OwnerIndex({
      key: KEY,
      policyIds: [POLICY_A],
      lastSeenBlock: "999",
    });
    // Trigger upgrade.
    const db = await openWardDB();
    db.close();

    const legacy = await loadOwnerIndex({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(legacy).not.toBeNull();
    expect(legacy!.policyIds).toEqual([POLICY_A]);
    expect(legacy!.lastSeenBlock).toBe(999n);
  });

  it("post-migration: a rich save replaces the sentinel with the real publishedBlock", async () => {
    // The whole point of the migration sentinel: refreshOwnerIndex
    // recovers the real publishedBlock from the next scan and overwrites
    // the 0n placeholder, so subsequent rehydrates take the fast path.
    const KEY = `${CHAIN_ID}:${ORACLE.toLowerCase()}:${ALICE.toLowerCase()}`;
    await seedV7OwnerIndex({
      key: KEY,
      policyIds: [POLICY_A],
      lastSeenBlock: "100",
    });
    // Trigger upgrade.
    const db = await openWardDB();
    db.close();

    await saveOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: {
        entries: [{ policyId: POLICY_A, publishedBlock: 5_000n }],
        lastSeenBlock: 5_100n,
      },
    });
    const rich = await loadOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(rich!.entries).toEqual([
      { policyId: POLICY_A, publishedBlock: 5_000n, lastUpdatedBlock: undefined },
    ]);
    expect(rich!.lastSeenBlock).toBe(5_100n);
  });

  it("migration physically rewrites the on-disk record (regression guard for deferred-put tx race)", async () => {
    // The bug this guards against: a prior migration implementation
    // collected rewrites during cursor iteration, then ran them via
    // `await store.put(value)` in a second pass AFTER iteration finished.
    // The version-change tx could close before the deferred puts landed,
    // leaving the db at version=8 but the records still in v7 shape
    // (`policyIds[]` and no `entries[]`). The fix uses `cursor.update()`
    // in-place during iteration so the tx stays alive across each
    // read+write pair.
    //
    // This test reads the RAW record from the ownerIndex store right after
    // the upgrade and asserts the new `entries[]` field is present and the
    // legacy `policyIds[]` field is gone — proving the rewrite actually
    // hit disk, not just the in-memory view returned by loadOwnerIndexRich
    // (which would mask the bug by deriving entries from policyIds at
    // read time as a back-compat fallback).
    const KEY = `${CHAIN_ID}:${ORACLE.toLowerCase()}:${ALICE.toLowerCase()}`;
    await seedV7OwnerIndex({
      key: KEY,
      policyIds: [POLICY_A, POLICY_B],
      lastSeenBlock: "777",
    });

    // Force-trigger the v7→v8 upgrade by opening at the current version.
    const db = await openWardDB();
    // Pull the raw stored record (not via loadOwnerIndexRich which masks
    // the legacy fallback path). The migration MUST have written the
    // v8 shape in place.
    const raw = (await db.get(OWNER_INDEX_STORE, KEY)) as
      | {
          key: string;
          entries?: Array<{ policyId: Hex; publishedBlock: string }>;
          policyIds?: Hex[];
          lastSeenBlock: string;
        }
      | undefined;
    db.close();

    expect(raw).toBeDefined();
    expect(raw!.entries).toBeDefined();
    expect(raw!.entries).toHaveLength(2);
    for (const entry of raw!.entries!) {
      expect(entry.publishedBlock).toBe("0");
    }
    // Legacy field must be gone — leaving it would let a read-time
    // back-compat path re-introduce the old shape on re-save.
    expect(raw!.policyIds).toBeUndefined();
    expect(raw!.lastSeenBlock).toBe("777");
  });

  it("migration is idempotent — re-opening at v8 leaves an already-migrated record untouched", async () => {
    // The cursor's `Array.isArray(value.entries)` short-circuit means a
    // record already in v8 shape is a no-op. Verify by writing a real v8
    // record, re-opening the db (forces the upgrade callback to run again
    // in tests that drop and recreate the db), and asserting the record
    // is unchanged.
    await saveOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: {
        entries: [{ policyId: POLICY_A, publishedBlock: 1_234n, lastUpdatedBlock: 2_345n }],
        lastSeenBlock: 9_000n,
      },
    });
    const db = await openWardDB();
    db.close();
    const rich = await loadOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
    });
    expect(rich!.entries).toEqual([
      { policyId: POLICY_A, publishedBlock: 1_234n, lastUpdatedBlock: 2_345n },
    ]);
    expect(rich!.lastSeenBlock).toBe(9_000n);
  });

  it("runtime heal: rewrites a legacy row on first openWardDB call", async () => {
    // Simulate a db that was stamped at the current version but somehow
    // still carries a legacy-shape row (the upgrade-callback heal didn't
    // commit for whatever IDB lifecycle reason). The runtime heal that
    // runs inside openWardDB MUST physically rewrite the row using a
    // regular readwrite transaction.
    const KEY = `${CHAIN_ID}:${ORACLE.toLowerCase()}:${ALICE.toLowerCase()}`;
    const broken = await openDB(DB_NAME, 8, {
      upgrade(db) {
        for (const name of [
          "snapshots",
          "watched",
          "spend-daily",
          "violations",
          "ownerIndex",
          "publishedCache",
          "contractName",
        ]) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, {
              keyPath: name === "snapshots" ? "namespace" : "key",
            });
          }
        }
      },
    });
    await broken.put(OWNER_INDEX_STORE, {
      key: KEY,
      policyIds: [POLICY_A, POLICY_B],
      lastSeenBlock: "888",
      savedAtMs: 1_700_000_000_000,
    });
    broken.close();

    // openWardDB triggers BOTH the upgrade-callback heal AND the runtime
    // heal. Verify the resulting on-disk row is in v8 shape.
    const db = await openWardDB();
    const raw = (await db.get(OWNER_INDEX_STORE, KEY)) as
      | {
          key: string;
          entries?: Array<{ policyId: Hex; publishedBlock: string }>;
          policyIds?: Hex[];
          lastSeenBlock: string;
        }
      | undefined;
    db.close();

    expect(raw).toBeDefined();
    expect(raw!.entries).toBeDefined();
    expect(raw!.entries).toHaveLength(2);
    for (const entry of raw!.entries!) {
      expect(entry.publishedBlock).toBe("0");
    }
    expect(raw!.policyIds).toBeUndefined();
    expect(raw!.lastSeenBlock).toBe("888");
  });

  it("runtime heal: idempotent — second call returns alreadyClean count, no writes", async () => {
    // Write a real v8 row, then call runtimeHealOwnerIndex twice in a row.
    // The first call should see `alreadyClean=1` (no migration needed),
    // and the second should report the same — no double-rewrite, no
    // accidental drop.
    await saveOwnerIndexRich({
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      owner: ALICE,
      value: {
        entries: [
          { policyId: POLICY_A, publishedBlock: 1_000n, lastUpdatedBlock: 1_500n },
        ],
        lastSeenBlock: 2_000n,
      },
    });
    const db = await openWardDB();
    try {
      const first = await runtimeHealOwnerIndex(db);
      expect(first).toEqual({ migrated: 0, dropped: 0, alreadyClean: 1 });
      const second = await runtimeHealOwnerIndex(db);
      expect(second).toEqual({ migrated: 0, dropped: 0, alreadyClean: 1 });
      // Confirm the row is byte-identical to what we wrote.
      const rich = await loadOwnerIndexRich({
        chainId: CHAIN_ID,
        oracleAddress: ORACLE,
        owner: ALICE,
      });
      expect(rich!.entries).toEqual([
        { policyId: POLICY_A, publishedBlock: 1_000n, lastUpdatedBlock: 1_500n },
      ]);
      expect(rich!.lastSeenBlock).toBe(2_000n);
    } finally {
      db.close();
    }
  });

  it("runtime heal: deletes a row missing both entries and policyIds as corrupt", async () => {
    // A row carrying neither `entries` nor `policyIds` can't be salvaged —
    // there's no shape we can rewrite it to. The heal must delete it.
    const KEY = `${CHAIN_ID}:${ORACLE.toLowerCase()}:${ALICE.toLowerCase()}`;
    const db = await openWardDB();
    try {
      // Inject a corrupt row directly via a regular tx.
      const writeTx = db.transaction(OWNER_INDEX_STORE, "readwrite");
      await writeTx.store.put({
        key: KEY,
        lastSeenBlock: "1",
        savedAtMs: 1_700_000_000_000,
      });
      await writeTx.done;

      const result = await runtimeHealOwnerIndex(db);
      expect(result.dropped).toBe(1);
      expect(result.migrated).toBe(0);
      expect(result.alreadyClean).toBe(0);

      const raw = await db.get(OWNER_INDEX_STORE, KEY);
      expect(raw).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("v8→v9 heal: rewrites a row stuck at v8 in the legacy policyIds[] shape", async () => {
    // The bug this guards against: an earlier broken-migration cycle
    // stamped the db at version=8 WITHOUT rewriting the row, so the row
    // sat at version=8 carrying the legacy `{ policyIds, lastSeenBlock,
    // savedAtMs }` shape forever. A version-gated `oldVersion < 8`
    // migration could never reach those rows because the upgrade
    // callback wouldn't fire at all. The v9 heal is shape-detecting:
    // bumping the version forces the upgrade callback to re-enter, and
    // the cursor only rewrites rows that still carry `policyIds` without
    // `entries`.
    //
    // We simulate the broken-v8 state by opening the db AT version 8
    // with no upgrade body, then writing the legacy-shape record
    // directly into the ownerIndex store. The next openWardDB() jumps
    // from v8 → v9 and the heal MUST physically rewrite the row.
    const KEY = `${CHAIN_ID}:${ORACLE.toLowerCase()}:${ALICE.toLowerCase()}`;
    const broken = await openDB(DB_NAME, 8, {
      upgrade(db) {
        for (const name of [
          "snapshots",
          "watched",
          "spend-daily",
          "violations",
          "ownerIndex",
          "publishedCache",
          "contractName",
        ]) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, {
              keyPath: name === "snapshots" ? "namespace" : "key",
            });
          }
        }
      },
    });
    await broken.put(OWNER_INDEX_STORE, {
      key: KEY,
      policyIds: [POLICY_A, POLICY_B],
      lastSeenBlock: "555",
      savedAtMs: 1_700_000_000_000,
    });
    broken.close();

    // Force-trigger the v8 → v9 heal.
    const db = await openWardDB();
    const raw = (await db.get(OWNER_INDEX_STORE, KEY)) as
      | {
          key: string;
          entries?: Array<{ policyId: Hex; publishedBlock: string }>;
          policyIds?: Hex[];
          lastSeenBlock: string;
        }
      | undefined;
    db.close();

    expect(raw).toBeDefined();
    expect(raw!.entries).toBeDefined();
    expect(raw!.entries).toHaveLength(2);
    for (const entry of raw!.entries!) {
      expect(entry.publishedBlock).toBe("0");
    }
    // Legacy field must be gone — its lingering presence was the symptom
    // browser verify caught after the broken-v8 ship.
    expect(raw!.policyIds).toBeUndefined();
    expect(raw!.lastSeenBlock).toBe("555");
  });
});
