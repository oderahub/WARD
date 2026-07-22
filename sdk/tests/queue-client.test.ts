import { describe, it, expect } from "vitest";
import { createQueueClient, type QueueState } from "../src/queue-client.js";

/**
 * Pins the numeric→string state decoding used by the queue-client.
 *
 * Without this, a silent reorder of the on-chain `enum State` (None / Pending /
 * Committed / Vetoed / Expired) would mis-decode at the SDK boundary without
 * any test catching it. The Solidity-side enum is locked by the 17 SentryQueue
 * Foundry tests but they assert via Solidity enum names, not via off-chain
 * numeric ordinals.
 */
describe("queue-client state decoding", () => {
  // Minimal fake publicClient that returns a hand-crafted record.
  function makeClient(state: number) {
    const fakePublicClient = {
      readContract: async () => ({
        policyId: ("0x" + "00".repeat(32)) as `0x${string}`,
        intent: {
          agentId: 0n,
          requestId: 0n,
          target: "0x0000000000000000000000000000000000000000" as const,
          selector: "0x00000000" as const,
          data: "0x" as const,
          value: 0n,
          promptHash: ("0x" + "00".repeat(32)) as `0x${string}`,
          taskClass: 0,
        },
        asker: "0x0000000000000000000000000000000000000000" as const,
        enqueuedAt: 0n,
        earliestCommitAt: 0n,
        deadline: 0n,
        tier: 1,
        state,
      }),
    } as never;
    return createQueueClient({
      publicClient: fakePublicClient,
      queueAddress: "0x0000000000000000000000000000000000000001",
    });
  }

  const expected: readonly QueueState[] = ["None", "Pending", "Committed", "Vetoed", "Expired"];

  for (let i = 0; i < expected.length; i++) {
    it(`maps numeric state ${i} → "${expected[i]}"`, async () => {
      const client = makeClient(i);
      const rec = await client.getRecord(1n);
      expect(rec.state).toBe(expected[i]);
    });
  }
});

/**
 * Pins the canonical→legacy ABI fallback chain for getRecordHeader().
 *
 * The live SentryQueue on Shannon (0x98A3…90D5) predates the policyVersion
 * field added to RecordHeader, so it returns 11 words instead of 12. viem's
 * decoder surfaces this as "is out of bounds" / "not in safe integer range".
 * The client must catch that specific class of shape errors, retry against
 * LEGACY_SENTRY_QUEUE_ABI_V0, and synthesize policyVersion: 0n so consumers
 * see a uniform shape. Non-shape errors (RPC failure, missing record, etc.)
 * must propagate without a legacy retry.
 */
describe("queue-client getRecordHeader ABI fallback", () => {
  const ADDR = "0x0000000000000000000000000000000000000001" as const;
  const ZERO_HEX32 = ("0x" + "00".repeat(32)) as `0x${string}`;
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

  function canonicalHeader() {
    return {
      policyId: ZERO_HEX32,
      policyVersion: 7n,
      asker: ZERO_ADDR,
      enqueuedAt: 100n,
      earliestCommitAt: 200n,
      deadline: 300n,
      tier: 1,
      state: 1,
      target: ZERO_ADDR,
      selector: "0xdeadbeef" as const,
      value: 0n,
      requestId: 42n,
    };
  }

  function legacyHeader() {
    return {
      policyId: ZERO_HEX32,
      asker: ZERO_ADDR,
      enqueuedAt: 100n,
      earliestCommitAt: 200n,
      deadline: 300n,
      tier: 1,
      state: 1,
      target: ZERO_ADDR,
      selector: "0xdeadbeef" as const,
      value: 0n,
      requestId: 42n,
    };
  }

  // Captures (canonicalThrow, legacyResponse) pairs to walk the chain.
  function makeClientWithSequence(
    canonical: () => unknown | Promise<unknown>,
    legacy?: () => unknown | Promise<unknown>,
  ) {
    const calls: Array<"canonical" | "legacy"> = [];
    const fakePublicClient = {
      readContract: async (args: { abi: unknown }) => {
        const abiArr = args.abi as readonly { name?: string; outputs?: readonly { components?: readonly unknown[] }[] }[];
        const header = abiArr.find((i) => i.name === "getRecordHeader");
        const componentCount = header?.outputs?.[0]?.components?.length ?? 0;
        if (componentCount === 12) {
          calls.push("canonical");
          return canonical();
        }
        if (componentCount === 11) {
          calls.push("legacy");
          if (!legacy) throw new Error("test misuse: legacy not provided");
          return legacy();
        }
        throw new Error(`test misuse: unexpected component count ${componentCount}`);
      },
    } as never;
    const client = createQueueClient({ publicClient: fakePublicClient, queueAddress: ADDR });
    return { client, calls };
  }

  it("canonical succeeds → returns it unchanged (no legacy call)", async () => {
    const { client, calls } = makeClientWithSequence(() => canonicalHeader());
    const header = await client.getRecordHeader(1n);
    expect(calls).toEqual(["canonical"]);
    expect(header.policyVersion).toBe(7n);
    expect(header.state).toBe("Pending");
    expect(header.requestId).toBe(42n);
  });

  it("canonical throws shape-error → falls back to legacy with policyVersion: 0n", async () => {
    const { client, calls } = makeClientWithSequence(
      () => { throw new Error("Position is out of bounds for the data; expected getRecordHeader"); },
      () => legacyHeader(),
    );
    const header = await client.getRecordHeader(1n);
    expect(calls).toEqual(["canonical", "legacy"]);
    expect(header.policyVersion).toBe(0n);
    expect(header.state).toBe("Pending");
    expect(header.requestId).toBe(42n);
  });

  it("canonical throws shape-error (safe integer variant) → also triggers fallback", async () => {
    const { client, calls } = makeClientWithSequence(
      () => { throw new Error("Value not in safe integer range while decoding getRecordHeader output"); },
      () => legacyHeader(),
    );
    const header = await client.getRecordHeader(1n);
    expect(calls).toEqual(["canonical", "legacy"]);
    expect(header.policyVersion).toBe(0n);
  });

  it("canonical throws non-shape error → rethrows without trying legacy", async () => {
    const { client, calls } = makeClientWithSequence(
      () => { throw new Error("HTTP request failed: 502 Bad Gateway"); },
    );
    await expect(client.getRecordHeader(1n)).rejects.toThrow(/Bad Gateway/);
    expect(calls).toEqual(["canonical"]);
  });

  it("both canonical AND legacy fail → throws aggregate shape error with both messages", async () => {
    const { client, calls } = makeClientWithSequence(
      () => { throw new Error("Position is out of bounds for the data"); },
      () => { throw new Error("legacy decode also broken: getRecordHeader call reverted"); },
    );
    await expect(client.getRecordHeader(1n)).rejects.toThrow(/unexpected payload shape.*canonical decode.*legacy decode/s);
    expect(calls).toEqual(["canonical", "legacy"]);
  });
});
