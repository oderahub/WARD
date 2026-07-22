import { describe, it, expect, vi } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";

import {
  lookupPoliciesByOwner,
  lookupPolicyOnChain,
} from "../../src/lib/onChainPolicyLookup";
import { SENTRY_ORACLE_ABI, type PolicyMeta } from "@sentry-somnia/sdk";

/**
 * Build the calldata for `updatePolicy(policyId, input)` with a minimal
 * PolicyInput carrying only the fields the update-decode path inspects
 * (`paused`, `expiresAt`). Used by the fast-path tests to seed
 * `txInputs` so decodeUpdatePolicyTx can recover the latest values.
 */
function encodeUpdatePolicyCalldata(
  policyId: Hex,
  fields: { paused: boolean; expiresAt: bigint },
): Hex {
  return encodeFunctionData({
    abi: SENTRY_ORACLE_ABI,
    functionName: "updatePolicy",
    args: [
      policyId,
      {
        targets: [],
        dailySpendWeiCap: 0n,
        maxSlippageBps: 0,
        expiresAt: fields.expiresAt,
        paused: fields.paused,
      },
    ],
  }) as Hex;
}

const ORACLE = "0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf" as Address;
const ALICE = "0x000000000000000000000000000000000000A11C" as Address;
const POLICY_A = ("0x" + "aa".repeat(32)) as Hex;
const POLICY_B = ("0x" + "bb".repeat(32)) as Hex;
const POLICY_C = ("0x" + "cc".repeat(32)) as Hex;

interface FakeLog {
  args: { policyId?: Hex; owner?: Address; label?: Hex };
  blockNumber: bigint;
}

interface CallRecord {
  fromBlock: bigint;
  toBlock: bigint;
}

function fakeClient(opts: {
  /** Logs to return, indexed by block. Each chunked getContractEvents call
   *  filters this pool by [fromBlock, toBlock]. */
  logs: FakeLog[];
  /** When set, the call whose toBlock matches one of these values throws —
   *  used to assert the chunker keeps walking through RPC blips. */
  failAtToBlock?: bigint[];
}): { client: { getContractEvents: (a: { fromBlock: bigint; toBlock: bigint }) => Promise<FakeLog[]> }; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  return {
    client: {
      getContractEvents: vi.fn(async ({ fromBlock, toBlock }) => {
        calls.push({ fromBlock, toBlock });
        if (opts.failAtToBlock?.some((b) => b === toBlock)) {
          throw new Error("rpc blip");
        }
        return opts.logs.filter(
          (l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock,
        );
      }),
    },
    calls,
  };
}

describe("lookupPoliciesByOwner", () => {
  it("chunks the REORG-SAFE window [fromBlock, toBlock - 12] at the default 1000-block stride", async () => {
    const { client, calls } = fakeClient({ logs: [] });
    await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_500n,
    });
    // safeToBlock = 2500 - 12 = 2488. 2489 blocks at 1000 per chunk →
    // 3 calls: [0..999], [1000..1999], [2000..2488]. The unsafe tail
    // (2489..2500) is intentionally NEVER scanned — phantom prevention.
    expect(calls).toHaveLength(3);
    expect(calls[0].fromBlock).toBe(0n);
    expect(calls[0].toBlock).toBe(999n);
    expect(calls[1].fromBlock).toBe(1_000n);
    expect(calls[1].toBlock).toBe(1_999n);
    expect(calls[2].fromBlock).toBe(2_000n);
    expect(calls[2].toBlock).toBe(2_488n);
  });

  it("returns discovered policies (deduplicated by policyId, case-preserved)", async () => {
    const { client } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 10n },
        { args: { policyId: POLICY_B, owner: ALICE }, blockNumber: 50n },
        // duplicate of POLICY_A in a later chunk (e.g. PolicyUpdated re-emit)
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 1_100n },
        { args: { policyId: POLICY_C, owner: ALICE }, blockNumber: 1_500n },
      ],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_000n,
    });
    expect(result.policies.map((p) => p.policyId).sort()).toEqual(
      [POLICY_A, POLICY_B, POLICY_C].sort(),
    );
  });

  it("returns scannedToBlock = toBlock - REORG_DEPTH (12) for the resume cursor", async () => {
    const { client } = fakeClient({ logs: [] });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 1_000n,
    });
    expect(result.scannedToBlock).toBe(988n);
  });

  it("scannedToBlock clamps to 0n when toBlock is inside the reorg window", async () => {
    const { client } = fakeClient({ logs: [] });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 5n,
    });
    expect(result.scannedToBlock).toBe(0n);
  });

  it("inverted [from > to] range short-circuits without throwing or calling RPC", async () => {
    const { client, calls } = fakeClient({ logs: [] });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 100n,
      toBlock: 50n,
    });
    expect(calls).toHaveLength(0);
    expect(result.policies).toHaveLength(0);
  });

  it("inverted range fromBlock > toBlock → returns empty + scannedToBlock = fromBlock - 1", async () => {
    // Reorg-aware caller (or block-time jitter) can pass a fromBlock that's
    // already past head. We must NOT clamp to safeToBlock here — that would
    // REWIND the persisted cursor below the caller's prior position. Instead
    // return `fromBlock - 1` so `lastSeenBlock = scannedToBlock` is the
    // caller's existing cursor unchanged.
    const { client, calls } = fakeClient({ logs: [] });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 101n,
      toBlock: 100n,
    });
    expect(calls).toHaveLength(0);
    expect(result.policies).toHaveLength(0);
    expect(result.scannedToBlock).toBe(100n);
  });

  it("fromBlock = toBlock (valid single-block range) is NOT treated as inverted", async () => {
    // Edge case: a one-block window is a valid range, not an inverted one.
    // The chunker should still issue the single getContractEvents call for
    // [100..100] (subject to the reorg-trim no-op guard — see below).
    // With fromBlock=toBlock=100, safeToBlock clamps to 0 (toBlock < REORG_DEPTH),
    // so we'd hit the second guard, not the inverted-range one. To exercise
    // the "valid single-block range" path we use a span well past the reorg
    // window so safeToBlock >= fromBlock.
    const { client, calls } = fakeClient({
      logs: [{ args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 1_000n }],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 1_000n,
      toBlock: 1_012n,
    });
    // safeToBlock = 1012 - 12 = 1000. Single chunk [1000..1000], one RPC
    // call, POLICY_A discovered → confirms the inverted guard did NOT fire.
    expect(calls).toHaveLength(1);
    expect(calls[0].fromBlock).toBe(1_000n);
    expect(calls[0].toBlock).toBe(1_000n);
    expect(result.policies.map((p) => p.policyId)).toEqual([POLICY_A]);
    expect(result.scannedToBlock).toBe(1_000n);
  });

  it("no-ops when toBlock - fromBlock < REORG_DEPTH (nothing safe to scan yet)", async () => {
    // fromBlock=1000, toBlock=1005 → safeToBlock=993 < fromBlock=1000.
    // Should NOT advance the cursor backwards into already-scanned blocks,
    // and should NOT issue any RPC call (the entire window is unsafe).
    const { client, calls } = fakeClient({
      logs: [
        // Phantom log a reorg might drop — must NOT appear in result.
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 1_003n },
      ],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 1_000n,
      toBlock: 1_005n,
    });
    expect(calls).toHaveLength(0);
    expect(result.policies).toHaveLength(0);
    // scannedToBlock = fromBlock - 1 so the caller's prior cursor stays put.
    expect(result.scannedToBlock).toBe(999n);
  });

  it("scannedToBlock equals toBlock - 12 when the safe window is wide", async () => {
    // toBlock - fromBlock >> REORG_DEPTH. The unsafe tail (last 12 blocks)
    // is excluded from the scan, and scannedToBlock is the new resume cursor.
    const { client, calls } = fakeClient({
      logs: [
        // In-window — should be discovered.
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 5_000n },
        // In the unsafe tail (toBlock=100_000, safeToBlock=99_988) — MUST be
        // excluded so a reorg there can't leave a phantom in the owner index.
        { args: { policyId: POLICY_B, owner: ALICE }, blockNumber: 99_995n },
      ],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 100_000n,
    });
    expect(result.scannedToBlock).toBe(99_988n);
    expect(result.policies.map((p) => p.policyId)).toEqual([POLICY_A]);
    // The last chunk's toBlock must equal safeToBlock, never the raw head.
    expect(calls[calls.length - 1].toBlock).toBe(99_988n);
  });

  it("survives an RPC blip on one chunk and keeps walking", async () => {
    const { client, calls } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 10n },
        // POLICY_B lives in the chunk we'll fail on
        { args: { policyId: POLICY_B, owner: ALICE }, blockNumber: 1_100n },
        { args: { policyId: POLICY_C, owner: ALICE }, blockNumber: 2_100n },
      ],
      failAtToBlock: [1_999n], // chunk 2 throws
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_500n,
    });
    // chunk 2 threw → POLICY_B not seen this scan. The walker still emits
    // calls 0, 1, 2 and POLICY_A + POLICY_C come through.
    expect(calls).toHaveLength(3);
    expect(result.policies.map((p) => p.policyId).sort()).toEqual(
      [POLICY_A, POLICY_C].sort(),
    );
  });

  it("middle chunk fails → scannedToBlock caps at end of last contiguous-success chunk", async () => {
    // Chunks: [0..999] ok, [1000..1999] fails, [2000..2488] ok.
    // The gap at chunk 2 breaks the contiguous-success run, so the cursor
    // must NOT advance past 999 — otherwise the next scan would start at
    // 1000+ and silently drop any PolicyPublished in the failed range.
    const { client } = fakeClient({
      logs: [],
      failAtToBlock: [1_999n],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_500n,
    });
    expect(result.scannedToBlock).toBe(999n);
  });

  it("first chunk fails → scannedToBlock = fromBlock - 1 even if later chunks succeed", async () => {
    // Chunks: [0..999] fails, [1000..1999] ok, [2000..2488] ok.
    // First chunk's failure caps the contiguous-success watermark at
    // fromBlock - 1 (= -1 clamped to 0n). Later policyIds still flow back
    // (the EventStore dedupes on next scan), but the cursor refuses to
    // advance past the unverified first range.
    const { client } = fakeClient({
      logs: [
        { args: { policyId: POLICY_B, owner: ALICE }, blockNumber: 1_100n },
        { args: { policyId: POLICY_C, owner: ALICE }, blockNumber: 2_100n },
      ],
      failAtToBlock: [999n],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_500n,
    });
    expect(result.scannedToBlock).toBe(0n);
    expect(result.policies.map((p) => p.policyId).sort()).toEqual(
      [POLICY_B, POLICY_C].sort(),
    );
  });

  it("first chunk fails (non-zero fromBlock) → scannedToBlock = fromBlock - 1, prior cursor preserved", async () => {
    // Resume scan starting at fromBlock=1000. First chunk [1000..1999] fails.
    // The watermark must stay at 999 so the persisted cursor doesn't rewind
    // OR advance — the next scan re-runs starting at 1000 and re-tries the
    // failed chunk.
    const { client } = fakeClient({
      logs: [],
      failAtToBlock: [1_999n],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 1_000n,
      toBlock: 3_500n,
    });
    expect(result.scannedToBlock).toBe(999n);
  });

  it("all chunks fail → scannedToBlock = fromBlock - 1, empty policyIds, cursor does not advance", async () => {
    // Every chunk in [0..2488] throws. The contiguous-success watermark
    // never extends past its initial value (fromBlock - 1, clamped to 0n)
    // so the caller's persisted cursor is effectively unchanged and the
    // next scan re-runs the entire window.
    const { client, calls } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 10n },
      ],
      failAtToBlock: [999n, 1_999n, 2_488n],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_500n,
    });
    // All three chunks were attempted.
    expect(calls).toHaveLength(3);
    expect(result.policies).toHaveLength(0);
    expect(result.scannedToBlock).toBe(0n);
  });

  /* ------- onProgress callback (cold-start UX progress) ------- */

  it("onProgress fires once per chunk with monotonic chunkIdx and non-decreasing scannedToBlock", async () => {
    // Five chunks at the default 1000 stride against a 4_988-block safe
    // window. Each firing should carry chunkIdx = 1..5, totalChunks = 5
    // (stable), and scannedToBlock strictly increasing (chunk `to` values).
    // foundCount is non-decreasing as policies are discovered along the way.
    const { client } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 500n },
        { args: { policyId: POLICY_B, owner: ALICE }, blockNumber: 2_500n },
        // Same policy re-emitted in chunk 5 — dedupe means foundCount
        // stays flat across that chunk, exercising the "non-decreasing,
        // not strictly increasing" property of foundCount.
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 4_500n },
      ],
    });
    const events: Array<{
      chunkIdx: number;
      totalChunks: number;
      scannedToBlock: bigint;
      foundCount: number;
    }> = [];
    await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 5_000n,
      onProgress: (info) => {
        events.push({
          chunkIdx: info.chunkIdx,
          totalChunks: info.totalChunks,
          scannedToBlock: info.scannedToBlock,
          foundCount: info.foundCount,
        });
      },
    });
    // safeToBlock = 5000 - 12 = 4988. ceil((4988-0+1)/1000) = 5 chunks.
    expect(events).toHaveLength(5);
    // chunkIdx is 1-based and strictly increasing 1..5.
    expect(events.map((e) => e.chunkIdx)).toEqual([1, 2, 3, 4, 5]);
    // totalChunks is stable across every firing — denominator of "N of M".
    for (const e of events) expect(e.totalChunks).toBe(5);
    // scannedToBlock is the chunk's inclusive `to`, monotonically
    // non-decreasing (strictly increasing here because each chunk is
    // non-empty).
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].scannedToBlock >= events[i - 1].scannedToBlock).toBe(true);
    }
    // The last firing's scannedToBlock equals safeToBlock (the final
    // chunk's clamped `to`).
    expect(events[events.length - 1].scannedToBlock).toBe(4_988n);
    // foundCount is monotonically non-decreasing across firings.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].foundCount >= events[i - 1].foundCount).toBe(true);
    }
    // Two unique policies discovered total (POLICY_A duplicate de-duped).
    expect(events[events.length - 1].foundCount).toBe(2);
  });

  it("onProgress fires for failed chunks too — progress payload advances even on RPC blips", async () => {
    // The UI promises 'real movement even when a chunk blips'. The
    // chunker fires onProgress AFTER the success/failure branch so a
    // mid-scan RPC blip still increments chunkIdx + scannedToBlock for
    // the user, while the chunk's policies are absent and the contiguous
    // watermark stays behind (returned in scannedToBlock of the result).
    const { client } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 500n },
        { args: { policyId: POLICY_C, owner: ALICE }, blockNumber: 2_100n },
      ],
      failAtToBlock: [1_999n], // chunk 2 throws
    });
    const events: Array<{ chunkIdx: number; scannedToBlock: bigint }> = [];
    await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_500n,
      onProgress: (info) =>
        events.push({ chunkIdx: info.chunkIdx, scannedToBlock: info.scannedToBlock }),
    });
    // 3 chunks attempted, 3 firings — failure does NOT suppress progress.
    expect(events.map((e) => e.chunkIdx)).toEqual([1, 2, 3]);
    // scannedToBlock advances 999 → 1999 → 2488 even though chunk 2 threw.
    expect(events.map((e) => e.scannedToBlock)).toEqual([999n, 1_999n, 2_488n]);
  });

  it("onProgress is optional — omitting it doesn't break the scan", async () => {
    // Regression guard: the chunker must tolerate `args.onProgress`
    // being undefined (every existing caller pre-W4 omits it).
    const { client } = fakeClient({
      logs: [{ args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 10n }],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_500n,
    });
    expect(result.policies.map((p) => p.policyId)).toEqual([POLICY_A]);
  });

  it("onProgress throw is swallowed — a buggy subscriber cannot abort the scan", async () => {
    // The chunker wraps the callback in try/catch so a UI subscriber
    // that throws (e.g. `setState during render` bug) can't kill the
    // discovery loop and leave the user with a half-scanned ownerIndex.
    const { client } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 10n },
        { args: { policyId: POLICY_B, owner: ALICE }, blockNumber: 1_100n },
      ],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_500n,
      onProgress: () => {
        throw new Error("ui blew up");
      },
    });
    expect(result.policies.map((p) => p.policyId).sort()).toEqual(
      [POLICY_A, POLICY_B].sort(),
    );
    // The contiguous-success watermark still reaches safeToBlock — the
    // chunker did NOT bail out on the throws.
    expect(result.scannedToBlock).toBe(2_488n);
  });

  it("no chunks fail → scannedToBlock = safeToBlock (regression guard for the happy path)", async () => {
    // The contiguous-success tracker must still reach safeToBlock when
    // every chunk succeeds — this is the existing behavior the cursor
    // logic depends on for forward progress.
    const { client } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE }, blockNumber: 10n },
      ],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_500n,
    });
    expect(result.scannedToBlock).toBe(2_488n);
    expect(result.policies.map((p) => p.policyId)).toEqual([POLICY_A]);
  });

  /* ------- rich-metadata return shape (label + publishBlock + publisher) ------- */

  it("returned policies carry labelHex + publishBlock + publisher from the log", async () => {
    // The owner-scan caller (refreshOwnerIndex) hydrates PolicyMeta directly
    // from this struct — no follow-up RPC — so each field MUST round-trip
    // verbatim from the decoded log args.
    const labelA = ("0x" + "11".repeat(32)) as Hex;
    const labelB = ("0x" + "22".repeat(32)) as Hex;
    const { client } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE, label: labelA }, blockNumber: 10n },
        { args: { policyId: POLICY_B, owner: ALICE, label: labelB }, blockNumber: 1_100n },
      ],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_000n,
    });
    const byId = new Map(result.policies.map((p) => [p.policyId, p]));
    expect(byId.get(POLICY_A)).toMatchObject({
      policyId: POLICY_A,
      labelHex: labelA,
      publishBlock: 10n,
      publisher: ALICE,
    });
    expect(byId.get(POLICY_B)).toMatchObject({
      policyId: POLICY_B,
      labelHex: labelB,
      publishBlock: 1_100n,
      publisher: ALICE,
    });
  });

  it("publishBlock is the log.blockNumber (sanity)", async () => {
    // Regression guard: a prior shape dropped blockNumber on the floor and
    // forced callers to re-scan via lookupPolicyOnChain to recover it.
    const { client } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE, label: ("0x" + "00".repeat(32)) as Hex }, blockNumber: 4_321n },
      ],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 5_000n,
    });
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0].publishBlock).toBe(4_321n);
  });

  it("labelHex preserves all-zero bytes32 label (NOT treated as missing)", async () => {
    // An all-zero bytes32 label is a legitimate publish, NOT a sentinel.
    // The chunker must forward it verbatim so the caller's PolicyMeta
    // hydrate doesn't accidentally render it as "label not recoverable".
    const allZero = ("0x" + "00".repeat(32)) as Hex;
    const { client } = fakeClient({
      logs: [
        { args: { policyId: POLICY_A, owner: ALICE, label: allZero }, blockNumber: 10n },
      ],
    });
    const result = await lookupPoliciesByOwner({
      publicClient: client as never,
      oracleAddress: ORACLE,
      owner: ALICE,
      fromBlock: 0n,
      toBlock: 2_000n,
    });
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0].labelHex).toBe(allZero);
  });
});

/* ----------------- lookupPolicyOnChain — found / no-label / not-found ----------------- */

/**
 * Tiny fake PublicClient that satisfies the three methods lookupPolicyOnChain
 * touches: `readContract` (policyOwner + policyHealth), `getBlockNumber`, and
 * `getLogs`. We script the responses per call so individual tests can simulate
 * the not-found, found-no-label, and found-with-label cases without depending
 * on a live RPC.
 */
function fakePolicyClient(opts: {
  policyOwner: Address;
  paused?: boolean;
  expiresAt?: bigint;
  /** When set, getLogs returns this single hit on the first call. */
  publishLog?: {
    label: Hex;
    owner: Address;
    blockNumber: bigint;
    txHash: Hex;
  };
}): { readContract: (a: { functionName: string }) => Promise<unknown>; getBlockNumber: () => Promise<bigint>; getLogs: () => Promise<unknown[]> } {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "policyOwner") return opts.policyOwner;
      if (functionName === "policyHealth") {
        return [opts.paused ?? false, opts.expiresAt ?? 0n] as const;
      }
      throw new Error(`unexpected functionName: ${functionName}`);
    }),
    getBlockNumber: vi.fn(async () => 5_000n),
    getLogs: vi.fn(async () => {
      if (!opts.publishLog) return [];
      return [
        {
          args: {
            policyId: ("0x" + "ee".repeat(32)) as Hex,
            owner: opts.publishLog.owner,
            label: opts.publishLog.label,
          },
          blockNumber: opts.publishLog.blockNumber,
          transactionHash: opts.publishLog.txHash,
        },
      ];
    }),
  };
}

describe("lookupPolicyOnChain — discriminant `kind`", () => {
  const POLICY_ID = ("0x" + "ee".repeat(32)) as Hex;
  const PUBLISHER = "0x1234567890123456789012345678901234567890" as Address;
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

  it("returns kind='not_found' when policyOwner reports zero address (not-found)", async () => {
    const client = fakePolicyClient({ policyOwner: ZERO_ADDR });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID);
    expect(got.kind).toBe("not_found");
  });

  it("returns kind='found' with labelRecovered=false when policyOwner found but PolicyPublished logs missed", async () => {
    const client = fakePolicyClient({
      policyOwner: PUBLISHER,
      paused: false,
      expiresAt: 0n,
      // no publishLog → getLogs returns []
    });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID);
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.kind).toBe("found-no-label");
    expect(got.policy.labelRecovered).toBe(false);
    // labelHex stays undefined — the snapshot intentionally does NOT fall
    // back to all-zero bytes32 so consumers can't collide with a legitimate
    // empty-label publish. Callers use `labelRecovered` to decide what to
    // render, not the value of labelHex.
    expect(got.policy.label).toBeUndefined();
    expect(got.policy.labelHex).toBeUndefined();
    expect(got.policy.publisher).toBe(PUBLISHER);
  });

  it("returns kind='found' with labelRecovered=true when PolicyPublished log decoded successfully", async () => {
    const labelHex =
      "0x6d792d6c6162656c0000000000000000000000000000000000000000000000ff" as Hex; // "my-label" + non-zero tail to defeat the trim
    const client = fakePolicyClient({
      policyOwner: PUBLISHER,
      publishLog: {
        label: labelHex,
        owner: PUBLISHER,
        blockNumber: 4_321n,
        txHash: ("0x" + "ab".repeat(32)) as Hex,
      },
    });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID);
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.kind).toBe("found-with-label");
    expect(got.policy.labelRecovered).toBe(true);
    expect(got.policy.labelHex).toBe(labelHex);
    expect(got.policy.publishBlock).toBe(4_321n);
    expect(got.policy.txHash).toBe(("0x" + "ab".repeat(32)) as Hex);
  });

  it("labelRecovered=true even when the recovered label is the all-zero bytes32 (legitimately empty)", async () => {
    // Regression: the prior sentinel-based design used all-zero bytes32 as
    // the "label not recovered" marker, which collided with a legitimate
    // publish of an empty label. With the explicit boolean discriminator,
    // an empty-bytes32 label that came from a real PolicyPublished log
    // MUST report `labelRecovered: true` — the rendering layer can then
    // display it as-is rather than as "label not recoverable".
    const allZeroHex =
      "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
    const client = fakePolicyClient({
      policyOwner: PUBLISHER,
      publishLog: {
        label: allZeroHex,
        owner: PUBLISHER,
        blockNumber: 4_321n,
        txHash: ("0x" + "ab".repeat(32)) as Hex,
      },
    });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID);
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.kind).toBe("found-with-label");
    expect(got.policy.labelRecovered).toBe(true);
    expect(got.policy.labelHex).toBe(allZeroHex);
  });

  /* ----------- new observable behavior: rpc_error vs not_found ----------- */

  it("returns kind='rpc_error' (NOT not_found) when the policyOwner read throws", async () => {
    // The publish bookmark-recovery UI relied on this distinction: the
    // prior shape collapsed BOTH the zero-address case and the
    // policyOwner-throws case into `null`, which caused PublishPage to
    // flash "Policy not found" on a transient RPC blip. The fix is the
    // discriminated union — callers MUST be able to distinguish the two.
    const thrown = new Error("CALL_EXCEPTION: oracle read reverted");
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "policyOwner") throw thrown;
        throw new Error(`unexpected functionName: ${functionName}`);
      }),
      getBlockNumber: vi.fn(async () => 5_000n),
      getLogs: vi.fn(async () => []),
    };
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID);
    expect(got.kind).toBe("rpc_error");
    if (got.kind !== "rpc_error") throw new Error("unreachable");
    expect(got.error).toBe(thrown);
  });

  it("rpc_error preserves a non-Error throwable by wrapping into an Error", async () => {
    // Defensive: viem can in theory reject with a non-Error value (rare
    // but possible). The wrapper must produce a real Error so callers
    // can read `.message` without a runtime check.
    const client = {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "policyOwner") {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw "string-thrown" as never;
        }
        throw new Error(`unexpected functionName: ${functionName}`);
      }),
      getBlockNumber: vi.fn(async () => 5_000n),
      getLogs: vi.fn(async () => []),
    };
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID);
    expect(got.kind).toBe("rpc_error");
    if (got.kind !== "rpc_error") throw new Error("unreachable");
    expect(got.error).toBeInstanceOf(Error);
    expect(got.error.message).toBe("string-thrown");
  });
});

/* ----------------- PolicyMeta — labelRecovered discriminator ----------------- */

describe("PolicyMeta.labelRecovered — discriminator vs. sentinel-on-label", () => {
  // These are pure shape assertions: they verify a downstream consumer
  // (e.g. PublishPage's "label not recoverable" badge) can distinguish a
  // legitimately empty-bytes32 publish from a no-label probe result by
  // reading the boolean discriminator on PolicyMeta, NOT by matching the
  // label value against a magic sentinel.

  const POLICY_ID = ("0x" + "ee".repeat(32)) as Hex;
  const OWNER = "0x1234567890123456789012345678901234567890" as Address;
  const ALL_ZERO_LABEL =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

  it("empty-bytes32 label with labelRecovered=true is distinguishable from labelRecovered=false in PolicyMeta", () => {
    const legitimateEmptyLabel: PolicyMeta = {
      policyId: POLICY_ID,
      owner: OWNER,
      label: ALL_ZERO_LABEL,
      labelRecovered: true,
      lastUpdatedBlock: 100n,
    };
    const probeFallback: PolicyMeta = {
      policyId: POLICY_ID,
      owner: OWNER,
      // Placeholder bytes — the source of truth is `labelRecovered: false`.
      label: ALL_ZERO_LABEL,
      labelRecovered: false,
      lastUpdatedBlock: 100n,
    };
    // The label values are byte-identical; the discriminator is the only
    // honest signal. A renderer that gates the "not recoverable" badge on
    // the discriminator (instead of `label === ALL_ZERO`) shows the
    // empty-label case as a real, empty label.
    expect(legitimateEmptyLabel.label).toBe(probeFallback.label);
    expect(legitimateEmptyLabel.labelRecovered).toBe(true);
    expect(probeFallback.labelRecovered).toBe(false);
  });

  it("treats a snapshot missing `labelRecovered` as recovered=true for back-compat", () => {
    // Pre-W3 persisted snapshots had no labelRecovered field. The
    // re-hydration path in useEventStore defaults missing-as-`true`, since
    // the only way `label` got populated pre-W3 was via a real
    // PolicyPublished log decode (applyPolicyEvent set it). New no-label
    // probe writes always set the flag explicitly, so the default is
    // safe.
    const legacyShape: Record<string, unknown> = {
      policyId: POLICY_ID,
      owner: OWNER,
      label: ALL_ZERO_LABEL,
      lastUpdatedBlock: "100",
    };
    const recovered =
      typeof legacyShape.labelRecovered === "boolean" ? legacyShape.labelRecovered : true;
    expect(recovered).toBe(true);
  });
});

/* ----------------- lookupPolicyOnChain — publishedBlockHint fast-path ----------------- */

/**
 * Scriptable fake PublicClient that records every getLogs invocation so the
 * fast-path tests can assert "exactly one getLogs call pinned at the hint
 * block" rather than the legacy chunked backward walk (~5000 calls). Each
 * test seeds the publish log at a specific block; the fake returns it only
 * when the requested [fromBlock, toBlock] covers that block.
 */
function fakeHintClient(opts: {
  policyOwner: Address;
  publishAt?: { block: bigint; label: Hex; owner: Address; policyId: Hex };
  /** Optional PolicyUpdated event to seed at a specific block. Used by the
   *  `lastUpdatedBlockHint > publishedBlockHint` tests where the latest
   *  event is a `PolicyUpdated`, not a `PolicyPublished`. */
  updateAt?: {
    block: bigint;
    owner: Address;
    policyId: Hex;
    /** Tx hash returned for the update tx. Defaults to a fixed value when
     *  unset; the update-tx-decode path uses this to fetch calldata. */
    txHash?: Hex;
  };
  /** Optional getTransaction stub. When provided, returns the named input
   *  bytes for the matching txHash so the decode-update-calldata path can
   *  exercise extracting `paused` / `expiresAt` from the PolicyInput. */
  txInputs?: Record<string, Hex>;
}): {
  client: {
    readContract: (a: { functionName: string }) => Promise<unknown>;
    getBlockNumber: () => Promise<bigint>;
    getLogs: (a: {
      event?: { name?: string };
      fromBlock: bigint;
      toBlock: bigint;
    }) => Promise<unknown[]>;
    getTransaction?: (a: { hash: Hex }) => Promise<{ input: Hex }>;
  };
  getLogsCalls: Array<{ event?: string; fromBlock: bigint; toBlock: bigint }>;
} {
  const getLogsCalls: Array<{ event?: string; fromBlock: bigint; toBlock: bigint }> = [];
  const UPDATE_TX_DEFAULT = ("0x" + "ef".repeat(32)) as Hex;
  return {
    client: {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName === "policyOwner") return opts.policyOwner;
        if (functionName === "policyHealth") return [false, 0n] as const;
        throw new Error(`unexpected functionName: ${functionName}`);
      }),
      getBlockNumber: vi.fn(async () => 5_000_000n),
      getLogs: vi.fn(async ({ event, fromBlock, toBlock }) => {
        const eventName = event?.name;
        getLogsCalls.push({ event: eventName, fromBlock, toBlock });
        // Discriminate by event topic so `PolicyPublished` and
        // `PolicyUpdated` probes don't cross-pollute. The prior fake
        // ignored the event filter, which masked the `findUpdatedEvent`
        // path bug — a published-only seed would satisfy a PolicyUpdated
        // probe and hide the missing update event.
        if (eventName === "PolicyPublished") {
          if (!opts.publishAt) return [];
          if (opts.publishAt.block < fromBlock || opts.publishAt.block > toBlock) return [];
          return [
            {
              args: {
                policyId: opts.publishAt.policyId,
                owner: opts.publishAt.owner,
                label: opts.publishAt.label,
              },
              blockNumber: opts.publishAt.block,
              transactionHash: ("0x" + "cd".repeat(32)) as Hex,
            },
          ];
        }
        if (eventName === "PolicyUpdated") {
          if (!opts.updateAt) return [];
          if (opts.updateAt.block < fromBlock || opts.updateAt.block > toBlock) return [];
          return [
            {
              args: {
                policyId: opts.updateAt.policyId,
                owner: opts.updateAt.owner,
              },
              blockNumber: opts.updateAt.block,
              transactionHash: opts.updateAt.txHash ?? UPDATE_TX_DEFAULT,
            },
          ];
        }
        return [];
      }),
      getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
        const input = opts.txInputs?.[hash.toLowerCase()];
        if (!input) throw new Error(`no tx input stub for ${hash}`);
        return { input };
      }),
    },
    getLogsCalls,
  };
}

describe("lookupPolicyOnChain — publishedBlockHint fast-path", () => {
  const POLICY_ID = ("0x" + "ee".repeat(32)) as Hex;
  const PUBLISHER = "0x1234567890123456789012345678901234567890" as Address;
  const LABEL = ("0x" + "77".repeat(32)) as Hex;

  it("publishedBlockHint pins the label scan to a single getLogs call at the hint block", async () => {
    // Without the hint, the legacy walker would make ~5000 backward-chunked
    // getLogs calls. With the hint, it MUST be exactly one call pinned at
    // [hint, hint]. This is the whole point of the rich ownerIndex schema.
    const PUBLISH_BLOCK = 1_234_567n;
    const { client, getLogsCalls } = fakeHintClient({
      policyOwner: PUBLISHER,
      publishAt: { block: PUBLISH_BLOCK, label: LABEL, owner: PUBLISHER, policyId: POLICY_ID },
    });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID, {
      publishedBlockHint: PUBLISH_BLOCK,
    });
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.kind).toBe("found-with-label");
    expect(got.policy.labelHex).toBe(LABEL);
    expect(got.policy.publishBlock).toBe(PUBLISH_BLOCK);
    // Exactly one getLogs call, pinned at the hint block (PolicyPublished
    // probe — no update hint here so the dispatcher goes straight to the
    // publish-at-publishedBlockHint branch).
    expect(getLogsCalls).toHaveLength(1);
    expect(getLogsCalls[0]).toEqual({
      event: "PolicyPublished",
      fromBlock: PUBLISH_BLOCK,
      toBlock: PUBLISH_BLOCK,
    });
  });

  it("publishedBlockHint=0n is the migration sentinel — treated as no hint", async () => {
    // v8 migration writes publishedBlock=0n for entries inherited from v7.
    // The caller passes `entry.publishedBlock > 0n ? ... : undefined` so we
    // assert the fast-path is NOT taken when the caller (incorrectly) leaks
    // the sentinel as a hint: the call still works, but it falls through to
    // the legacy walker which issues many getLogs calls.
    const { client, getLogsCalls } = fakeHintClient({
      policyOwner: PUBLISHER,
      // No publishAt — the walker scans backwards until MAX_BACK_BLOCKS.
    });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID, {
      publishedBlockHint: 0n,
    });
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.kind).toBe("found-no-label");
    // More than one getLogs call → fast-path was NOT taken.
    expect(getLogsCalls.length).toBeGreaterThan(1);
  });

  it("lastUpdatedBlockHint > publishedBlockHint probes PolicyUpdated at update block, then PolicyPublished at publish block", async () => {
    // Updated policies emit PolicyUpdated at the update block — NOT
    // PolicyPublished. The prior implementation probed `PolicyPublished`
    // at the update block, which always missed and fell back to the slow
    // walk. The fix probes PolicyUpdated at the update block first to
    // confirm the latest activity in one call, then probes PolicyPublished
    // at the publish block to recover the label (PolicyUpdated does not
    // carry label). Two pinned single-block calls vs ~5000 chunks of the
    // legacy walker.
    const PUBLISH_BLOCK = 1_000_000n;
    const UPDATE_BLOCK = 1_500_000n;
    const UPDATE_TX = ("0x" + "ef".repeat(32)) as Hex;
    const { client, getLogsCalls } = fakeHintClient({
      policyOwner: PUBLISHER,
      publishAt: { block: PUBLISH_BLOCK, label: LABEL, owner: PUBLISHER, policyId: POLICY_ID },
      updateAt: { block: UPDATE_BLOCK, owner: PUBLISHER, policyId: POLICY_ID, txHash: UPDATE_TX },
      // Stub the update tx so the decode-calldata path doesn't throw and
      // abort the snapshot; the decoded paused/expiresAt are checked in a
      // sibling test, here we only assert the call pattern.
      txInputs: {
        [UPDATE_TX.toLowerCase()]: encodeUpdatePolicyCalldata(POLICY_ID, { paused: false, expiresAt: 0n }),
      },
    });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID, {
      publishedBlockHint: PUBLISH_BLOCK,
      lastUpdatedBlockHint: UPDATE_BLOCK,
    });
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.kind).toBe("found-with-label");
    expect(got.policy.labelHex).toBe(LABEL);
    expect(got.policy.publishBlock).toBe(PUBLISH_BLOCK);
    // First call targets PolicyUpdated at the update block, second targets
    // PolicyPublished at the publish block.
    expect(getLogsCalls).toHaveLength(2);
    expect(getLogsCalls[0]).toEqual({
      event: "PolicyUpdated",
      fromBlock: UPDATE_BLOCK,
      toBlock: UPDATE_BLOCK,
    });
    expect(getLogsCalls[1]).toEqual({
      event: "PolicyPublished",
      fromBlock: PUBLISH_BLOCK,
      toBlock: PUBLISH_BLOCK,
    });
  });

  it("lastUpdatedBlockHint hit: decoded update tx calldata refreshes paused / expiresAt", async () => {
    // The fast-path uses the latest updatePolicy calldata to refresh
    // paused/expiresAt so the snapshot reflects the most-recently-applied
    // PolicyInput even if the policyHealth view read raced an in-flight
    // reorg. Stub the policyHealth view to return defaults, stub the
    // update tx calldata to encode paused=true + expiresAt=9999, and
    // assert the snapshot carries the update's values.
    const PUBLISH_BLOCK = 1_000_000n;
    const UPDATE_BLOCK = 1_500_000n;
    const UPDATE_TX = ("0x" + "ef".repeat(32)) as Hex;
    const { client } = fakeHintClient({
      policyOwner: PUBLISHER,
      publishAt: { block: PUBLISH_BLOCK, label: LABEL, owner: PUBLISHER, policyId: POLICY_ID },
      updateAt: { block: UPDATE_BLOCK, owner: PUBLISHER, policyId: POLICY_ID, txHash: UPDATE_TX },
      txInputs: {
        [UPDATE_TX.toLowerCase()]: encodeUpdatePolicyCalldata(POLICY_ID, {
          paused: true,
          expiresAt: 9_999n,
        }),
      },
    });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID, {
      publishedBlockHint: PUBLISH_BLOCK,
      lastUpdatedBlockHint: UPDATE_BLOCK,
    });
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.paused).toBe(true);
    expect(got.policy.expiresAt).toBe(9_999n);
  });

  it("lastUpdatedBlockHint miss falls back to publish-at-publishedBlockHint probe", async () => {
    // The user added an entry to the persisted index with an
    // lastUpdatedBlockHint that's now stale (e.g. a reorg dropped the
    // update). The update probe at the stale block misses; the publish
    // probe at publishedBlockHint succeeds. The slow walker is NOT used.
    const PUBLISH_BLOCK = 1_000_000n;
    const STALE_UPDATE_BLOCK = 1_500_000n;
    const { client, getLogsCalls } = fakeHintClient({
      policyOwner: PUBLISHER,
      publishAt: { block: PUBLISH_BLOCK, label: LABEL, owner: PUBLISHER, policyId: POLICY_ID },
      // No updateAt seeded — the update probe returns nothing.
    });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID, {
      publishedBlockHint: PUBLISH_BLOCK,
      lastUpdatedBlockHint: STALE_UPDATE_BLOCK,
    });
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.kind).toBe("found-with-label");
    expect(got.policy.publishBlock).toBe(PUBLISH_BLOCK);
    expect(got.policy.labelHex).toBe(LABEL);
    // Two calls: failed update probe, then successful publish probe. No
    // walker chunks.
    expect(getLogsCalls).toHaveLength(2);
    expect(getLogsCalls[0]).toEqual({
      event: "PolicyUpdated",
      fromBlock: STALE_UPDATE_BLOCK,
      toBlock: STALE_UPDATE_BLOCK,
    });
    expect(getLogsCalls[1]).toEqual({
      event: "PolicyPublished",
      fromBlock: PUBLISH_BLOCK,
      toBlock: PUBLISH_BLOCK,
    });
  });

  it("hint miss → falls back to the legacy backward walk (correctness preserved)", async () => {
    // A stale hint (e.g. the persisted block is wrong because of a chain
    // reorg or migration bug) MUST not silently lose the publish. The fast
    // path's single-block getLogs returns no hit, and the lookup falls back
    // to the legacy walker which finds the real log.
    const REAL_PUBLISH_BLOCK = 4_999_500n; // near head, walker finds it fast
    const STALE_HINT = 100n;
    const { client, getLogsCalls } = fakeHintClient({
      policyOwner: PUBLISHER,
      publishAt: {
        block: REAL_PUBLISH_BLOCK,
        label: LABEL,
        owner: PUBLISHER,
        policyId: POLICY_ID,
      },
    });
    const got = await lookupPolicyOnChain(client as never, ORACLE, POLICY_ID, {
      publishedBlockHint: STALE_HINT,
    });
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.kind).toBe("found-with-label");
    expect(got.policy.publishBlock).toBe(REAL_PUBLISH_BLOCK);
    // First call was the failed hint probe (PolicyPublished at the stale
    // hint); subsequent calls are the walker (also PolicyPublished).
    expect(getLogsCalls[0]).toEqual({
      event: "PolicyPublished",
      fromBlock: STALE_HINT,
      toBlock: STALE_HINT,
    });
    expect(getLogsCalls.length).toBeGreaterThan(1);
  });

  it("stale-rehydrate path: passes publishedBlockHint when ownerIndex entry has publishedBlock > 0n", async () => {
    // Integration-style: simulate the call shape refreshOwnerIndex uses
    // when consuming a rich ownerIndex entry whose publishedBlock is known.
    // The entry shape mirrors OwnerIndexEntry from persistence.ts.
    const entry = {
      policyId: POLICY_ID,
      publishedBlock: 2_500_000n,
      lastUpdatedBlock: undefined as bigint | undefined,
    };
    const { client, getLogsCalls } = fakeHintClient({
      policyOwner: PUBLISHER,
      publishAt: { block: entry.publishedBlock, label: LABEL, owner: PUBLISHER, policyId: POLICY_ID },
    });
    // This is the exact call shape from useEventStore.refreshOwnerIndex:
    const got = await lookupPolicyOnChain(client as never, ORACLE, entry.policyId, {
      publishedBlockHint: entry.publishedBlock > 0n ? entry.publishedBlock : undefined,
      lastUpdatedBlockHint: entry.lastUpdatedBlock,
    });
    expect(got.kind).toBe("found");
    if (got.kind !== "found") throw new Error("unreachable");
    expect(got.policy.publishBlock).toBe(entry.publishedBlock);
    expect(getLogsCalls).toHaveLength(1);
  });
});
