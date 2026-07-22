import { describe, it, expect, vi } from "vitest";
import type { Address, Hex, Log, PublicClient } from "viem";
import {
  chunkOwnerScanRange,
  computeEmptyBatchCursor,
  fetchAgentEventsViaRpc,
  fetchNewTxsViaRpc,
  fetchPolicyInput,
} from "../../src/hooks/useAgentWatcher";

// chunkOwnerScanRange paginates a (floor..head) block window into
// Shannon-safe getLogs requests. Shannon's RPC caps eth_getLogs at 1000
// blocks per call (see sdk/src/event-store.ts:247), so each emitted
// {fromBlock, toBlock} must span <= 1000 blocks INCLUSIVE.
//
// The chunker is the load-bearing piece of the 7-day fallback scan in
// useAgentWatcher.fetchPolicyInput — the rest of that function is glue
// around viem.getLogs + decodeFunctionData, which is hard to unit-test
// without spinning up a real RPC mock harness. These tests pin the
// chunker shape so a regression (e.g. off-by-one pushing past 1000)
// would surface here instead of as a silent prod failure.

describe("chunkOwnerScanRange", () => {
  it("returns a single chunk when head - floor <= chunkSize", () => {
    const out = chunkOwnerScanRange(1000n, 500n);
    expect(out).toEqual([{ fromBlock: 500n, toBlock: 1000n }]);
  });

  it("returns a single chunk when the gap exactly matches chunkSize", () => {
    // chunkSize=999 means a single chunk covers up to 1000 blocks
    // inclusive (toBlock - fromBlock = 999 → 1000 blocks counted both ends).
    const out = chunkOwnerScanRange(1999n, 1000n);
    expect(out).toEqual([{ fromBlock: 1000n, toBlock: 1999n }]);
    expect(out[0]!.toBlock - out[0]!.fromBlock).toBe(999n);
  });

  it("walks backwards in 999-block chunks, never spanning more than 1000 blocks", () => {
    // head=10_000, floor=0 → ~10 chunks. Verify each chunk is Shannon-safe.
    const out = chunkOwnerScanRange(10_000n, 0n);
    // First chunk should be the newest end.
    expect(out[0]!.toBlock).toBe(10_000n);
    // Last chunk should reach the floor.
    expect(out[out.length - 1]!.fromBlock).toBe(0n);
    // Chunks should be contiguous (no gaps, no overlap) and Shannon-safe.
    for (let i = 0; i < out.length; i++) {
      const span = out[i]!.toBlock - out[i]!.fromBlock;
      expect(span).toBeLessThanOrEqual(999n);
      if (i > 0) {
        // Walking backwards: prev.fromBlock - 1 === current.toBlock
        expect(out[i - 1]!.fromBlock - 1n).toBe(out[i]!.toBlock);
      }
    }
  });

  it("clamps the final chunk at floor instead of going negative", () => {
    // head=500, floor=0, chunkSize=999 → one chunk that stops at 0.
    const out = chunkOwnerScanRange(500n, 0n);
    expect(out).toEqual([{ fromBlock: 0n, toBlock: 500n }]);
  });

  it("respects a non-zero floor (7-day window pattern)", () => {
    // Simulates the production call: head=head, floor=head - 7d.
    const head = 1_000_000n;
    const sevenDayBlocks = 604_800n; // matches the constant in useAgentWatcher
    const floor = head - sevenDayBlocks;
    const out = chunkOwnerScanRange(head, floor);

    // No chunk should drop below the floor.
    for (const c of out) {
      expect(c.fromBlock).toBeGreaterThanOrEqual(floor);
      expect(c.toBlock).toBeLessThanOrEqual(head);
    }
    // The walk must cover the full window — first chunk ends at head,
    // last chunk starts at floor.
    expect(out[0]!.toBlock).toBe(head);
    expect(out[out.length - 1]!.fromBlock).toBe(floor);
  });

  it("returns an empty list when head < floor (degenerate input)", () => {
    expect(chunkOwnerScanRange(100n, 200n)).toEqual([]);
  });

  it("returns a single zero-width chunk when head === floor", () => {
    expect(chunkOwnerScanRange(42n, 42n)).toEqual([
      { fromBlock: 42n, toBlock: 42n },
    ]);
  });

  it("accepts a custom chunkSize for callers with different RPC caps", () => {
    const out = chunkOwnerScanRange(2000n, 0n, 500n);
    // Each chunk should span <= 500 blocks (chunkSize is the gap).
    for (const c of out) {
      expect(c.toBlock - c.fromBlock).toBeLessThanOrEqual(500n);
    }
    expect(out[0]!.toBlock).toBe(2000n);
    expect(out[out.length - 1]!.fromBlock).toBe(0n);
  });

  it("throws on non-positive chunkSize (guard against infinite loop)", () => {
    expect(() => chunkOwnerScanRange(100n, 0n, 0n)).toThrow(/positive/);
    expect(() => chunkOwnerScanRange(100n, 0n, -5n)).toThrow(/positive/);
  });
});

// fetchAgentEventsViaRpc is the RPC-first replacement for the Blockscout
// txlist endpoint that the watch flow relied on. Shannon Blockscout was
// lagging the chain head by ~4.3M blocks (~5 days) so txlist returned
// "no transactions" for verified contracts with recent activity — making
// the watcher structurally broken. The new helper reads logs straight from
// the RPC node, which is realtime.
describe("fetchAgentEventsViaRpc", () => {
  const AGENT = "0xCcCC000000000000000000000000000000000001" as Address;

  function fakeLog(txHash: string, blockNumber: bigint): Log {
    return {
      address: AGENT,
      topics: [],
      data: "0x",
      blockNumber,
      transactionHash: txHash,
      transactionIndex: 0,
      logIndex: 0,
      blockHash: "0x0",
      removed: false,
    } as unknown as Log;
  }

  it("returns a single chunk's logs when range <= chunkSize", async () => {
    const getLogs = vi.fn(async () => [fakeLog("0xa1", 950n)]);
    const client = { getLogs } as unknown as PublicClient;
    const out = await fetchAgentEventsViaRpc(
      client,
      AGENT,
      500n,
      1000n,
      new AbortController().signal,
    );
    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs).toHaveBeenCalledWith({
      address: AGENT,
      fromBlock: 500n,
      toBlock: 1000n,
    });
    expect(out).toHaveLength(1);
  });

  it("chunks a range > 1000 blocks into Shannon-safe windows", async () => {
    // 3000-block span → 4 chunks of ≤1000 blocks each (chunkSize=999 means
    // each chunk covers at most 1000 blocks inclusive).
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const getLogs = vi.fn(async (args: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
      return [];
    });
    const client = { getLogs } as unknown as PublicClient;
    await fetchAgentEventsViaRpc(
      client,
      AGENT,
      0n,
      3000n,
      new AbortController().signal,
    );
    // Every chunk must stay strictly under the 1000-block RPC cap.
    for (const c of calls) {
      expect(c.toBlock - c.fromBlock).toBeLessThanOrEqual(999n);
    }
    // Chunks should be contiguous and cover the full range.
    expect(calls[0]!.fromBlock).toBe(0n);
    expect(calls[calls.length - 1]!.toBlock).toBe(3000n);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.fromBlock).toBe(calls[i - 1]!.toBlock + 1n);
    }
  });

  it("returns the union of logs across chunks", async () => {
    // Two chunks each return one log; the union should preserve both.
    let call = 0;
    const getLogs = vi.fn(async () => {
      call += 1;
      return [fakeLog(`0xchunk${call}`, BigInt(call * 100))];
    });
    const client = { getLogs } as unknown as PublicClient;
    const out = await fetchAgentEventsViaRpc(
      client,
      AGENT,
      0n,
      1500n,
      new AbortController().signal,
    );
    expect(out).toHaveLength(2);
    const hashes = out.map((l) => l.transactionHash);
    expect(hashes).toContain("0xchunk1");
    expect(hashes).toContain("0xchunk2");
  });

  it("returns [] when toBlock < fromBlock (degenerate input)", async () => {
    const getLogs = vi.fn(async () => []);
    const client = { getLogs } as unknown as PublicClient;
    const out = await fetchAgentEventsViaRpc(
      client,
      AGENT,
      500n,
      100n,
      new AbortController().signal,
    );
    expect(getLogs).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("propagates AbortSignal — throws before issuing further chunk requests", async () => {
    const controller = new AbortController();
    const getLogs = vi.fn(async () => {
      // Abort after the first chunk returns so the second chunk's pre-check
      // observes the aborted signal.
      controller.abort();
      return [];
    });
    const client = { getLogs } as unknown as PublicClient;
    // 3000-block span → 4 chunks. After the first one returns we abort,
    // so the second chunk's loop iteration should throw before invoking
    // getLogs again.
    await expect(
      fetchAgentEventsViaRpc(client, AGENT, 0n, 3000n, controller.signal),
    ).rejects.toThrow(/abort/i);
    // First chunk did fire; subsequent chunks did not.
    expect(getLogs).toHaveBeenCalledTimes(1);
  });
});

// fetchNewTxsViaRpc is the per-agent RPC-first replacement for the
// Blockscout txlist fetch in pollOne. It deduplicates logs by txHash,
// then resolves each hash to an ExplorerTx via getTransaction. viem's
// getTransaction can RESOLVE to null (separate from throwing) when a
// hash is pruned/unknown — the resolver must skip such records rather
// than dereference `tx.blockNumber`.
describe("fetchNewTxsViaRpc", () => {
  const AGENT = "0xCcCC000000000000000000000000000000000001" as Address;

  function fakeLog(txHash: string, blockNumber: bigint): Log {
    return {
      address: AGENT,
      topics: [],
      data: "0x",
      blockNumber,
      transactionHash: txHash,
      transactionIndex: 0,
      logIndex: 0,
      blockHash: "0x0",
      removed: false,
    } as unknown as Log;
  }

  it("skips a null-returning getTransaction without throwing", async () => {
    // Two tx hashes in the logs: 0xa1 resolves to null (pruned/racy),
    // 0xa2 resolves normally. The resolver must skip 0xa1 silently and
    // still emit 0xa2 — dereferencing `null.blockNumber` would crash
    // the entire poll batch.
    const getLogs = vi.fn(async () => [
      fakeLog("0xa1", 940n),
      fakeLog("0xa2", 950n),
    ]);
    const getTransaction = vi.fn(async ({ hash }: { hash: string }) => {
      if (hash.toLowerCase() === "0xa1") return null;
      return { hash: "0xa2", from: "0xuser", to: AGENT, blockNumber: 950n };
    });
    const client = {
      getLogs,
      getTransaction,
    } as unknown as PublicClient;
    const out = await fetchNewTxsViaRpc(
      client,
      AGENT,
      500n,
      1000n,
      new Map(),
      new AbortController().signal,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.hash).toBe("0xa2");
    expect(out[0]!.blockNumber).toBe("950");
  });

  it("skips a pending tx (blockNumber=null) without throwing", async () => {
    // A pending tx has blockNumber === null. The resolver must skip it
    // — including it would push a "0" blockNumber into the cache and
    // confuse the cursor-advancement math downstream.
    const getLogs = vi.fn(async () => [fakeLog("0xpend", 950n)]);
    const getTransaction = vi.fn(async () => ({
      hash: "0xpend",
      from: "0xuser",
      to: AGENT,
      blockNumber: null,
    }));
    const client = {
      getLogs,
      getTransaction,
    } as unknown as PublicClient;
    const out = await fetchNewTxsViaRpc(
      client,
      AGENT,
      500n,
      1000n,
      new Map(),
      new AbortController().signal,
    );
    expect(out).toEqual([]);
  });
});

// computeEmptyBatchCursor pins the "advance vs hold" decision for the
// empty-batch poll path. Shannon's Blockscout lags the RPC node by ~5
// days, so when an agent is idle BOTH the RPC log fetch and the explorer
// fallback come back empty every poll. Without the right advancement
// rule the cursor stays put forever and the same range is re-scanned
// each cycle, growing unboundedly.
//
// The matrix the helper encodes:
// - RPC ok, explorer not tried (RPC produced events but newTxs filtered all out) → advance.
// - RPC ok, explorer ok (both empty)                                              → advance.
// - RPC ok, explorer threw (event-less txs may exist that we'd miss)              → hold.
// - RPC failed, explorer ok                                                       → advance via explorer.
// - both failed (we'd actually return earlier in pollOne, but defense)            → hold.
describe("computeEmptyBatchCursor", () => {
  it("advances to head when RPC succeeded and explorer was not attempted", () => {
    const out = computeEmptyBatchCursor({
      lastChecked: 100n,
      head: 1000n,
      maxSeenBlock: 100n,
      rpcSucceeded: true,
      explorerAttempted: false,
      explorerSucceeded: false,
    });
    expect(out).toBe(1000n);
  });

  it("advances to head when BOTH RPC and explorer succeeded but returned empty", () => {
    // The Shannon-idle case: RPC ok with 0 logs → fallback explorer ok
    // with 0 txs → still advance so the next poll starts past `head`.
    const out = computeEmptyBatchCursor({
      lastChecked: 100n,
      head: 1000n,
      maxSeenBlock: 100n,
      rpcSucceeded: true,
      explorerAttempted: true,
      explorerSucceeded: true,
    });
    expect(out).toBe(1000n);
  });

  it("holds the cursor when RPC succeeded but the explorer fallback errored", () => {
    // RPC found 0 events → fallback explorer attempted → explorer threw.
    // The explorer might have caught event-less txs we'd otherwise miss,
    // so we conservatively hold the cursor and retry next poll.
    const out = computeEmptyBatchCursor({
      lastChecked: 100n,
      head: 1000n,
      maxSeenBlock: 100n,
      rpcSucceeded: true,
      explorerAttempted: true,
      explorerSucceeded: false,
    });
    expect(out).toBe(100n);
  });

  it("advances via explorer when RPC failed but explorer succeeded", () => {
    const out = computeEmptyBatchCursor({
      lastChecked: 100n,
      head: 1000n,
      maxSeenBlock: 100n,
      rpcSucceeded: false,
      explorerAttempted: true,
      explorerSucceeded: true,
    });
    expect(out).toBe(1000n);
  });

  it("holds the cursor when both paths errored (defensive — pollOne returns earlier)", () => {
    const out = computeEmptyBatchCursor({
      lastChecked: 100n,
      head: 1000n,
      maxSeenBlock: 100n,
      rpcSucceeded: false,
      explorerAttempted: true,
      explorerSucceeded: false,
    });
    expect(out).toBe(100n);
  });

  it("never moves the cursor backwards", () => {
    // Pathological input: head < lastChecked (shouldn't happen in prod
    // but defend against a chain reorg / RPC mis-report). The helper
    // must not return a value less than lastChecked.
    const out = computeEmptyBatchCursor({
      lastChecked: 5000n,
      head: 1000n,
      maxSeenBlock: 100n,
      rpcSucceeded: true,
      explorerAttempted: false,
      explorerSucceeded: false,
    });
    expect(out).toBe(5000n);
  });

  it("prefers maxSeenBlock over head when maxSeenBlock is higher (cap protection)", () => {
    // If a tx report shows a block past `head` (mock skew or eventual
    // consistency), favour the observed block over the stale head.
    const out = computeEmptyBatchCursor({
      lastChecked: 100n,
      head: 500n,
      maxSeenBlock: 800n,
      rpcSucceeded: true,
      explorerAttempted: false,
      explorerSucceeded: false,
    });
    expect(out).toBe(800n);
  });
});

// fetchPolicyInput is the 7-day-fallback policy reconstructor that scans
// PolicyPublished/PolicyUpdated logs and decodes the originating tx's
// calldata. The tx fetch path uses viem's `getTransaction`, which can
// RESOLVE to null (separate from throwing) when the hash is pruned or
// the RPC has racy state. The decoder must treat that null-resolve the
// same as a throw — return null — rather than dereferencing `tx.input`
// and crashing the watcher's poll loop.
describe("fetchPolicyInput null-tx guard", () => {
  const ORACLE = "0xCcCC000000000000000000000000000000000099" as Address;
  const POLICY_ID =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

  function publishedLog(txHash: string, blockNumber: bigint): Log {
    // Topic0 is the PolicyPublished event signature hash; the watcher's
    // getLogs call is `event`-filtered so the mock just needs the topic
    // count + transactionHash/blockNumber fields to pass the sort.
    return {
      address: ORACLE,
      topics: [
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      ],
      data: "0x",
      blockNumber,
      transactionHash: txHash,
      transactionIndex: 0,
      logIndex: 0,
      blockHash: "0xfeed",
      removed: false,
    } as unknown as Log;
  }

  it("returns null when getTransaction RESOLVES to null instead of throwing", async () => {
    // The fallback scan finds a PolicyPublished hit, but the tx fetch for
    // that hash resolves to null (pruned/racy RPC). Pre-fix, `tx.input`
    // would throw "Cannot read properties of null" and bubble all the way
    // out of pollOne; post-fix the function must return null cleanly.
    const getBlockNumber = vi.fn(async () => 1000n);
    const getLogs = vi.fn(
      async (args: { event: { name?: string } | undefined }) => {
        if (args.event?.name === "PolicyPublished") {
          return [publishedLog("0xdeadbeef", 950n)];
        }
        return [];
      },
    );
    const getTransaction = vi.fn(async () => null);
    const client = {
      getBlockNumber,
      getLogs,
      getTransaction,
    } as unknown as PublicClient;

    const out = await fetchPolicyInput(client, ORACLE, POLICY_ID);
    expect(out).toBeNull();
    expect(getTransaction).toHaveBeenCalledWith({ hash: "0xdeadbeef" });
  });

  it("returns null when getTransaction resolves with a missing `input` field", async () => {
    // Some non-standard txs (e.g. system / synthetic) come back without
    // an `input` field. The decoder would throw on `data: undefined`, so
    // the guard must treat null/undefined input the same as a null tx.
    const getBlockNumber = vi.fn(async () => 1000n);
    const getLogs = vi.fn(
      async (args: { event: { name?: string } | undefined }) => {
        if (args.event?.name === "PolicyPublished") {
          return [publishedLog("0xfeedface", 950n)];
        }
        return [];
      },
    );
    const getTransaction = vi.fn(async () => ({
      hash: "0xfeedface",
      from: "0xuser",
      to: ORACLE,
      blockNumber: 950n,
      input: null,
    }));
    const client = {
      getBlockNumber,
      getLogs,
      getTransaction,
    } as unknown as PublicClient;

    const out = await fetchPolicyInput(client, ORACLE, POLICY_ID);
    expect(out).toBeNull();
  });
});
