import { describe, it, expect, vi } from "vitest";
import { createPublicClient, http, type Address } from "viem";
import { createEventStore } from "../src/event-store.js";

/**
 * Unit-level tests for event-store. We don't spin up anvil here — the
 * publicClient is stubbed so we only exercise the store's own logic
 * (state transitions, hydration scheduling, subscriber dispatch, cursor).
 *
 * A separate live-RPC smoke test against Fuji is in `event-store.smoke.test.ts`
 * (vitest.skip by default; run with VITEST_FUJI_SMOKE=1).
 */

const ORACLE: Address = "0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf";
const QUEUE: Address = "0x98A3f7C38D19edF1ddA7E3bc38fa4B935aD590D5";

interface StubLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
}

interface FakeClient {
  getBlockNumber(): Promise<bigint>;
  getContractEvents(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<StubLog[]>;
  readContract(args: { functionName: string; args: readonly unknown[] }): Promise<unknown>;
  watchContractEvent(args: { address: Address; onLogs: (logs: StubLog[]) => void }): () => void;
}

function makeFakeClient(opts: {
  head: bigint;
  oracleLogs: StubLog[];
  queueLogs: StubLog[];
  recordHeaderByExecId?: Map<bigint, unknown>;
}): { client: FakeClient; pushOracle: (l: StubLog) => void; pushQueue: (l: StubLog) => void } {
  const oracleWatchers: Array<(logs: StubLog[]) => void> = [];
  const queueWatchers: Array<(logs: StubLog[]) => void> = [];
  const client: FakeClient = {
    getBlockNumber: async () => opts.head,
    getContractEvents: async ({ address, fromBlock, toBlock }) => {
      const pool = address.toLowerCase() === ORACLE.toLowerCase() ? opts.oracleLogs : opts.queueLogs;
      return pool.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    readContract: async ({ functionName, args }) => {
      if (functionName === "getRecordHeader") {
        const execId = args[0] as bigint;
        const rec = opts.recordHeaderByExecId?.get(execId);
        if (!rec) throw new Error("PolicyNotFound");
        return rec;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    watchContractEvent: ({ address, onLogs }) => {
      const list = address.toLowerCase() === ORACLE.toLowerCase() ? oracleWatchers : queueWatchers;
      list.push(onLogs);
      return () => {
        const i = list.indexOf(onLogs);
        if (i >= 0) list.splice(i, 1);
      };
    },
  };
  return {
    client,
    pushOracle: (l) => oracleWatchers.forEach((w) => w([l])),
    pushQueue: (l) => queueWatchers.forEach((w) => w([l])),
  };
}

function mkHeader(execId: bigint, state: number, policyId: `0x${string}`): unknown {
  return {
    policyId,
    asker: "0x0000000000000000000000000000000000000001",
    enqueuedAt: 0n,
    earliestCommitAt: 0n,
    deadline: 0n,
    tier: 1,
    state,
    target: "0x0000000000000000000000000000000000000002",
    selector: "0x00000000",
    value: 0n,
    requestId: 0n,
  };
}

const POLICY_A = ("0x" + "aa".repeat(32)) as `0x${string}`;
const POLICY_B = ("0x" + "bb".repeat(32)) as `0x${string}`;
const ALICE = "0x000000000000000000000000000000000000A11C" as Address;
const BOB = "0x000000000000000000000000000000000000B0B0" as Address;

describe("event-store", () => {
  it("backfill: PolicyPublished is recorded with label + publishedBlock", async () => {
    const { client } = makeFakeClient({
      head: 1000n,
      oracleLogs: [
        {
          eventName: "PolicyPublished",
          args: { policyId: POLICY_A, owner: ALICE, label: ("0x" + "61".repeat(32)) as `0x${string}` },
          blockNumber: 500n,
          logIndex: 0,
          transactionHash: "0x01",
        },
      ],
      queueLogs: [],
    });
    const store = createEventStore({
      publicClient: client as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 1000n,
    });
    await store.init();
    const policies = store.listPolicies();
    expect(policies).toHaveLength(1);
    expect(policies[0].policyId).toBe(POLICY_A);
    expect(policies[0].owner).toBe(ALICE);
    expect(policies[0].publishedBlock).toBe(500n);
    expect(policies[0].lastUpdatedBlock).toBe(500n);
    store.dispose();
  });

  it("backfill: PolicyUpdated AFTER PolicyPublished preserves the original label + publishedBlock", async () => {
    const { client } = makeFakeClient({
      head: 1000n,
      oracleLogs: [
        {
          eventName: "PolicyPublished",
          args: { policyId: POLICY_A, owner: ALICE, label: ("0x" + "61".repeat(32)) as `0x${string}` },
          blockNumber: 500n,
          logIndex: 0,
          transactionHash: "0x01",
        },
        {
          eventName: "PolicyUpdated",
          args: { policyId: POLICY_A, owner: ALICE },
          blockNumber: 800n,
          logIndex: 0,
          transactionHash: "0x02",
        },
      ],
      queueLogs: [],
    });
    const store = createEventStore({
      publicClient: client as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 1000n,
    });
    await store.init();
    const p = store.getPolicy(POLICY_A);
    expect(p).toBeDefined();
    expect(p!.publishedBlock).toBe(500n);
    expect(p!.lastUpdatedBlock).toBe(800n);
    expect(p!.label).toBeDefined();
    store.dispose();
  });

  it("backfill: queue events hydrate Pending records via getRecordHeader", async () => {
    const headers = new Map<bigint, unknown>();
    headers.set(7n, mkHeader(7n, 1, POLICY_A)); // Pending
    headers.set(8n, mkHeader(8n, 2, POLICY_A)); // Committed
    const { client } = makeFakeClient({
      head: 1000n,
      oracleLogs: [],
      queueLogs: [
        {
          eventName: "Enqueued",
          args: { execId: 7n, policyId: POLICY_A, asker: BOB, tier: 1, earliestCommitAt: 0n, deadline: 0n, calldataHash: "0x00" as `0x${string}` },
          blockNumber: 700n,
          logIndex: 0,
          transactionHash: "0x07",
        },
        {
          eventName: "Enqueued",
          args: { execId: 8n, policyId: POLICY_A, asker: BOB, tier: 2, earliestCommitAt: 0n, deadline: 0n, calldataHash: "0x00" as `0x${string}` },
          blockNumber: 701n,
          logIndex: 0,
          transactionHash: "0x08",
        },
        {
          eventName: "Dispatched",
          args: { execId: 8n, dispatcher: BOB, policyId: POLICY_A, intentHash: "0xab" as `0x${string}` },
          blockNumber: 702n,
          logIndex: 0,
          transactionHash: "0x09",
        },
      ],
      recordHeaderByExecId: headers,
    });
    const store = createEventStore({
      publicClient: client as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 1000n,
    });
    await store.init();
    expect(store.getQueueRecord(7n)).toBeDefined();
    expect(store.getQueueRecord(8n)).toBeDefined();
    expect(store.listPending()).toHaveLength(1);
    expect(store.listPending()[0].policyId).toBe(POLICY_A);

    // listPendingWithExecIds: must surface the queue's primary key (execId)
    // alongside the header. Pending row #7 is the only one in Pending state.
    // Regression guard for an operator-tooling bug where requestId was
    // passed to expireIfStale instead of execId.
    const pendingWithIds = store.listPendingWithExecIds();
    expect(pendingWithIds).toHaveLength(1);
    expect(pendingWithIds[0].execId).toBe(7n);
    expect(pendingWithIds[0].record.policyId).toBe(POLICY_A);
    store.dispose();
  });

  it("live: subscriber receives new PolicyPublished after backfill", async () => {
    const { client, pushOracle } = makeFakeClient({
      head: 100n,
      oracleLogs: [],
      queueLogs: [],
    });
    const store = createEventStore({
      publicClient: client as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 50n,
    });
    await store.init();
    const events: string[] = [];
    store.subscribe((e) => events.push(e.type));
    pushOracle({
      eventName: "PolicyPublished",
      args: { policyId: POLICY_B, owner: BOB, label: ("0x" + "62".repeat(32)) as `0x${string}` },
      blockNumber: 101n,
      logIndex: 0,
      transactionHash: "0x11",
    });
    expect(events).toEqual(["PolicyPublished"]);
    expect(store.getPolicy(POLICY_B)?.owner).toBe(BOB);
    store.dispose();
  });

  it("dispose: unsubscribes and stops calling subscribers", async () => {
    const { client, pushOracle } = makeFakeClient({
      head: 10n,
      oracleLogs: [],
      queueLogs: [],
    });
    const store = createEventStore({
      publicClient: client as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 10n,
    });
    await store.init();
    const handler = vi.fn();
    store.subscribe(handler);
    store.dispose();
    // After dispose, even if we push, the subscribers set was cleared.
    pushOracle({
      eventName: "PolicyPublished",
      args: { policyId: POLICY_A, owner: ALICE },
      blockNumber: 11n,
      logIndex: 0,
      transactionHash: "0x99",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("hydration that resolves AFTER dispose() does not mutate records (CP42 fix)", async () => {
    // Build a client whose getRecordHeader is gated on a manual resolver, so we can
    // dispose the store while a hydration is mid-await and then resolve the RPC.
    let resolveHeader: ((v: unknown) => void) | undefined;
    const headerPromise = new Promise<unknown>((r) => { resolveHeader = r; });
    const fakeClient = {
      getBlockNumber: async () => 100n,
      getContractEvents: async ({ address, fromBlock, toBlock }: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
        if (address.toLowerCase() === QUEUE.toLowerCase()) {
          // Emit one Enqueued log so hydration is triggered.
          return [
            {
              eventName: "Enqueued",
              args: { execId: 99n, policyId: POLICY_A, asker: BOB, tier: 1, earliestCommitAt: 0n, deadline: 0n, calldataHash: "0x00" as `0x${string}` },
              blockNumber: 90n,
              logIndex: 0,
              transactionHash: "0xaa" as `0x${string}`,
            },
          ];
        }
        return [];
      },
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName !== "getRecordHeader") throw new Error("unexpected");
        return await headerPromise;
      },
      watchContractEvent: () => () => {},
    };
    const store = createEventStore({
      publicClient: fakeClient as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 100n,
    });
    // init() races: queue backfill emits → hydrateAll loop starts → first hydrate awaits forever.
    // We dispose without waiting for init to complete.
    const initPromise = store.init().catch(() => {});
    // Give the event loop a tick for backfill to start hydration.
    await new Promise((r) => setTimeout(r, 10));
    store.dispose();
    // Now resolve the RPC's header — this would have mutated queueRecords BEFORE the CP42 fix.
    resolveHeader!(mkHeader(99n, 1, POLICY_A));
    await initPromise;
    // The post-dispose write must not have landed.
    expect(store.getQueueRecord(99n)).toBeUndefined();
  });

  it("recentEvents respects cap + returns chronological order", async () => {
    const oracleLogs: StubLog[] = [];
    for (let i = 0; i < 50; i++) {
      oracleLogs.push({
        eventName: "PolicyPublished",
        args: { policyId: (("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`), owner: ALICE, label: ("0x" + "00".repeat(32)) as `0x${string}` },
        blockNumber: BigInt(i + 1),
        logIndex: 0,
        transactionHash: ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`,
      });
    }
    const { client } = makeFakeClient({ head: 100n, oracleLogs, queueLogs: [] });
    const store = createEventStore({
      publicClient: client as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 100n,
      eventLogCap: 20,
    });
    await store.init();
    const recent = store.recentEvents(100);
    expect(recent.length).toBe(20);
    // First in slice should be the EARLIEST surviving event (index 30 of the originals)
    expect(recent[0].blockNumber).toBe(31n);
    expect(recent[recent.length - 1].blockNumber).toBe(50n);
    store.dispose();
  });

  it("startBlock raises the fromBlock floor for both policy and queue backfills", async () => {
    const calls: Array<{ address: Address; fromBlock: bigint; toBlock: bigint }> = [];
    const fakeClient = {
      getBlockNumber: async () => 10_000n,
      getContractEvents: async (args: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
        calls.push({ address: args.address, fromBlock: args.fromBlock, toBlock: args.toBlock });
        return [] as StubLog[];
      },
      readContract: async () => {
        throw new Error("unexpected");
      },
      watchContractEvent: () => () => {},
    };
    const store = createEventStore({
      publicClient: fakeClient as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      oracleDeploymentBlock: 100n,
      queueLookbackBlocks: 5_000n,
      startBlock: 9_500n,
      chunkSize: 1_000n,
    });
    await store.init();
    const oracleCalls = calls.filter((c) => c.address.toLowerCase() === ORACLE.toLowerCase());
    const queueCalls = calls.filter((c) => c.address.toLowerCase() === QUEUE.toLowerCase());
    // Both policy + queue must start at startBlock (9_500n), not the default floors
    // (oracleDeploymentBlock=100n for policy, head-lookback=5_000n for queue).
    expect(oracleCalls.length).toBeGreaterThan(0);
    expect(queueCalls.length).toBeGreaterThan(0);
    expect(oracleCalls[0].fromBlock).toBe(9_500n);
    expect(queueCalls[0].fromBlock).toBe(9_500n);
    store.dispose();
  });

  it("listPoliciesByOwner filters the in-memory map by owner (case-insensitive)", async () => {
    const { client } = makeFakeClient({
      head: 1000n,
      oracleLogs: [
        {
          eventName: "PolicyPublished",
          args: { policyId: POLICY_A, owner: ALICE, label: ("0x" + "61".repeat(32)) as `0x${string}` },
          blockNumber: 100n,
          logIndex: 0,
          transactionHash: "0xaa",
        },
        {
          eventName: "PolicyPublished",
          args: { policyId: POLICY_B, owner: BOB, label: ("0x" + "62".repeat(32)) as `0x${string}` },
          blockNumber: 200n,
          logIndex: 0,
          transactionHash: "0xbb",
        },
      ],
      queueLogs: [],
    });
    const store = createEventStore({
      publicClient: client as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 1000n,
    });
    await store.init();
    // Case is upper in fixture; the filter should match regardless.
    const aliceUpper = ALICE.toUpperCase() as Address;
    const fromAlice = store.listPoliciesByOwner(aliceUpper);
    expect(fromAlice).toHaveLength(1);
    expect(fromAlice[0].policyId).toBe(POLICY_A);
    const fromBob = store.listPoliciesByOwner(BOB);
    expect(fromBob).toHaveLength(1);
    expect(fromBob[0].policyId).toBe(POLICY_B);
    const fromUnknown = store.listPoliciesByOwner("0x0000000000000000000000000000000000000000" as Address);
    expect(fromUnknown).toHaveLength(0);
    store.dispose();
  });

  it("hydratePolicyAndPersist fires snapshotUpdated even when the policy was already known", async () => {
    const { client } = makeFakeClient({
      head: 100n,
      oracleLogs: [],
      queueLogs: [],
    });
    const store = createEventStore({
      publicClient: client as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 100n,
    });
    await store.init();

    const seen: string[] = [];
    store.subscribe((e) => seen.push(e.type));

    // First hydrate inserts AND fires synthetic.
    store.hydratePolicyAndPersist({
      policyId: POLICY_A,
      owner: ALICE,
      lastUpdatedBlock: 1n,
    });
    // Second hydrate is a no-op insert (first-write-wins) but MUST still fire
    // synthetic so the IDB writer can flush any side state batched by the caller.
    store.hydratePolicyAndPersist({
      policyId: POLICY_A,
      owner: ALICE,
      lastUpdatedBlock: 2n,
    });

    expect(seen).toEqual(["snapshotUpdated", "snapshotUpdated"]);
    // First-write-wins: the lastUpdatedBlock should still be the first one.
    expect(store.getPolicy(POLICY_A)?.lastUpdatedBlock).toBe(1n);
    store.dispose();
  });

  it("emitSnapshotUpdated does NOT append to recentEvents (synthetic is not a chain artifact)", async () => {
    const { client } = makeFakeClient({
      head: 100n,
      oracleLogs: [],
      queueLogs: [],
    });
    const store = createEventStore({
      publicClient: client as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      queueLookbackBlocks: 100n,
    });
    await store.init();
    const beforeLen = store.recentEvents(100).length;
    store.emitSnapshotUpdated();
    store.emitSnapshotUpdated();
    expect(store.recentEvents(100).length).toBe(beforeLen);
    store.dispose();
  });

  it("startBlock below oracleDeploymentBlock is overridden by the deeper deploy block", async () => {
    const calls: Array<{ address: Address; fromBlock: bigint; toBlock: bigint }> = [];
    const fakeClient = {
      getBlockNumber: async () => 10_000n,
      getContractEvents: async (args: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
        calls.push({ address: args.address, fromBlock: args.fromBlock, toBlock: args.toBlock });
        return [] as StubLog[];
      },
      readContract: async () => {
        throw new Error("unexpected");
      },
      watchContractEvent: () => () => {},
    };
    const store = createEventStore({
      publicClient: fakeClient as never,
      oracleAddress: ORACLE,
      queueAddress: QUEUE,
      oracleDeploymentBlock: 8_000n,
      queueLookbackBlocks: 5_000n,
      startBlock: 1_000n, // shallower than deploy block (8_000n) and queue floor (5_000n)
      chunkSize: 1_000n,
    });
    await store.init();
    const oracleCalls = calls.filter((c) => c.address.toLowerCase() === ORACLE.toLowerCase());
    const queueCalls = calls.filter((c) => c.address.toLowerCase() === QUEUE.toLowerCase());
    // Policy floor = MAX(deploy=8_000n, startBlock=1_000n) = 8_000n
    expect(oracleCalls[0].fromBlock).toBe(8_000n);
    // Queue floor = MAX(head-lookback=5_000n, startBlock=1_000n) = 5_000n
    expect(queueCalls[0].fromBlock).toBe(5_000n);
    store.dispose();
  });
});
