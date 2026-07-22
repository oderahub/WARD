import type { Address } from "viem";
import { openWardDB } from "./persistence";

/**
 * Per-(policy, agent, UTC day) cumulative spend tally for watch mode.
 *
 * Keying matches the SDK's utcDayBucket so the dashboard and SDK agree on
 * day boundaries. Stored as decimal strings since IndexedDB BigInt support
 * is uneven across browsers and we want the on-disk format inspectable.
 */

const SPEND_DAILY_STORE = "spend-daily";

export interface SpendDailyEntry {
  key: string;
  chainId: number;
  oracleAddress: string;
  policyId: string;
  agentAddress: string;
  utcDay: string;
  spentWei: string;
  lastSeenBlock: string;
  /**
   * Per-observation ledger keyed by `${txHash}:${observationIndex}` →
   * decimal wei string. Lets addSpendDaily be idempotent: re-applying an
   * observation that's already been counted is a no-op rather than
   * double-counting. Bucket is per-(policy, agent, utcDay) so the map
   * naturally prunes when the day rolls over. Older entries that lack
   * this field treat it as an empty map.
   */
  seenObservations?: Record<string, string>;
}

/** Hard cap on per-day observation ledger size. ~5K calls/day/agent is
 * already an unreasonable rate; past this we drop oldest insertions to
 * keep storage bounded. */
const MAX_SEEN_OBSERVATIONS = 5000;

export interface SpendKeyOpts {
  chainId: number;
  oracleAddress: Address;
  policyId: string;
  agentAddress: Address;
  utcDay: string;
}

export function computeKey(
  chainId: number,
  oracleAddress: Address,
  policyId: string,
  agentAddress: Address,
  utcDay: string,
): string {
  return `${chainId}:${oracleAddress.toLowerCase()}:${policyId.toLowerCase()}:${agentAddress.toLowerCase()}:${utcDay}`;
}

export async function getSpendDaily(
  opts: SpendKeyOpts,
): Promise<SpendDailyEntry | null> {
  const db = await openWardDB();
  try {
    const key = computeKey(
      opts.chainId,
      opts.oracleAddress,
      opts.policyId,
      opts.agentAddress,
      opts.utcDay,
    );
    const rec = (await db.get(SPEND_DAILY_STORE, key)) as
      | SpendDailyEntry
      | undefined;
    return rec ?? null;
  } finally {
    db.close();
  }
}

export interface AddSpendObservation {
  txHash: string;
  observationIndex: number;
}

/**
 * Add a spend observation. Idempotent: if (txHash, observationIndex) has
 * already been recorded for this (policy, agent, utcDay) bucket, the call
 * is a no-op — the daily total is NOT increased a second time. This makes
 * watch-mode safe across reloads and re-polls: a tab that closes before
 * lastCheckedBlock is bumped will re-see the same observations on next
 * poll without double-counting.
 *
 * Returns `applied: true` when the observation was newly recorded,
 * `false` when it was a no-op duplicate.
 */
export async function addSpendDaily(
  spent: bigint,
  lastSeenBlock: bigint,
  opts: SpendKeyOpts,
  observation: AddSpendObservation,
): Promise<{ applied: boolean }> {
  const db = await openWardDB();
  try {
    const key = computeKey(
      opts.chainId,
      opts.oracleAddress,
      opts.policyId,
      opts.agentAddress,
      opts.utcDay,
    );
    const tx = db.transaction(SPEND_DAILY_STORE, "readwrite");
    const existing = (await tx.store.get(key)) as SpendDailyEntry | undefined;
    const prevSpent = existing ? BigInt(existing.spentWei) : 0n;
    const prevBlock = existing ? BigInt(existing.lastSeenBlock) : 0n;
    const seen: Record<string, string> = existing?.seenObservations
      ? { ...existing.seenObservations }
      : {};
    const obsKey = `${observation.txHash.toLowerCase()}:${observation.observationIndex}`;
    if (seen[obsKey] !== undefined) {
      // Already counted — close the txn untouched and report no-op.
      await tx.done;
      return { applied: false };
    }
    seen[obsKey] = spent.toString();
    // Bound the map. Per-day bucketing already prunes naturally when utcDay
    // rolls; this is the within-day backstop. We drop oldest insertion-order
    // keys, which is good enough since this is a debug-shaped overflow path.
    const keys = Object.keys(seen);
    if (keys.length > MAX_SEEN_OBSERVATIONS) {
      const excess = keys.length - MAX_SEEN_OBSERVATIONS;
      for (let i = 0; i < excess; i++) delete seen[keys[i]];
    }
    const nextSpent = prevSpent + spent;
    const nextBlock = lastSeenBlock > prevBlock ? lastSeenBlock : prevBlock;
    const rec: SpendDailyEntry = {
      key,
      chainId: opts.chainId,
      oracleAddress: opts.oracleAddress,
      policyId: opts.policyId,
      agentAddress: opts.agentAddress,
      utcDay: opts.utcDay,
      spentWei: nextSpent.toString(),
      lastSeenBlock: nextBlock.toString(),
      seenObservations: seen,
    };
    await tx.store.put(rec);
    await tx.done;
    return { applied: true };
  } finally {
    db.close();
  }
}
