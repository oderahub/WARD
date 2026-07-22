import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import type { Hex } from "viem";

import { openWardDB } from "../../src/lib/persistence";
import { listWatchedPolicies } from "../../src/lib/watched-policies";

const DB_NAME = "ward-store";
const WATCHED_STORE = "watched";

const POLICY_ID = "0xabc0000000000000000000000000000000000000000000000000000000000001" as Hex;
const AGENT = "0xAAaaaaaaAaAaAAAaaAAaAaaAAAAaAaaAAAaaAaA0" as Hex;
const ORACLE = "0x1111111111111111111111111111111111111111" as Hex;
const CHAIN_ID = 43113;

// Mimic v3's old `${policyId}:${agent}` key shape.
function legacyKey(policyId: string, agent: string): string {
  return `${policyId}:${agent}`;
}

// Build a fresh v3 db with a watched record under the legacy key.
async function seedV3Db(record: {
  policyId: Hex;
  watchedAgentAddress: Hex;
  oracleAddress: Hex;
  chainId: number;
  label?: string;
}) {
  const db = await openDB(DB_NAME, 3, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("snapshots")) {
        db.createObjectStore("snapshots", { keyPath: "namespace" });
      }
      if (!db.objectStoreNames.contains(WATCHED_STORE)) {
        db.createObjectStore(WATCHED_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("spend-daily")) {
        db.createObjectStore("spend-daily", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("violations")) {
        db.createObjectStore("violations", { keyPath: "key" });
      }
    },
  });
  await db.put(WATCHED_STORE, {
    key: legacyKey(record.policyId, record.watchedAgentAddress),
    policyId: record.policyId,
    watchedAgentAddress: record.watchedAgentAddress,
    label: record.label ?? "seeded-v3",
    chainId: record.chainId,
    oracleAddress: record.oracleAddress,
    addedAtMs: 1_700_000_000_000,
    lastCheckedBlock: "0",
  });
  db.close();
}

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe("v3 → v4 watched-store rekey migration", () => {
  it("rekeys existing watched records in place rather than dropping them", async () => {
    await seedV3Db({
      policyId: POLICY_ID,
      watchedAgentAddress: AGENT,
      oracleAddress: ORACLE,
      chainId: CHAIN_ID,
    });

    // Triggers v3 → v4 upgrade.
    const db = await openWardDB();
    db.close();

    const list = await listWatchedPolicies(CHAIN_ID, ORACLE);
    expect(list).toHaveLength(1);
    expect(list[0].policyId).toBe(POLICY_ID);
    expect(list[0].watchedAgentAddress).toBe(AGENT);
    expect(list[0].chainId).toBe(CHAIN_ID);
    expect(list[0].label).toBe("seeded-v3");

    // The new wide key should be present; the legacy short key should be gone.
    const db2 = await openWardDB();
    const newKey = `${CHAIN_ID}:${ORACLE.toLowerCase()}:${POLICY_ID.toLowerCase()}:${AGENT.toLowerCase()}`;
    const newRec = await db2.get(WATCHED_STORE, newKey);
    expect(newRec).toBeDefined();
    const oldRec = await db2.get(WATCHED_STORE, legacyKey(POLICY_ID, AGENT));
    expect(oldRec).toBeUndefined();
    db2.close();
  });

  it("drops records missing chainId/oracleAddress so they cannot crash listWatchedPolicies", async () => {
    // Seed two records: one valid, one corrupt (missing oracleAddress).
    const CORRUPT_KEY = "corrupt-key";
    const db = await openDB(DB_NAME, 3, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("snapshots")) {
          db.createObjectStore("snapshots", { keyPath: "namespace" });
        }
        if (!db.objectStoreNames.contains(WATCHED_STORE)) {
          db.createObjectStore(WATCHED_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("spend-daily")) {
          db.createObjectStore("spend-daily", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("violations")) {
          db.createObjectStore("violations", { keyPath: "key" });
        }
      },
    });
    await db.put(WATCHED_STORE, {
      key: legacyKey(POLICY_ID, AGENT),
      policyId: POLICY_ID,
      watchedAgentAddress: AGENT,
      label: "good",
      chainId: CHAIN_ID,
      oracleAddress: ORACLE,
      addedAtMs: 1_700_000_000_000,
      lastCheckedBlock: "0",
    });
    await db.put(WATCHED_STORE, {
      key: CORRUPT_KEY,
      policyId: POLICY_ID,
      watchedAgentAddress: AGENT,
      label: "corrupt",
      // chainId + oracleAddress intentionally absent.
      addedAtMs: 1_700_000_000_000,
      lastCheckedBlock: "0",
    });
    db.close();

    // Should not throw.
    const upgraded = await openWardDB();
    upgraded.close();

    // listWatchedPolicies must not crash even though the migration encountered
    // a corrupt row — the corrupt record would otherwise blow up at
    // r.oracleAddress.toLowerCase() in watched-policies.ts.
    const list = await listWatchedPolicies(CHAIN_ID, ORACLE);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("good");

    // The corrupt record's old key was deleted during the upgrade tx.
    const db2 = await openWardDB();
    const corruptRec = await db2.get(WATCHED_STORE, CORRUPT_KEY);
    expect(corruptRec).toBeUndefined();
    db2.close();
  });
});
