import { describe, it, expect, vi } from "vitest";
import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { WARD_ORACLE_ABI, type PolicyInput } from "@ward/sdk";

import {
  recoverPolicyInputFromChain,
  recoverPolicyInputFromChainDeduped,
} from "../../src/lib/policyRecovery";

const ORACLE = "0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf" as Address;
const POLICY_ID = ("0x" + "ab".repeat(32)) as Hex;
// Lowercase addresses bypass viem's checksum validation in encodeFunctionData
// without us having to compute correct mixed-case checksums in the test.
const TARGET = "0x000000000000000000000000000000000000b0b0" as Address;

const FROM_BLOCK = 1_000n;

/** A non-trivial PolicyInput that round-trips through encode/decode with real
 *  bigints and a populated target so a regression in field ordering or
 *  bigint preservation would surface immediately. */
function samplePolicyInput(): PolicyInput {
  return {
    targets: [
      {
        target: TARGET,
        selectors: [
          {
            selector: "0xa9059cbb" as Hex,
            valueCapPerCall: 1_000_000_000_000_000_000n,
            tier: 1,
            delaySeconds: 60,
          },
        ],
      },
    ],
    dailySpendWeiCap: 5_000_000_000_000_000_000n,
    maxSlippageBps: 50,
    expiresAt: 9_999_999_999n,
    paused: false,
  };
}

interface FakeLog {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  eventName: "PolicyPublished" | "PolicyUpdated";
}

interface FakeTx {
  hash: Hex;
  input: Hex;
}

/**
 * Minimal `PublicClient` stand-in. Only `getBlockNumber`, `getLogs`, and
 * `getTransaction` are exercised by `recoverPolicyInputFromChain`; everything
 * else is left as `undefined` and the function signature is cast to
 * `PublicClient` at the call site.
 */
function makeClient(opts: {
  head: bigint;
  logs: FakeLog[];
  txs: Map<Hex, FakeTx>;
  /** Throw on `getLogs` calls whose `toBlock` matches any value here, to
   *  exercise the RPC-blip fall-through path. */
  failGetLogsAt?: bigint[];
}): {
  client: PublicClient;
  calls: { fromBlock: bigint; toBlock: bigint; event: string }[];
} {
  const calls: { fromBlock: bigint; toBlock: bigint; event: string }[] = [];
  const client = {
    getBlockNumber: vi.fn(async () => opts.head),
    getLogs: vi.fn(async (args: {
      fromBlock: bigint;
      toBlock: bigint;
      event: { name: string };
    }) => {
      calls.push({
        fromBlock: args.fromBlock,
        toBlock: args.toBlock,
        event: args.event.name,
      });
      if (opts.failGetLogsAt?.some((b) => b === args.toBlock)) {
        throw new Error("rpc blip");
      }
      return opts.logs.filter(
        (l) =>
          l.eventName === args.event.name &&
          l.blockNumber >= args.fromBlock &&
          l.blockNumber <= args.toBlock,
      );
    }),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const tx = opts.txs.get(hash);
      if (!tx) throw new Error(`unknown tx ${hash}`);
      return tx;
    }),
  };
  return { client: client as unknown as PublicClient, calls };
}

function buildUpdateTx(hash: Hex, input: PolicyInput): FakeTx {
  return {
    hash,
    input: encodeFunctionData({
      abi: WARD_ORACLE_ABI,
      functionName: "updatePolicy",
      args: [POLICY_ID, input],
    }),
  };
}

function buildPublishTx(hash: Hex, input: PolicyInput): FakeTx {
  return {
    hash,
    input: encodeFunctionData({
      abi: WARD_ORACLE_ABI,
      functionName: "publishPolicy",
      // The label is bytes32 — any 32-byte value works for the decode round-trip.
      args: [
        "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
        input,
      ],
    }),
  };
}

describe("recoverPolicyInputFromChain", () => {
  it("happy path — decodes the policy input from an updatePolicy tx", async () => {
    const input = samplePolicyInput();
    const txHash = ("0x" + "01".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([[txHash, buildUpdateTx(txHash, input)]]);
    const { client } = makeClient({
      head: 2_000n,
      logs: [
        {
          blockNumber: 1_800n,
          logIndex: 0,
          transactionHash: txHash,
          eventName: "PolicyUpdated",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: FROM_BLOCK,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("updatePolicy");
    expect(got?.txHash).toBe(txHash);
    expect(got?.blockNumber).toBe(1_800n);
    // Deep-equal the recovered struct, including bigint fields — viem
    // returns bigints for uint64/uint256, mirroring the publish-time shape.
    expect(got?.policyInput.dailySpendWeiCap).toBe(input.dailySpendWeiCap);
    expect(got?.policyInput.expiresAt).toBe(input.expiresAt);
    expect(got?.policyInput.maxSlippageBps).toBe(input.maxSlippageBps);
    expect(got?.policyInput.paused).toBe(input.paused);
    expect(got?.policyInput.targets.length).toBe(1);
    expect(got?.policyInput.targets[0].target.toLowerCase()).toBe(
      TARGET.toLowerCase(),
    );
    expect(got?.policyInput.targets[0].selectors[0].valueCapPerCall).toBe(
      input.targets[0].selectors[0].valueCapPerCall,
    );
  });

  it("decodes a publishPolicy tx (different arg shape than updatePolicy)", async () => {
    const input = samplePolicyInput();
    const txHash = ("0x" + "02".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([[txHash, buildPublishTx(txHash, input)]]);
    const { client } = makeClient({
      head: 500n,
      logs: [
        {
          blockNumber: 200n,
          logIndex: 0,
          transactionHash: txHash,
          eventName: "PolicyPublished",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: 0n,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("publishPolicy");
    expect(got?.policyInput.dailySpendWeiCap).toBe(input.dailySpendWeiCap);
  });

  it("returns null when no publish/update logs are found in the range", async () => {
    const { client, calls } = makeClient({
      head: 2_500n,
      logs: [],
      txs: new Map(),
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: 1_000n,
      // small chunk so the test exercises multiple iterations without
      // having to fabricate millions of blocks
      chunkSize: 500n,
    });

    expect(got).toBeNull();
    // Confirms the chunker actually walked the full range — at least one
    // call should have hit our fromBlock as its lower bound.
    expect(calls.some((c) => c.fromBlock === 1_000n)).toBe(true);
  });

  it("backward walk prefers the NEWEST log when updates live in different chunks", async () => {
    // Two events for the same policyId:
    //   - earlier publish in chunk [1000-1499] (block 1100)
    //   - later update in chunk   [2000-2499] (block 2200)
    // Walking backward from head=2500 with chunkSize=500 should hit the
    // 2000-2499 chunk FIRST and return the update — the older publish is
    // never read because the loop short-circuits on first match.
    const oldInput = samplePolicyInput();
    const newInput: PolicyInput = {
      ...oldInput,
      dailySpendWeiCap: 9_999_999_999_999_999_999n,
    };
    const oldHash = ("0x" + "0a".repeat(32)) as Hex;
    const newHash = ("0x" + "0b".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([
      [oldHash, buildPublishTx(oldHash, oldInput)],
      [newHash, buildUpdateTx(newHash, newInput)],
    ]);
    const { client, calls } = makeClient({
      head: 2_500n,
      logs: [
        {
          blockNumber: 1_100n,
          logIndex: 0,
          transactionHash: oldHash,
          eventName: "PolicyPublished",
        },
        {
          blockNumber: 2_200n,
          logIndex: 0,
          transactionHash: newHash,
          eventName: "PolicyUpdated",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: 1_000n,
      chunkSize: 500n,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("updatePolicy");
    expect(got?.txHash).toBe(newHash);
    expect(got?.blockNumber).toBe(2_200n);
    expect(got?.policyInput.dailySpendWeiCap).toBe(newInput.dailySpendWeiCap);
    // The early-return must mean the older chunk was never queried.
    expect(calls.some((c) => c.fromBlock === 1_000n)).toBe(false);
  });

  it("publishedBlockHint fast-path: probes the hinted block and skips backward walk when no later updates exist", async () => {
    // head is 500k blocks above the publish — without the hint the scanner
    // would chunk back through every one. With the hint it should fire ONE
    // publish probe at the hinted block and ONE update scan over the
    // [hint+1, head] sliver, then return.
    const input = samplePolicyInput();
    const txHash = ("0x" + "11".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([[txHash, buildPublishTx(txHash, input)]]);
    const publishBlock = 1_000n;
    const head = publishBlock; // make the update scan a no-op slice
    const { client, calls } = makeClient({
      head,
      logs: [
        {
          blockNumber: publishBlock,
          logIndex: 0,
          transactionHash: txHash,
          eventName: "PolicyPublished",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: FROM_BLOCK,
      publishedBlockHint: publishBlock,
      chunkSize: 500n,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("publishPolicy");
    expect(got?.blockNumber).toBe(publishBlock);
    // Exactly one publish probe — fast path, no chunked walk because
    // head == publishedBlockHint so the [hint+1, head] window is empty.
    const publishProbes = calls.filter(
      (c) =>
        c.event === "PolicyPublished" &&
        c.fromBlock === publishBlock &&
        c.toBlock === publishBlock,
    );
    expect(publishProbes.length).toBe(1);
    // No backward walk should have happened — the fallback scanRange call
    // would have fromBlock < publishBlock; verify nothing like that exists.
    expect(calls.every((c) => c.fromBlock >= publishBlock)).toBe(true);
  });

  it("publishedBlockHint with updates: scans forward from hint to find the latest update", async () => {
    // Publish at block 1000, update at block 1200, head at 1500. The hint
    // fast-path should find the publish at 1000, then scan [1001, 1500]
    // for updates and return the update (which is more recent).
    const oldInput = samplePolicyInput();
    const newInput: PolicyInput = {
      ...oldInput,
      dailySpendWeiCap: 8_000_000_000_000_000_000n,
    };
    const publishHash = ("0x" + "12".repeat(32)) as Hex;
    const updateHash = ("0x" + "13".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([
      [publishHash, buildPublishTx(publishHash, oldInput)],
      [updateHash, buildUpdateTx(updateHash, newInput)],
    ]);
    const { client } = makeClient({
      head: 1_500n,
      logs: [
        {
          blockNumber: 1_000n,
          logIndex: 0,
          transactionHash: publishHash,
          eventName: "PolicyPublished",
        },
        {
          blockNumber: 1_200n,
          logIndex: 0,
          transactionHash: updateHash,
          eventName: "PolicyUpdated",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: FROM_BLOCK,
      publishedBlockHint: 1_000n,
      chunkSize: 500n,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("updatePolicy");
    expect(got?.txHash).toBe(updateHash);
    expect(got?.blockNumber).toBe(1_200n);
    expect(got?.policyInput.dailySpendWeiCap).toBe(newInput.dailySpendWeiCap);
  });

  it("publishedBlockHint with publish AT hint: forward scan starts at hint+1 (never below hint)", async () => {
    // Healthy hint case: publish at the hinted block, head one chunk away,
    // no updates. The hint short-circuits the backward walk — the only
    // remaining work is a small forward update-scan over [hint+1, head].
    // The scanner must not query anything below the hint when the hint is
    // accurate, because we already know the publish event lives at the hint
    // and everything below it pre-dates the policy.
    const input = samplePolicyInput();
    const txHash = ("0x" + "16".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([[txHash, buildPublishTx(txHash, input)]]);
    const { client, calls } = makeClient({
      head: 1_500n,
      logs: [
        {
          blockNumber: 1_000n,
          logIndex: 0,
          transactionHash: txHash,
          eventName: "PolicyPublished",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: 0n,
      publishedBlockHint: 1_000n,
      chunkSize: 500n,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("publishPolicy");
    // When the hint is accurate (publish AT hint) the floor anchor holds —
    // no scan call should reach below the hint.
    expect(calls.every((c) => c.fromBlock >= 1_000n)).toBe(true);
  });

  it("Promise.all chunk: a single getLogs failure treats the whole chunk as failed and walks back", async () => {
    // Publish exists in chunk [500,999] but the UPDATED-side getLogs in
    // chunk [1000,1499] throws. Pre-fix this would have returned the older
    // publish from [500,999] because the updated-side call in [1000,1499]
    // swallowed its error and pickLatest ran with publish-only data — but
    // that's stale recovery if a real update was being looked for. With
    // Promise.all, the failed chunk is skipped entirely and the scanner
    // walks back to the next chunk, finding the publish there.
    const input = samplePolicyInput();
    const publishHash = ("0x" + "14".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([
      [publishHash, buildPublishTx(publishHash, input)],
    ]);
    const { client, calls } = makeClient({
      head: 1_499n,
      logs: [
        {
          blockNumber: 800n,
          logIndex: 0,
          transactionHash: publishHash,
          eventName: "PolicyPublished",
        },
      ],
      txs,
      // The Updated-side getLogs for the chunk ending at 1499 throws —
      // Promise.all rejects, the whole chunk is treated as failed, and the
      // scanner moves on to [500,999] where the publish lives.
      failGetLogsAt: [1_499n],
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: 0n,
      chunkSize: 500n,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("publishPolicy");
    expect(got?.blockNumber).toBe(800n);
    // The scanner must have moved past the failed [1000,1499] chunk into
    // the older [500,999] one — confirm both chunks were attempted.
    expect(calls.some((c) => c.toBlock === 1_499n)).toBe(true);
    expect(calls.some((c) => c.toBlock === 999n)).toBe(true);
  });

  it("dedupe: two concurrent calls for the same (chainId, oracle, policyId) share one in-flight promise", async () => {
    // We delay the underlying getLogs so the second caller arrives while
    // the first is still in flight, then count how many times getLogs ran.
    // Without dedupe each caller does its own scan (2x calls). With dedupe
    // the second caller awaits the first promise (1x).
    const input = samplePolicyInput();
    const txHash = ("0x" + "15".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([[txHash, buildUpdateTx(txHash, input)]]);
    const { client } = makeClient({
      head: 1_500n,
      logs: [
        {
          blockNumber: 1_400n,
          logIndex: 0,
          transactionHash: txHash,
          eventName: "PolicyUpdated",
        },
      ],
      txs,
    });

    // Wrap the existing getLogs spy with an artificial 10ms delay so both
    // callers are in flight simultaneously.
    const originalGetLogs = client.getLogs as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let getLogsCallCount = 0;
    (client as unknown as { getLogs: (...args: unknown[]) => Promise<unknown> }).getLogs = vi.fn(
      async (...args: unknown[]) => {
        getLogsCallCount += 1;
        await new Promise((r) => setTimeout(r, 10));
        return originalGetLogs(...args);
      },
    );

    const opts = {
      chainId: 1234,
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: FROM_BLOCK,
    };
    const [a, b] = await Promise.all([
      recoverPolicyInputFromChainDeduped(opts),
      recoverPolicyInputFromChainDeduped(opts),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.txHash).toBe(txHash);
    expect(b?.txHash).toBe(txHash);
    // Without dedupe each scan issues 2 getLogs calls (published + updated)
    // for the [1001,1500] chunk — so 4 total across two callers. With dedupe
    // there's exactly one underlying scan: 2 calls.
    expect(getLogsCallCount).toBe(2);

    // After settle, the inflight entry is cleared — a follow-up call must
    // run its own scan (counter increments again).
    const c = await recoverPolicyInputFromChainDeduped(opts);
    expect(c?.txHash).toBe(txHash);
    expect(getLogsCallCount).toBe(4);
  });

  it("lastUpdatedBlockHint === publishedBlockHint fast-path: exactly 1 getLogs call (publish probe), no forward scan", async () => {
    // Both hints equal means the policy was published and never updated.
    // Recovery must collapse to ONE getLogs call (publish probe at the hint).
    // The whole point: head is 1M blocks above publish but we never crawl
    // chunk-by-chunk — that's the trading-v1 hang this fix targets.
    const input = samplePolicyInput();
    const txHash = ("0x" + "20".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([[txHash, buildPublishTx(txHash, input)]]);
    const publishBlock = 397_892_598n;
    const head = publishBlock + 1_000_000n; // mirror the trading-v1 gap
    const { client, calls } = makeClient({
      head,
      logs: [
        {
          blockNumber: publishBlock,
          logIndex: 0,
          transactionHash: txHash,
          eventName: "PolicyPublished",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: FROM_BLOCK,
      publishedBlockHint: publishBlock,
      lastUpdatedBlockHint: publishBlock,
      chunkSize: 500n,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("publishPolicy");
    expect(got?.blockNumber).toBe(publishBlock);
    // Exactly one getLogs call (publish probe at hint). Zero forward scan,
    // zero backward scan. Without the lastUpdatedBlockHint fast-path the
    // forward scan over [publish+1, head] would issue 2 calls per chunk
    // across 1M blocks — that's the hang.
    expect(calls.length).toBe(1);
    expect(calls[0].event).toBe("PolicyPublished");
    expect(calls[0].fromBlock).toBe(publishBlock);
    expect(calls[0].toBlock).toBe(publishBlock);
  });

  it("lastUpdatedBlockHint > publishedBlockHint fast-path: exactly 1 getLogs call (update at hinted block), no forward scan", async () => {
    // Publish at block 1000, last update at block 500000, head at 1M. The
    // update fast-path probes the update event at lastUpdatedBlockHint
    // directly — no chunked walk, no publish probe needed (the latest
    // update is canonical and supersedes the publish).
    const oldInput = samplePolicyInput();
    const newInput: PolicyInput = {
      ...oldInput,
      dailySpendWeiCap: 7_777_777_777_777_777_777n,
    };
    const publishHash = ("0x" + "21".repeat(32)) as Hex;
    const updateHash = ("0x" + "22".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([
      [publishHash, buildPublishTx(publishHash, oldInput)],
      [updateHash, buildUpdateTx(updateHash, newInput)],
    ]);
    const publishBlock = 1_000n;
    const updateBlock = 500_000n;
    const head = 1_000_000n;
    const { client, calls } = makeClient({
      head,
      logs: [
        {
          blockNumber: publishBlock,
          logIndex: 0,
          transactionHash: publishHash,
          eventName: "PolicyPublished",
        },
        {
          blockNumber: updateBlock,
          logIndex: 0,
          transactionHash: updateHash,
          eventName: "PolicyUpdated",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: FROM_BLOCK,
      publishedBlockHint: publishBlock,
      lastUpdatedBlockHint: updateBlock,
      chunkSize: 500n,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("updatePolicy");
    expect(got?.txHash).toBe(updateHash);
    expect(got?.blockNumber).toBe(updateBlock);
    expect(got?.policyInput.dailySpendWeiCap).toBe(newInput.dailySpendWeiCap);
    // Exactly one getLogs call — the update probe at the hinted block.
    expect(calls.length).toBe(1);
    expect(calls[0].event).toBe("PolicyUpdated");
    expect(calls[0].fromBlock).toBe(updateBlock);
    expect(calls[0].toBlock).toBe(updateBlock);
  });

  it("stale lastUpdatedBlockHint falls back to full backward walk from fromBlock (NOT from hint)", async () => {
    // EventStore meta is wrong: lastUpdatedBlockHint points to block 800
    // but the real update lives at block 200 (well below the hint). The
    // probe at block 800 misses, so recovery MUST walk back from head all
    // the way to opts.fromBlock — anchoring the fallback at the hint
    // would let the real event slip below the floor and the function
    // would return null for a policy that exists.
    const input = samplePolicyInput();
    const txHash = ("0x" + "23".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([[txHash, buildUpdateTx(txHash, input)]]);
    const realUpdateBlock = 200n;
    const staleHint = 800n;
    const head = 1_000n;
    const { client, calls } = makeClient({
      head,
      logs: [
        {
          blockNumber: realUpdateBlock,
          logIndex: 0,
          transactionHash: txHash,
          eventName: "PolicyUpdated",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: 100n,
      publishedBlockHint: staleHint,
      lastUpdatedBlockHint: staleHint,
      chunkSize: 250n,
    });

    expect(got).not.toBeNull();
    expect(got?.txHash).toBe(txHash);
    expect(got?.blockNumber).toBe(realUpdateBlock);
    // The fallback walk MUST have reached down to opts.fromBlock (100), not
    // stopped at the stale hint (800). Without this fix the floor would be
    // anchored at 800 and the real event at 200 would be invisible.
    expect(calls.some((c) => c.fromBlock <= realUpdateBlock)).toBe(true);
  });

  it("stale publishedBlockHint-only also falls back to fromBlock walk", async () => {
    // Same shape as the prior test but with only publishedBlockHint
    // supplied (no lastUpdatedBlockHint). The publish probe at the stale
    // hint misses, so the fallback must walk to opts.fromBlock — pre-fix
    // it anchored at the hint and missed the real older publish.
    const input = samplePolicyInput();
    const txHash = ("0x" + "24".repeat(32)) as Hex;
    const txs = new Map<Hex, FakeTx>([[txHash, buildPublishTx(txHash, input)]]);
    const realPublishBlock = 200n;
    const staleHint = 800n;
    const head = 1_000n;
    const { client, calls } = makeClient({
      head,
      logs: [
        {
          blockNumber: realPublishBlock,
          logIndex: 0,
          transactionHash: txHash,
          eventName: "PolicyPublished",
        },
      ],
      txs,
    });

    const got = await recoverPolicyInputFromChain({
      publicClient: client,
      oracleAddress: ORACLE,
      policyId: POLICY_ID,
      fromBlock: 100n,
      publishedBlockHint: staleHint,
      chunkSize: 250n,
    });

    expect(got).not.toBeNull();
    expect(got?.functionName).toBe("publishPolicy");
    expect(got?.txHash).toBe(txHash);
    expect(got?.blockNumber).toBe(realPublishBlock);
    // The fallback must have reached down to opts.fromBlock — confirm at
    // least one scan call started at a block <= the real publish (200).
    expect(calls.some((c) => c.fromBlock <= realPublishBlock)).toBe(true);
  });

  it("throws when calldata can't be decoded (older PolicyInput shape, etc.)", async () => {
    // Tx exists but `input` is a non-ABI-conformant payload — `decodeFunctionData`
    // will throw, which we surface to the caller per the helper's contract.
    const txHash = ("0x" + "0c".repeat(32)) as Hex;
    const malformed: FakeTx = { hash: txHash, input: "0xdeadbeef" as Hex };
    const txs = new Map<Hex, FakeTx>([[txHash, malformed]]);
    const { client } = makeClient({
      head: 500n,
      logs: [
        {
          blockNumber: 200n,
          logIndex: 0,
          transactionHash: txHash,
          eventName: "PolicyUpdated",
        },
      ],
      txs,
    });

    await expect(
      recoverPolicyInputFromChain({
        publicClient: client,
        oracleAddress: ORACLE,
        policyId: POLICY_ID,
        fromBlock: 0n,
      }),
    ).rejects.toThrow();
  });
});
