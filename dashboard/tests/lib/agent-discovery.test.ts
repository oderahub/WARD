import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Hex, PublicClient, TransactionReceipt } from "viem";
import { discoverAgentCallSurface } from "../../src/lib/agent-discovery";

// Mock whatsabi's OpenChain lookup so tests run offline. We make it always
// return [] so signatures stay undefined — keeps assertions independent of
// network behaviour. Tests that care about signature naming would override
// per-call.
vi.mock("@shazow/whatsabi", () => ({
  loaders: {
    OpenChainSignatureLookup: class {
      async loadFunctions(_selector: string): Promise<string[]> {
        return [];
      }
    },
  },
}));

const AGENT = "0xAAaaaaaaAaAaAAAaaAAaAaaAAAAaAaaAAAaaAaA0" as Hex;
const TARGET_A = "0x1111111111111111111111111111111111111111" as Hex;
const TARGET_B = "0x2222222222222222222222222222222222222222" as Hex;

// 4-byte selectors
const SEL_X = "0xa9059cbb" as Hex; // transfer(address,uint256)
const SEL_Y = "0x23b872dd" as Hex; // transferFrom(address,address,uint256)
// 32-byte event-sig hash (Transfer)
const TOPIC_TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

interface FakeTx {
  hash: string;
  to: string | null;
  from: string;
  blockNumber: string;
}

function txlistResponse(txs: FakeTx[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: "1", message: "OK", result: txs }),
  } as unknown as Response;
}

function makeReceipt(
  hash: string,
  logs: Array<{ address: string; topics: string[] }>,
  block = 100n,
): TransactionReceipt {
  return {
    blockNumber: block,
    transactionHash: hash as Hex,
    logs: logs.map((l) => ({
      address: l.address as Hex,
      topics: l.topics as readonly Hex[],
    })),
  } as unknown as TransactionReceipt;
}

function makeClient(opts: {
  receipts?: Record<string, TransactionReceipt>;
  // Per-hash trace results; if a hash maps to a thrown Error, request rejects.
  traces?: Record<string, unknown | Error>;
  // Default: contract (non-empty bytecode). Pass "0x" to simulate an EOA.
  code?: string;
  // RPC-first path support. When omitted, the RPC path errors and discovery
  // falls back to Blockscout — matching the legacy test behaviour.
  headBlock?: bigint;
  // Logs returned for any getLogs call (chunks are coalesced into a single
  // response for test simplicity).
  rpcLogs?: Array<{ transactionHash: string; blockNumber: bigint }>;
  // Per-hash transactions for the RPC path's getTransaction lookups.
  rpcTxs?: Record<
    string,
    { hash: string; from: string; to: string | null; blockNumber: bigint }
  >;
  // Lowercase hashes whose getTransaction call should resolve to `null`
  // (the racy-pruned/unknown-hash path that viem can hit). Distinct from
  // "not configured" which throws.
  rpcTxsNull?: Set<string>;
}): PublicClient {
  return {
    getCode: vi.fn(async (_args: { address: string }) => {
      return opts.code ?? "0x6080604052";
    }),
    getBlockNumber: vi.fn(async () => {
      if (opts.headBlock === undefined) {
        throw new Error("getBlockNumber not configured");
      }
      return opts.headBlock;
    }),
    getLogs: vi.fn(async () => opts.rpcLogs ?? []),
    getTransaction: vi.fn(async ({ hash }: { hash: string }) => {
      const lower = hash.toLowerCase();
      if (opts.rpcTxsNull?.has(lower)) return null;
      const t = opts.rpcTxs?.[lower];
      if (!t) throw new Error("tx not found");
      return t;
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => {
      const r = opts.receipts?.[hash.toLowerCase()];
      if (!r) throw new Error("not found");
      return r;
    }),
    request: vi.fn(async ({ method, params }: { method: string; params: unknown[] }) => {
      if (method !== "debug_traceTransaction") throw new Error("unexpected rpc");
      const hash = (params[0] as string).toLowerCase();
      const t = opts.traces?.[hash];
      if (t === undefined) throw new Error("method not supported");
      if (t instanceof Error) throw t;
      return t;
    }),
  } as unknown as PublicClient;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discoverAgentCallSurface", () => {
  it("returns empty targets when the agent has no transaction history", async () => {
    fetchMock.mockResolvedValueOnce(txlistResponse([]));
    const client = makeClient({});
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toEqual([]);
    expect(r.txsScanned).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it("flags traceFailed and returns no targets when the RPC rejects debug_traceTransaction", async () => {
    // Previously this code fell back to receipt logs (treating event-sig
    // hashes as function selectors), producing garbage selectors that would
    // mis-tier in policy evaluation. The new contract: no fallback. We
    // surface traceFailed:true and an explanatory warning instead.
    fetchMock.mockResolvedValueOnce(
      txlistResponse([
        { hash: "0xabc", to: AGENT, from: "0xuser", blockNumber: "100" },
      ]),
    );
    const client = makeClient({
      receipts: {
        "0xabc": makeReceipt("0xabc", [
          { address: TARGET_A, topics: [TOPIC_TRANSFER] },
        ]),
      },
      traces: { "0xabc": new Error("method not supported") },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("trace");
    expect(r.traceFailed).toBe(true);
    expect(r.targets).toEqual([]);
    expect(r.txsScanned).toBe(0);
    expect(
      r.warnings.some((w) => /debug_traceTransaction/.test(w)),
    ).toBe(true);
  });

  it("aggregates callCount across multiple txs to the same (target, selector) via trace", async () => {
    fetchMock.mockResolvedValueOnce(
      txlistResponse([
        { hash: "0xa1", to: AGENT, from: "0xu", blockNumber: "100" },
        { hash: "0xa2", to: AGENT, from: "0xu", blockNumber: "110" },
        { hash: "0xa3", to: AGENT, from: "0xu", blockNumber: "120" },
      ]),
    );
    // Three traces: 0xa1/0xa2 each call TARGET_A:SEL_X once; 0xa3 calls
    // TARGET_A:SEL_X plus TARGET_B:SEL_Y. Aggregated, TARGET_A:SEL_X = 3
    // calls and TARGET_B:SEL_Y = 1.
    const frameA = {
      type: "CALL",
      from: AGENT.toLowerCase(),
      to: TARGET_A.toLowerCase(),
      input: SEL_X + "00".repeat(32),
    };
    const frameAB = {
      type: "CALL",
      from: AGENT.toLowerCase(),
      to: TARGET_A.toLowerCase(),
      input: SEL_X + "00".repeat(32),
      calls: [
        {
          type: "CALL",
          from: AGENT.toLowerCase(),
          to: TARGET_B.toLowerCase(),
          input: SEL_Y + "00".repeat(32),
        },
      ],
    };
    const client = makeClient({
      receipts: {
        "0xa1": makeReceipt("0xa1", [], 100n),
        "0xa2": makeReceipt("0xa2", [], 110n),
        "0xa3": makeReceipt("0xa3", [], 120n),
      },
      traces: { "0xa1": frameA, "0xa2": frameA, "0xa3": frameAB },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("trace");
    expect(r.traceFailed).toBe(false);
    expect(r.txsScanned).toBe(3);
    expect(r.targets[0].target).toBe(TARGET_A.toLowerCase());
    expect(r.targets[0].functions[0].callCount).toBe(3);
    expect(r.targets[0].firstSeenBlock).toBe(100n);
    expect(r.targets[0].lastSeenBlock).toBe(120n);
    expect(r.targets[1].target).toBe(TARGET_B.toLowerCase());
    expect(r.targets[1].functions[0].callCount).toBe(1);
  });

  it("uses debug_traceTransaction when available and walks nested call frames", async () => {
    fetchMock.mockResolvedValueOnce(
      txlistResponse([
        { hash: "0xbeef", to: AGENT, from: "0xu", blockNumber: "200" },
      ]),
    );
    // Call tree: top-level call from agent to TARGET_A (SEL_X), nested
    // call from agent to TARGET_B (SEL_Y) via a router. Also one nested
    // call whose `from` is NOT the agent — must be ignored.
    const trace = {
      type: "CALL",
      from: AGENT.toLowerCase(),
      to: TARGET_A.toLowerCase(),
      input: SEL_X + "00".repeat(64),
      calls: [
        {
          type: "CALL",
          from: AGENT.toLowerCase(),
          to: TARGET_B.toLowerCase(),
          input: SEL_Y + "00".repeat(96),
        },
        {
          type: "CALL",
          from: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          to: TARGET_A.toLowerCase(),
          input: SEL_X + "00",
        },
      ],
    };
    const client = makeClient({
      receipts: {
        "0xbeef": makeReceipt("0xbeef", [], 200n),
      },
      traces: { "0xbeef": trace },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("trace");
    // Two distinct targets, neither from the non-agent caller.
    const byTarget = new Map(r.targets.map((t) => [t.target, t]));
    expect(byTarget.get(TARGET_A.toLowerCase())?.functions[0].selector).toBe(SEL_X);
    expect(byTarget.get(TARGET_B.toLowerCase())?.functions[0].selector).toBe(SEL_Y);
    expect(r.warnings).toEqual([]);
  });

  it("returns ok:false when the explorer rate-limits or 404s", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({}),
    } as unknown as Response);
    const client = makeClient({});
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/HTTP 429/);
  });

  it("treats EOA agents as senders (filters from==agent, not to==agent)", async () => {
    // Two txs: one FROM the EOA agent (a user-signed intent), one TO it
    // (some random refund). Only the FROM one should be scanned.
    fetchMock.mockResolvedValueOnce(
      txlistResponse([
        { hash: "0xfrom", to: TARGET_A, from: AGENT, blockNumber: "400" },
        { hash: "0xto", to: AGENT, from: "0xrand", blockNumber: "401" },
      ]),
    );
    const traceFrom = {
      type: "CALL",
      from: AGENT.toLowerCase(),
      to: TARGET_A.toLowerCase(),
      input: SEL_X + "00".repeat(32),
    };
    const client = makeClient({
      code: "0x", // <- EOA
      receipts: {
        "0xfrom": makeReceipt("0xfrom", [], 400n),
        // No receipt for 0xto — if discovery wrongly scanned it, we'd see a
        // skipped-receipt warning.
      },
      traces: { "0xfrom": traceFrom },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agentKind).toBe("eoa");
    expect(r.txsScanned).toBe(1);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].target).toBe(TARGET_A.toLowerCase());
    expect(r.targets[0].functions[0].selector).toBe(SEL_X);
    expect(r.warnings.some((w) => /receipt missing/.test(w))).toBe(false);
  });

  it("treats contract agents as destinations (filters to==agent)", async () => {
    fetchMock.mockResolvedValueOnce(
      txlistResponse([
        { hash: "0xc1", to: AGENT, from: "0xuser", blockNumber: "500" },
        { hash: "0xc2", to: "0xother", from: AGENT, blockNumber: "501" },
      ]),
    );
    const traceC1 = {
      type: "CALL",
      from: AGENT.toLowerCase(),
      to: TARGET_A.toLowerCase(),
      input: SEL_X + "00".repeat(32),
    };
    const client = makeClient({
      code: "0x6080604052348015", // runtime bytecode -> contract
      receipts: { "0xc1": makeReceipt("0xc1", [], 500n) },
      traces: { "0xc1": traceC1 },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agentKind).toBe("contract");
    expect(r.txsScanned).toBe(1);
    expect(r.targets[0].target).toBe(TARGET_A.toLowerCase());
  });

  it("warns when a contract agent looks like a token (maxed txlist + self-emitted Transfer)", async () => {
    // 3 incoming txs, maxTxs=3 (so list is "truncated"), and the agent
    // itself emits a Transfer in one of them — classic ERC-20 fingerprint.
    const txs = Array.from({ length: 3 }, (_, i) => ({
      hash: `0xt${i}`,
      to: AGENT,
      from: "0xuser",
      blockNumber: String(600 + i),
    }));
    fetchMock.mockResolvedValueOnce(txlistResponse(txs));
    const client = makeClient({
      code: "0xfeedface",
      receipts: {
        "0xt0": makeReceipt(
          "0xt0",
          // Agent emits Transfer = looks like a token.
          [{ address: AGENT, topics: [TOPIC_TRANSFER] }],
          600n,
        ),
        "0xt1": makeReceipt(
          "0xt1",
          [{ address: TARGET_A, topics: [TOPIC_TRANSFER] }],
          601n,
        ),
        "0xt2": makeReceipt("0xt2", [], 602n),
      },
      traces: {
        "0xt0": new Error("no debug"),
        "0xt1": new Error("no debug"),
        "0xt2": new Error("no debug"),
      },
    });
    const r = await discoverAgentCallSurface(AGENT, {
      publicClient: client,
      maxTxs: 3,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => /looks like a token/i.test(w))).toBe(true);
  });

  it("uses the RPC log path for contract agents before touching the explorer", async () => {
    // Shannon Blockscout was lagging the chain by ~5 days, returning "no
    // transactions" for active contracts. The RPC-first path reads logs
    // straight from the node so we never hit the explorer when the agent
    // is actively emitting events.
    const client = makeClient({
      code: "0x6080604052",
      headBlock: 1_000n,
      rpcLogs: [
        { transactionHash: "0xrpcA", blockNumber: 950n },
        { transactionHash: "0xrpcB", blockNumber: 960n },
      ],
      rpcTxs: {
        "0xrpca": {
          hash: "0xrpcA",
          from: "0xuser",
          to: AGENT,
          blockNumber: 950n,
        },
        "0xrpcb": {
          hash: "0xrpcB",
          from: "0xuser",
          to: AGENT,
          blockNumber: 960n,
        },
      },
      receipts: {
        "0xrpca": makeReceipt("0xrpcA", [], 950n),
        "0xrpcb": makeReceipt("0xrpcB", [], 960n),
      },
      traces: {
        "0xrpca": {
          type: "CALL",
          from: AGENT.toLowerCase(),
          to: TARGET_A.toLowerCase(),
          input: SEL_X + "00".repeat(32),
        },
        "0xrpcb": {
          type: "CALL",
          from: AGENT.toLowerCase(),
          to: TARGET_B.toLowerCase(),
          input: SEL_Y + "00".repeat(32),
        },
      },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agentKind).toBe("contract");
    expect(r.txsScanned).toBe(2);
    // The explorer must NOT have been hit — the RPC path covered the set.
    expect(fetchMock).not.toHaveBeenCalled();
    // Aggregated set: (TARGET_A, SEL_X) and (TARGET_B, SEL_Y).
    const byTarget = new Map(r.targets.map((t) => [t.target, t]));
    expect(byTarget.get(TARGET_A.toLowerCase())?.functions[0].selector).toBe(SEL_X);
    expect(byTarget.get(TARGET_B.toLowerCase())?.functions[0].selector).toBe(SEL_Y);
  });

  it("falls back to Blockscout when the RPC log path returns no events", async () => {
    // Agent has nothing emitted in the last 7 days but historic tx history
    // is still visible to Blockscout. Discovery must surface the historic
    // calls — otherwise active contracts that recently went quiet would
    // look empty.
    fetchMock.mockResolvedValueOnce(
      txlistResponse([
        { hash: "0xhist", to: AGENT, from: "0xuser", blockNumber: "100" },
      ]),
    );
    const client = makeClient({
      code: "0x6080604052",
      headBlock: 1_000n,
      rpcLogs: [], // no events in the lookback window
      receipts: { "0xhist": makeReceipt("0xhist", [], 100n) },
      traces: {
        "0xhist": {
          type: "CALL",
          from: AGENT.toLowerCase(),
          to: TARGET_A.toLowerCase(),
          input: SEL_X + "00".repeat(32),
        },
      },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Blockscout WAS called (RPC was empty, so we fall through).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.txsScanned).toBe(1);
    expect(r.targets[0].target).toBe(TARGET_A.toLowerCase());
  });

  it("dedupes the RPC path's (target, selector) set across multiple events from the same tx", async () => {
    // A single tx that emits many events should still resolve to one
    // discovered (target, selector) call — uniqueness is by txHash, not
    // by event count.
    const client = makeClient({
      code: "0x6080604052",
      headBlock: 1_000n,
      rpcLogs: [
        // Same txHash, three events. The dedup pass picks one and the
        // discovery pipeline must not count the same call three times.
        { transactionHash: "0xmulti", blockNumber: 980n },
        { transactionHash: "0xmulti", blockNumber: 980n },
        { transactionHash: "0xmulti", blockNumber: 980n },
      ],
      rpcTxs: {
        "0xmulti": {
          hash: "0xmulti",
          from: "0xuser",
          to: AGENT,
          blockNumber: 980n,
        },
      },
      receipts: { "0xmulti": makeReceipt("0xmulti", [], 980n) },
      traces: {
        "0xmulti": {
          type: "CALL",
          from: AGENT.toLowerCase(),
          to: TARGET_A.toLowerCase(),
          input: SEL_X + "00".repeat(32),
        },
      },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.txsScanned).toBe(1);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].functions[0].callCount).toBe(1);
  });

  it("skips the RPC path entirely for EOA agents (they emit no events)", async () => {
    // EOAs can't emit events, so getLogs is structurally useless. The
    // discovery flow must skip straight to Blockscout for them — otherwise
    // every EOA would look like an empty agent.
    fetchMock.mockResolvedValueOnce(
      txlistResponse([
        { hash: "0xeoa", to: TARGET_A, from: AGENT, blockNumber: "300" },
      ]),
    );
    const getLogs = vi.fn(async () => []);
    const client = makeClient({
      code: "0x", // EOA
      headBlock: 1_000n,
      receipts: { "0xeoa": makeReceipt("0xeoa", [], 300n) },
      traces: {
        "0xeoa": {
          type: "CALL",
          from: AGENT.toLowerCase(),
          to: TARGET_A.toLowerCase(),
          input: SEL_X + "00".repeat(32),
        },
      },
    }) as unknown as PublicClient & { getLogs: typeof getLogs };
    // Replace the default getLogs (which would otherwise return [] silently)
    // with one we can assert was never called.
    (client as unknown as { getLogs: typeof getLogs }).getLogs = getLogs;
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agentKind).toBe("eoa");
    expect(getLogs).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.targets[0].target).toBe(TARGET_A.toLowerCase());
  });

  it("skips a null-returning getTransaction without throwing", async () => {
    // viem's getTransaction can resolve to `null` (not throw) when a tx is
    // pruned, the RPC has racy state, or the hash is unknown. The RPC
    // discovery path must not dereference such a null record — it should
    // skip the tx and proceed with the others.
    const client = makeClient({
      code: "0x6080604052",
      headBlock: 1_000n,
      rpcLogs: [
        // 0xpruned will resolve to null (pruned/racy); 0xlive resolves
        // normally. The discovered set must contain 0xlive's call and not
        // crash on 0xpruned.
        { transactionHash: "0xpruned", blockNumber: 940n },
        { transactionHash: "0xlive", blockNumber: 950n },
      ],
      rpcTxs: {
        "0xlive": {
          hash: "0xlive",
          from: "0xuser",
          to: AGENT,
          blockNumber: 950n,
        },
      },
      rpcTxsNull: new Set(["0xpruned"]),
      receipts: {
        "0xlive": makeReceipt("0xlive", [], 950n),
      },
      traces: {
        "0xlive": {
          type: "CALL",
          from: AGENT.toLowerCase(),
          to: TARGET_A.toLowerCase(),
          input: SEL_X + "00".repeat(32),
        },
      },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agentKind).toBe("contract");
    // Only 0xlive contributed — 0xpruned was skipped, not crashed on.
    expect(r.txsScanned).toBe(1);
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].target).toBe(TARGET_A.toLowerCase());
    expect(r.targets[0].functions[0].selector).toBe(SEL_X);
  });

  it("excludes recursive self-calls in the trace path", async () => {
    fetchMock.mockResolvedValueOnce(
      txlistResponse([
        { hash: "0xrec", to: AGENT, from: "0xu", blockNumber: "700" },
      ]),
    );
    // Top-level call from agent to itself (should be skipped), with one
    // nested call from agent to TARGET_A (should be kept).
    const trace = {
      type: "CALL",
      from: AGENT.toLowerCase(),
      to: AGENT.toLowerCase(),
      input: SEL_X + "00".repeat(32),
      calls: [
        {
          type: "CALL",
          from: AGENT.toLowerCase(),
          to: TARGET_A.toLowerCase(),
          input: SEL_Y + "00".repeat(32),
        },
      ],
    };
    const client = makeClient({
      receipts: { "0xrec": makeReceipt("0xrec", [], 700n) },
      traces: { "0xrec": trace },
    });
    const r = await discoverAgentCallSurface(AGENT, { publicClient: client });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("trace");
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].target).toBe(TARGET_A.toLowerCase());
    expect(r.targets[0].functions[0].selector).toBe(SEL_Y);
  });

});
