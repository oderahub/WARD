import type { Address } from "viem";
import { openSentryDB } from "./persistence";

/**
 * Persisted watch-mode violations. The key includes `observationIndex`
 * (the trace ordinal from debug_traceTransaction) rather than `logIndex`,
 * because watch mode evaluates trace calls, not receipt logs — different
 * traces in the same tx can hit the same (target, selector).
 */

const VIOLATIONS_STORE = "violations";
const MAX_PER_BUCKET = 500;

export interface PersistedViolation {
  key: string;
  chainId: number;
  oracleAddress: string;
  policyId: string;
  agentAddress: string;
  txHash: string;
  observationIndex: number;
  blockNumber: string;
  target: string;
  selector: string;
  valueWei: string;
  reason: string;
  observedAtMs: number;
}

export interface ViolationKeyOpts {
  chainId: number;
  oracleAddress: Address;
  policyId: string;
  agentAddress: Address;
  txHash: string;
  observationIndex: number;
  target: Address;
  selector: string;
}

export function computeKey(opts: ViolationKeyOpts): string {
  return [
    opts.chainId,
    opts.oracleAddress.toLowerCase(),
    opts.policyId.toLowerCase(),
    opts.agentAddress.toLowerCase(),
    opts.txHash.toLowerCase(),
    opts.observationIndex,
    opts.target.toLowerCase(),
    opts.selector.toLowerCase(),
  ].join(":");
}

export async function addViolation(v: PersistedViolation): Promise<void> {
  const db = await openSentryDB();
  try {
    const tx = db.transaction(VIOLATIONS_STORE, "readwrite");
    // Idempotent: put() on the same key overwrites with identical content.
    await tx.store.put(v);
    await tx.done;
  } finally {
    db.close();
  }
}

export interface ListViolationsOpts {
  chainId: number;
  oracleAddress: Address;
  policyId?: string;
  agentAddress?: Address;
  limit?: number;
}

export async function listViolations(
  opts: ListViolationsOpts,
): Promise<PersistedViolation[]> {
  const db = await openSentryDB();
  try {
    const oracle = opts.oracleAddress.toLowerCase();
    const policyId = opts.policyId?.toLowerCase();
    const agent = opts.agentAddress?.toLowerCase();
    const all = (await db.getAll(VIOLATIONS_STORE)) as PersistedViolation[];
    const filtered = all.filter((v) => {
      if (v.chainId !== opts.chainId) return false;
      if (v.oracleAddress.toLowerCase() !== oracle) return false;
      if (policyId && v.policyId.toLowerCase() !== policyId) return false;
      if (agent && v.agentAddress.toLowerCase() !== agent) return false;
      return true;
    });
    filtered.sort((a, b) => b.observedAtMs - a.observedAtMs);
    return typeof opts.limit === "number"
      ? filtered.slice(0, opts.limit)
      : filtered;
  } finally {
    db.close();
  }
}

export interface PruneViolationsOpts {
  chainId: number;
  oracleAddress: Address;
  policyId: string;
  agentAddress: Address;
}

export async function pruneViolations(
  opts: PruneViolationsOpts,
): Promise<void> {
  const db = await openSentryDB();
  try {
    const oracle = opts.oracleAddress.toLowerCase();
    const policyId = opts.policyId.toLowerCase();
    const agent = opts.agentAddress.toLowerCase();
    const tx = db.transaction(VIOLATIONS_STORE, "readwrite");
    const all = (await tx.store.getAll()) as PersistedViolation[];
    const bucket = all.filter(
      (v) =>
        v.chainId === opts.chainId &&
        v.oracleAddress.toLowerCase() === oracle &&
        v.policyId.toLowerCase() === policyId &&
        v.agentAddress.toLowerCase() === agent,
    );
    if (bucket.length <= MAX_PER_BUCKET) {
      await tx.done;
      return;
    }
    // Newest first; drop the tail (oldest by observedAtMs).
    bucket.sort((a, b) => b.observedAtMs - a.observedAtMs);
    const toDelete = bucket.slice(MAX_PER_BUCKET);
    for (const v of toDelete) {
      await tx.store.delete(v.key);
    }
    await tx.done;
  } finally {
    db.close();
  }
}
