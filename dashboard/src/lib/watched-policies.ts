import type { Hex } from "viem";
import { openSentryDB } from "./persistence";

/**
 * Local registry of policies the dashboard is watching in passive (non-
 * enforcing) mode. The watcher hook polls each (policyId, agent) pair against
 * the agent's tx history off-chain and surfaces violations as alerts — it
 * never blocks. We persist the cursor (`lastCheckedBlock`) so reloads resume
 * incrementally instead of rescanning history every time.
 *
 * Storage lives in the same `sentry-store` IndexedDB as the snapshot cache.
 * Records are keyed by
 * `${chainId}:${oracleAddress.toLowerCase()}:${policyId.toLowerCase()}:${agent.toLowerCase()}`
 * so the same (policyId, agent) pair can be watched independently across
 * chains / oracle deployments without colliding. Listing is scoped to
 * (chainId, oracleAddress).
 */

const STORE = "watched";

export interface WatchedPolicy {
  policyId: Hex;
  watchedAgentAddress: Hex;
  label: string;
  chainId: number;
  oracleAddress: Hex;
  addedAtMs: number;
  lastCheckedBlock: string;
  /**
   * JSON-serialized PolicyInput captured at bind time. Bigint fields
   * (dailySpendWeiCap, expiresAt, valueCapPerCall, delaySeconds) are stored
   * as decimal strings; getCachedPolicyInput hydrates them back to bigint.
   * Optional so pre-existing entries (added before this field landed) keep
   * working — they just fall back to chain reconstruction.
   */
  policyInputJSON?: string;
}

/**
 * Subset of the SDK PolicyInput shape that uses bigint. Kept loose (Record)
 * to avoid coupling this storage layer to the SDK types directly.
 */
const BIGINT_FIELDS = new Set([
  "dailySpendWeiCap",
  "expiresAt",
  "valueCapPerCall",
  "delaySeconds",
]);

interface WatchedRecord extends WatchedPolicy {
  key: string;
}

function watchedKey(
  chainId: number,
  oracleAddress: Hex,
  policyId: Hex,
  watchedAgent: Hex,
): string {
  return `${chainId}:${oracleAddress.toLowerCase()}:${policyId.toLowerCase()}:${watchedAgent.toLowerCase()}`;
}

export async function addWatchedPolicy(entry: WatchedPolicy): Promise<void> {
  const db = await openSentryDB();
  try {
    const rec: WatchedRecord = {
      ...entry,
      key: watchedKey(
        entry.chainId,
        entry.oracleAddress,
        entry.policyId,
        entry.watchedAgentAddress,
      ),
    };
    const tx = db.transaction(STORE, "readwrite");
    await tx.store.put(rec);
    await tx.done;
  } finally {
    db.close();
  }
}

export async function removeWatchedPolicy(
  chainId: number,
  oracleAddress: Hex,
  policyId: Hex,
  watchedAgent: Hex,
): Promise<void> {
  const db = await openSentryDB();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await tx.store.delete(watchedKey(chainId, oracleAddress, policyId, watchedAgent));
    await tx.done;
  } finally {
    db.close();
  }
}

export async function listWatchedPolicies(
  chainId: number,
  oracleAddress: Hex,
): Promise<WatchedPolicy[]> {
  const db = await openSentryDB();
  try {
    const all = (await db.getAll(STORE)) as WatchedRecord[];
    const oracleLower = oracleAddress.toLowerCase();
    return all
      .filter(
        (r) => r.chainId === chainId && r.oracleAddress.toLowerCase() === oracleLower,
      )
      .map(({ key: _key, ...entry }) => entry);
  } finally {
    db.close();
  }
}

export async function getWatchedPolicy(
  chainId: number,
  oracleAddress: Hex,
  policyId: Hex,
  watchedAgent: Hex,
): Promise<WatchedPolicy | undefined> {
  const db = await openSentryDB();
  try {
    const rec = (await db.get(
      STORE,
      watchedKey(chainId, oracleAddress, policyId, watchedAgent),
    )) as WatchedRecord | undefined;
    if (!rec) return undefined;
    const { key: _key, ...entry } = rec;
    return entry;
  } finally {
    db.close();
  }
}

/**
 * Re-hydrate the cached PolicyInput from its JSON blob. Returns null when the
 * entry has no cached input or the blob is malformed — callers should fall
 * back to chain reconstruction in that case. Known bigint fields are revived
 * from decimal strings.
 */
export function getCachedPolicyInput(entry: WatchedPolicy): Record<string, unknown> | null {
  if (!entry.policyInputJSON) return null;
  try {
    const parsed = JSON.parse(entry.policyInputJSON) as Record<string, unknown>;
    for (const field of BIGINT_FIELDS) {
      const v = parsed[field];
      if (typeof v === "string") parsed[field] = BigInt(v);
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function updateLastCheckedBlock(
  chainId: number,
  oracleAddress: Hex,
  policyId: Hex,
  watchedAgent: Hex,
  blockNumber: bigint,
): Promise<void> {
  const db = await openSentryDB();
  try {
    const key = watchedKey(chainId, oracleAddress, policyId, watchedAgent);
    const tx = db.transaction(STORE, "readwrite");
    const existing = (await tx.store.get(key)) as WatchedRecord | undefined;
    if (!existing) {
      await tx.done;
      return;
    }
    const updated: WatchedRecord = {
      ...existing,
      lastCheckedBlock: blockNumber.toString(),
    };
    await tx.store.put(updated);
    await tx.done;
  } finally {
    db.close();
  }
}
