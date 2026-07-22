import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import {
  createSentryGuardedWrite,
  SentryPreflightRejectedError,
  type WriteContractArgs,
} from "../src/index.js";

vi.mock("@sentry-somnia/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry-somnia/sdk")>();
  return {
    ...actual,
    preflight: vi.fn(),
  };
});

const { preflight } = await import("@sentry-somnia/sdk");

const TARGET: Address = "0x1111111111111111111111111111111111111111";
const HASH: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const abi = [
  {
    type: "function",
    name: "set",
    stateMutability: "nonpayable",
    inputs: [{ name: "value", type: "uint256" }],
    outputs: [],
  },
] as const;
const source = {
  kind: "local",
  policy: {
    isTargetAllowed: {},
    isSelectorAllowed: {},
    valueCapPerCall: {},
    tier: {},
    delaySeconds: {},
    dailySpendWeiCap: 0n,
    expiresAt: 0n,
    paused: false,
  },
} as const;

function writeArgs(overrides: Partial<WriteContractArgs<typeof abi>> = {}) {
  return {
    abi,
    address: TARGET,
    functionName: "set",
    args: [1n],
    ...overrides,
  } as WriteContractArgs<typeof abi>;
}

function allow() {
  vi.mocked(preflight).mockResolvedValue({
    ok: true,
    reason: "0x0000000000000000000000000000000000000000000000000000000000000000",
    reasonText: "Intent allowed by policy.",
    source: "local",
  });
}

describe("createSentryGuardedWrite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs preflight before writeContract and returns the transaction hash", async () => {
    allow();
    const calls: string[] = [];
    const writeContract = vi.fn(async () => {
      calls.push("write");
      return HASH;
    });
    vi.mocked(preflight).mockImplementation(async () => {
      calls.push("preflight");
      return {
        ok: true,
        reason: "0x0000000000000000000000000000000000000000000000000000000000000000",
        reasonText: "Intent allowed by policy.",
        source: "local",
      };
    });

    const write = createSentryGuardedWrite({ config: {}, source, writeContract });

    await expect(write(writeArgs())).resolves.toBe(HASH);
    expect(calls).toEqual(["preflight", "write"]);
  });

  it("throws a typed error with reasonText when preflight rejects", async () => {
    vi.mocked(preflight).mockResolvedValue({
      ok: false,
      reason: "0x53454c4543544f525f4e4f545f414c4c4f5745440000000000000000000000",
      reasonText: "The selector is not allowed by this policy.",
      source: "local",
    });
    const writeContract = vi.fn(async () => HASH);
    const write = createSentryGuardedWrite({ config: {}, source, writeContract });

    await expect(write(writeArgs())).rejects.toThrow(
      "The selector is not allowed by this policy.",
    );
    await expect(write(writeArgs())).rejects.toBeInstanceOf(
      SentryPreflightRejectedError,
    );
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("toggles pending true then false for an allowed write", async () => {
    allow();
    const pending: boolean[] = [];
    const write = createSentryGuardedWrite({
      config: {},
      source,
      setPending: (v) => pending.push(v),
      writeContract: vi.fn(async () => HASH),
    });

    await write(writeArgs());

    expect(pending).toEqual([true, false]);
  });

  it("toggles pending true then false for a rejected write", async () => {
    vi.mocked(preflight).mockResolvedValue({
      ok: false,
      reason: "0x52454a4543540000000000000000000000000000000000000000000000000000",
      reasonText: "Rejected.",
      source: "local",
    });
    const pending: boolean[] = [];
    const write = createSentryGuardedWrite({
      config: {},
      source,
      setPending: (v) => pending.push(v),
      writeContract: vi.fn(async () => HASH),
    });

    await expect(write(writeArgs())).rejects.toThrow("Rejected.");
    expect(pending).toEqual([true, false]);
  });

  it("awaits lazy spentTodayWei before preflight", async () => {
    allow();
    const spentTodayWei = vi.fn(async () => 42n);
    const write = createSentryGuardedWrite({
      config: {},
      source,
      spentTodayWei,
      writeContract: vi.fn(async () => HASH),
    });

    await write(writeArgs());

    expect(spentTodayWei).toHaveBeenCalledTimes(1);
    expect(vi.mocked(preflight).mock.calls[0]![0].spentTodayWei).toBe(42n);
  });

  it("uses bigint spentTodayWei directly", async () => {
    allow();
    const write = createSentryGuardedWrite({
      config: {},
      source,
      spentTodayWei: 7n,
      writeContract: vi.fn(async () => HASH),
    });

    await write(writeArgs());

    expect(vi.mocked(preflight).mock.calls[0]![0].spentTodayWei).toBe(7n);
  });

  it("defaults spentTodayWei to zero", async () => {
    allow();
    const write = createSentryGuardedWrite({
      config: {},
      source,
      writeContract: vi.fn(async () => HASH),
    });

    await write(writeArgs());

    expect(vi.mocked(preflight).mock.calls[0]![0].spentTodayWei).toBe(0n);
  });

  it("stores the last decision callback", async () => {
    allow();
    const decisions: unknown[] = [];
    const write = createSentryGuardedWrite({
      config: {},
      source,
      setLastDecision: (decision) => decisions.push(decision),
      writeContract: vi.fn(async () => HASH),
    });

    await write(writeArgs());

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ ok: true });
  });

  it("builds the Intent from write args", async () => {
    allow();
    const write = createSentryGuardedWrite({
      config: {},
      source,
      writeContract: vi.fn(async () => HASH),
    });

    await write(writeArgs({ value: 5n }));

    const intent = vi.mocked(preflight).mock.calls[0]![0].intent;
    expect(intent.target).toBe(TARGET);
    expect(intent.selector).toBe("0x60fe47b1");
    expect(intent.data.startsWith("0x60fe47b1")).toBe(true);
    expect(intent.value).toBe(5n);
  });

  it("passes Sentry metadata into the Intent builder", async () => {
    allow();
    const write = createSentryGuardedWrite({
      config: {},
      source,
      writeContract: vi.fn(async () => HASH),
    });

    await write(
      writeArgs({
        sentry: {
          requestId: 9n,
          agentId: 10n,
          promptHash: HASH,
          taskClass: 4,
        },
      }),
    );

    const intent = vi.mocked(preflight).mock.calls[0]![0].intent;
    expect(intent.requestId).toBe(9n);
    expect(intent.agentId).toBe(10n);
    expect(intent.promptHash).toBe(HASH);
    expect(intent.taskClass).toBe(4);
  });

  it("passes the original args through to writeContract", async () => {
    allow();
    const writeContract = vi.fn(async () => HASH);
    const config = { id: "config" };
    const args = writeArgs({ chainId: 50312 });
    const write = createSentryGuardedWrite({ config, source, writeContract });

    await write(args);

    expect(writeContract).toHaveBeenCalledWith(config, args);
  });
});
