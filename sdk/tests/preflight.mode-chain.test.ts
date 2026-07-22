// Mode-A integration test: `preflight({ source: { kind: 'chain', ... }})`
// must call `publicClient.readContract` against `checkIntent` with args in
// the on-chain order `[policyId, intent, spentTodayWei]`, and must return a
// clean `PreflightResult` for both allowed and rejected results — never
// throwing on a policy rejection.

import { describe, it, expect, vi } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { preflight } from "../src/preflight.js";
import { REASON_CODES } from "../src/reason-codes.js";
import type { EvalIntent } from "../src/policy-eval.js";

const ORACLE: Address = "0x1234567890123456789012345678901234567890";
const POLICY_ID: Hex =
  "0xabababababababababababababababababababababababababababababababab";

function makeIntent(): EvalIntent {
  return {
    agentId: 7n,
    requestId: 1n,
    target: "0x000000000000000000000000000000000000a000",
    selector: "0xaabbccdd",
    data: "0xaabbccdd",
    value: 0n,
    promptHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    taskClass: 0,
  };
}

describe("preflight — mode 'chain'", () => {
  it("calls checkIntent with [policyId, intent, spentToday] in that order", async () => {
    const readContract = vi.fn(async () => [true, REASON_CODES.OK] as const);
    const publicClient = { readContract } as unknown as PublicClient;
    const intent = makeIntent();

    const result = await preflight({
      source: { kind: "chain", publicClient, oracleAddress: ORACLE, policyId: POLICY_ID },
      intent,
      spentTodayWei: 42n,
    });

    expect(readContract).toHaveBeenCalledTimes(1);
    const call = readContract.mock.calls[0]![0] as {
      address: Address;
      functionName: string;
      args: readonly unknown[];
    };
    expect(call.address).toBe(ORACLE);
    expect(call.functionName).toBe("checkIntent");
    expect(call.args[0]).toBe(POLICY_ID);
    expect(call.args[1]).toBe(intent);
    expect(call.args[2]).toBe(42n);

    expect(result).toEqual({
      ok: true,
      reason: REASON_CODES.OK,
      reasonText: "Intent allowed by policy.",
      source: "chain",
    });
  });

  it("returns a clean rejection (no throw) when the oracle says no", async () => {
    const readContract = vi.fn(
      async () => [false, REASON_CODES.SELECTOR_NOT_ALLOWED] as const,
    );
    const publicClient = { readContract } as unknown as PublicClient;

    const result = await preflight({
      source: { kind: "chain", publicClient, oracleAddress: ORACLE, policyId: POLICY_ID },
      intent: makeIntent(),
      spentTodayWei: 0n,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REASON_CODES.SELECTOR_NOT_ALLOWED);
    expect(result.source).toBe("chain");
    // decoded human text comes from reason-codes.ts
    expect(result.reasonText).toMatch(/selector is not allowed/i);
  });

  it("decodes REQUIRES_DELAY (the tier branch WardOracle adds)", async () => {
    const readContract = vi.fn(
      async () => [false, REASON_CODES.REQUIRES_DELAY] as const,
    );
    const publicClient = { readContract } as unknown as PublicClient;
    const result = await preflight({
      source: { kind: "chain", publicClient, oracleAddress: ORACLE, policyId: POLICY_ID },
      intent: makeIntent(),
      spentTodayWei: 0n,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(REASON_CODES.REQUIRES_DELAY);
    expect(result.reasonText).toMatch(/queued/i);
  });
});
