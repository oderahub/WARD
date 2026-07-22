import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock env.ts to inject fully-fake viem clients so the queue commands run end
// to end without ever touching the network. Mirrors the preflight test setup.
// Each test assigns the desired client behaviour to global hooks BEFORE
// invoking the command under test; the mock factory closes over those hooks
// so we don't have to re-`vi.mock` per test.
vi.mock("../src/lib/env.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/env.js")>("../src/lib/env.js");
  return {
    ...actual,
    publicClient: () => ({
      readContract: async (args: unknown) => {
        const fn = (globalThis as any).__READ_CONTRACT__;
        if (typeof fn !== "function") throw new Error("__READ_CONTRACT__ not set");
        return fn(args);
      },
      simulateContract: async (args: unknown) => {
        const fn = (globalThis as any).__SIM_CONTRACT__;
        if (typeof fn !== "function") throw new Error("__SIM_CONTRACT__ not set");
        return fn(args);
      },
      waitForTransactionReceipt: async () => ({ status: "success" }),
    }),
    walletClient: () => ({
      account: { address: "0x0000000000000000000000000000000000000001" },
      writeContract: async (args: unknown) => {
        const calls = (globalThis as any).__WRITES__ ?? [];
        calls.push(args);
        (globalThis as any).__WRITES__ = calls;
        return "0xwritehash";
      },
      sendTransaction: async (args: unknown) => {
        const calls = (globalThis as any).__SENDS__ ?? [];
        calls.push(args);
        (globalThis as any).__SENDS__ = calls;
        return "0xexechash";
      },
    }),
  };
});

function clearGlobals() {
  delete (globalThis as any).__SIM_CONTRACT__;
  delete (globalThis as any).__READ_CONTRACT__;
  delete (globalThis as any).__WRITES__;
  delete (globalThis as any).__SENDS__;
  process.env.PRIVATE_KEY = ("0x" + "11".repeat(32));
  process.env.WARD_QUEUE = "0x000000000000000000000000000000000000beef";
  process.env.WARD_ORACLE = "0x0000000000000000000000000000000000000abc";
}

const DUMMY_INTENT = {
  agentId: "1",
  requestId: "1",
  target: "0x1111111111111111111111111111111111111111",
  selector: "0x095ea7b3",
  data: "0x095ea7b300",
  value: "0",
  promptHash: "0x" + "00".repeat(32),
  taskClass: 0,
};

const HEADER = {
  policyId: "0x" + "aa".repeat(32),
  policyVersion: 1n,
  asker: "0x2222222222222222222222222222222222222222",
  enqueuedAt: 1n,
  earliestCommitAt: 2n,
  deadline: 3n,
  tier: 1,
  state: 1,
  target: "0x3333333333333333333333333333333333333333",
  selector: "0x095ea7b3",
  value: 0n,
  requestId: 9n,
};

const LEGACY_HEADER_PAYLOAD =
  "0x64815513f3a543f7d1ecff7b14b78c8f0a1152c5ad4faa514b06a95ebf52f60300000000000000000000000048a6028a9cd69bcc8e4fe2cea4c5f270642c3c3e000000000000000000000000000000000000000000000000000000006a200dc1000000000000000000000000000000000000000000000000000000006a200e39000000000000000000000000000000000000000000000000000000006a2948b9000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000003e397269e4600e7ef414aff724d3f93689d1ee4fac60a6cd0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000470de4df8200000000000000000000000000000000000000000000000000000000000000000123";

function installLegacyHeaderPayloadMock() {
  const calls: any[] = [];
  (globalThis as any).__READ_CONTRACT__ = async (args: any) => {
    calls.push(args);
    if (args.functionName === "policyOwner") return "0x4444444444444444444444444444444444444444";
    if (args.functionName === "getRecordHeader" && calls.filter((call) => call.functionName === "getRecordHeader").length % 2 === 1) {
      throw new Error("Position `383` is out of bounds (`0 < position < 352`).");
    }
    return LEGACY_HEADER_PAYLOAD;
  };
  return calls;
}

describe("ward queue:dispatch", () => {
  let dir: string;
  let logs: string[];
  let restore: () => void;

  beforeEach(() => {
    clearGlobals();
    dir = mkdtempSync(join(tmpdir(), "ward-queue-"));
    logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    restore = () => {
      console.log = origLog;
      console.error = origErr;
    };
  });

  afterEach(() => {
    restore();
    rmSync(dir, { recursive: true, force: true });
    clearGlobals();
  });

  it("without --execute: simulates dispatch, sends dispatch tx, and stops (no follow-up send)", async () => {
    (globalThis as any).__SIM_CONTRACT__ = async () => ({
      result: {
        agentId: 1n,
        requestId: 1n,
        target: "0x2222222222222222222222222222222222222222",
        selector: "0x095ea7b3",
        data: "0x095ea7b3deadbeef",
        value: 0n,
        promptHash: "0x" + "00".repeat(32),
        taskClass: 0,
      },
    });

    const { queueDispatchCmd } = await import("../src/cmd/queue.js");
    await queueDispatchCmd("42");

    const out = logs.join("\n");
    expect(out).toContain("dispatched OK");
    expect(out).toContain("rerun with --execute");
    // exactly one write (the dispatch itself), no sendTransaction.
    expect((globalThis as any).__WRITES__).toHaveLength(1);
    expect((globalThis as any).__SENDS__ ?? []).toHaveLength(0);
  });

  it("with --execute: sends the dispatch tx AND a follow-up sendTransaction carrying the intent's calldata", async () => {
    (globalThis as any).__SIM_CONTRACT__ = async () => ({
      result: {
        agentId: 1n,
        requestId: 1n,
        target: "0x3333333333333333333333333333333333333333",
        selector: "0x095ea7b3",
        data: "0x095ea7b3cafebabe",
        value: 7n,
        promptHash: "0x" + "00".repeat(32),
        taskClass: 0,
      },
    });

    const { queueDispatchCmd } = await import("../src/cmd/queue.js");
    await queueDispatchCmd("99", { execute: true });

    const out = logs.join("\n");
    expect(out).toContain("dispatch tx");
    expect(out).toContain("executing intent");
    expect(out).toContain("intent executed OK");
    const sends = (globalThis as any).__SENDS__ as { to: string; data: string; value: bigint }[];
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe("0x3333333333333333333333333333333333333333");
    expect(sends[0]!.data).toBe("0x095ea7b3cafebabe");
    expect(sends[0]!.value).toBe(7n);
  });

  it("throws when dispatch simulate reverts (does not send any tx)", async () => {
    (globalThis as any).__SIM_CONTRACT__ = async () => {
      throw new Error("execution reverted: TooEarly()\n  at viem stack frame...");
    };

    const { queueDispatchCmd } = await import("../src/cmd/queue.js");
    await expect(queueDispatchCmd("7", { execute: true })).rejects.toThrow(/dispatch would revert/);
    expect((globalThis as any).__WRITES__ ?? []).toHaveLength(0);
    expect((globalThis as any).__SENDS__ ?? []).toHaveLength(0);
  });
});

describe("ward queue:enqueue", () => {
  let dir: string;
  let logs: string[];
  let restore: () => void;

  beforeEach(() => {
    clearGlobals();
    dir = mkdtempSync(join(tmpdir(), "ward-enq-"));
    logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    restore = () => {
      console.log = origLog;
      console.error = origErr;
    };
  });

  afterEach(() => {
    restore();
    rmSync(dir, { recursive: true, force: true });
    clearGlobals();
  });

  it("rejects a malformed policyId before doing any RPC", async () => {
    const path = join(dir, "intent.json");
    writeFileSync(path, JSON.stringify(DUMMY_INTENT));
    const { queueEnqueueCmd } = await import("../src/cmd/queue.js");
    await expect(queueEnqueueCmd(path, "0xnotahex")).rejects.toThrow(/must be a 32-byte hex/);
    // No simulate / write should have been attempted.
    expect((globalThis as any).__WRITES__ ?? []).toHaveLength(0);
  });

  it("simulates enqueue, then writes when simulate succeeds (default spentToday=0)", async () => {
    const path = join(dir, "intent.json");
    writeFileSync(path, JSON.stringify(DUMMY_INTENT));
    let simArgs: any;
    (globalThis as any).__SIM_CONTRACT__ = async (args: any) => {
      simArgs = args;
      return { result: 12345n };
    };

    const { queueEnqueueCmd } = await import("../src/cmd/queue.js");
    const policyId = "0x" + "ab".repeat(32);
    await queueEnqueueCmd(path, policyId);

    expect(simArgs.functionName).toBe("enqueue");
    expect(simArgs.args[0]).toBe(policyId);
    expect(simArgs.args[1].agentId).toBe(1n);
    expect(simArgs.args[2]).toBe(0n); // default spentToday
    const writes = (globalThis as any).__WRITES__;
    expect(writes).toHaveLength(1);
    expect(writes[0].functionName).toBe("enqueue");
    expect(logs.join("\n")).toContain("enqueued OK");
  });

  it("forwards a non-zero --spent-today to the enqueue call", async () => {
    const path = join(dir, "intent.json");
    writeFileSync(path, JSON.stringify(DUMMY_INTENT));
    let simArgs: any;
    (globalThis as any).__SIM_CONTRACT__ = async (args: any) => {
      simArgs = args;
      return { result: 1n };
    };

    const { queueEnqueueCmd } = await import("../src/cmd/queue.js");
    const policyId = "0x" + "cd".repeat(32);
    await queueEnqueueCmd(path, policyId, { spentToday: "1000000000000000000" });
    expect(simArgs.args[2]).toBe(1_000_000_000_000_000_000n);
  });

  it("throws when enqueue simulate reverts (no write attempted)", async () => {
    const path = join(dir, "intent.json");
    writeFileSync(path, JSON.stringify(DUMMY_INTENT));
    (globalThis as any).__SIM_CONTRACT__ = async () => {
      throw new Error("execution reverted: NotQueueable(0x494d4d45444941...)");
    };

    const { queueEnqueueCmd } = await import("../src/cmd/queue.js");
    const policyId = "0x" + "ef".repeat(32);
    await expect(queueEnqueueCmd(path, policyId)).rejects.toThrow(/enqueue would revert/);
    expect((globalThis as any).__WRITES__ ?? []).toHaveLength(0);
  });
});

describe("ward queue:handoff", () => {
  let dir: string;
  let logs: string[];
  let restore: () => void;

  beforeEach(() => {
    clearGlobals();
    dir = mkdtempSync(join(tmpdir(), "ward-handoff-"));
    logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    restore = () => {
      console.log = origLog;
      console.error = origErr;
    };
  });

  afterEach(() => {
    restore();
    rmSync(dir, { recursive: true, force: true });
    clearGlobals();
  });

  it.each([
    {
      name: "IMMEDIATE warns and recommends raw queue cleanup",
      tier: 0,
      hasAgentABI: false,
      hasDispatchQueued: false,
      expected: ["IMMEDIATE requests should not be sitting", "IMMEDIATE_NO_QUEUE_NEEDED", '"dispatch(uint256)" 42'],
    },
    {
      name: "DELAYED with agent ABI dispatchQueued recommends agent flow",
      tier: 1,
      hasAgentABI: true,
      hasDispatchQueued: true,
      expected: ["Use the integrator agent dispatch flow", "0x1111111111111111111111111111111111111111 \"dispatchQueued(uint256)\" 42"],
    },
    {
      name: "DELAYED with agent ABI missing dispatchQueued recommends raw queue with warning",
      tier: 1,
      hasAgentABI: true,
      hasDispatchQueued: false,
      expected: ["Dispatch directly through WardQueue", "dispatchQueued(uint256) not found", "integrator's agent may have its own dispatch flow"],
    },
    {
      name: "DELAYED without agent ABI recommends raw queue with warning",
      tier: 1,
      hasAgentABI: false,
      hasDispatchQueued: false,
      expected: ["Dispatch directly through WardQueue", "Check the agent docs", '"dispatch(uint256)" 42'],
    },
    {
      name: "VETO_REQUIRED prints policy owner and owner-only raw queue command",
      tier: 2,
      hasAgentABI: true,
      hasDispatchQueued: true,
      expected: ["Policy owner only", "0x4444444444444444444444444444444444444444", '"dispatch(uint256)" 42'],
    },
  ])("$name", async ({ tier, hasAgentABI, hasDispatchQueued, expected }) => {
    (globalThis as any).__READ_CONTRACT__ = async (args: any) => {
      if (args.functionName === "policyOwner") return "0x4444444444444444444444444444444444444444";
      return { ...HEADER, tier };
    };

    let abiPath: string | undefined;
    if (hasAgentABI) {
      abiPath = join(dir, "Agent.json");
      const abi = hasDispatchQueued
        ? [{ type: "function", name: "dispatchQueued", inputs: [{ type: "uint256" }], outputs: [] }]
        : [{ type: "function", name: "dispatchOther", inputs: [{ type: "uint256" }], outputs: [] }];
      writeFileSync(abiPath, JSON.stringify({ abi }));
    }

    const { queueHandoffCmd } = await import("../src/cmd/queue.js");
    await queueHandoffCmd("42", {
      agent: hasAgentABI ? "0x1111111111111111111111111111111111111111" : undefined,
      abi: abiPath,
    });

    const out = logs.join("\n");
    for (const needle of expected) expect(out).toContain(needle);
    expect(out).toContain("--private-key $DEPLOYER_PK --rpc-url $SOMNIA_TESTNET_RPC");
  });

  it("falls back to the deployed 11-field header payload, synthesizes policyVersion, and powers status/handoff", async () => {
    const calls = installLegacyHeaderPayloadMock();

    const { queueHandoffCmd, queueStatusCmd, readQueueHeader } = await import("../src/cmd/queue.js");
    const header = await readQueueHeader({ readContract: (globalThis as any).__READ_CONTRACT__ } as never, "0x000000000000000000000000000000000000beef", 1n);

    expect(header).toMatchObject({
      policyId: "0x64815513f3a543f7d1ecff7b14b78c8f0a1152c5ad4faa514b06a95ebf52f603",
      policyVersion: 0n,
      asker: "0x48A6028A9cd69bCc8e4Fe2CEa4c5F270642C3C3e",
      enqueuedAt: BigInt("0x6a200dc1"),
      earliestCommitAt: BigInt("0x6a200e39"),
      deadline: BigInt("0x6a2948b9"),
      tier: 1,
      state: 2,
      target: "0x3E397269e4600e7Ef414Aff724D3F93689D1eE4F",
      selector: "0xac60a6cd",
      value: BigInt("0x470de4df820000"),
      requestId: 0x123n,
    });

    await expect(queueHandoffCmd("1")).resolves.toBeUndefined();
    await expect(queueStatusCmd("1")).resolves.toBeUndefined();

    const out = logs.join("\n");
    expect(out).toContain("requester       0x48A6028A9cd69bCc8e4Fe2CEa4c5F270642C3C3e");
    expect(out).toContain("target          0x3E397269e4600e7Ef414Aff724D3F93689D1eE4F");
    expect(out).toContain("state           Committed");
    expect(calls.filter((call) => call.functionName === "getRecordHeader")).toHaveLength(6);
  });

  it("reports a clean unsupported header-shape error when canonical and legacy decodes both fail", async () => {
    (globalThis as any).__READ_CONTRACT__ = async () => {
      throw new Error("Position `415` is out of bounds (`0 < position < 416`).");
    };

    const { readQueueHeader } = await import("../src/cmd/queue.js");
    await expect(readQueueHeader({ readContract: (globalThis as any).__READ_CONTRACT__ } as never, "0x000000000000000000000000000000000000beef", 1n)).rejects.toThrow(
      "WardQueue at 0x000000000000000000000000000000000000beef returned an unexpected payload shape (416 bytes); expected 384 or 352 bytes.",
    );
  });
});
