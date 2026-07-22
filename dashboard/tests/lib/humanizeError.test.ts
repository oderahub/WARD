import { describe, it, expect } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  type Abi,
} from "viem";

import { humanizeWeb3Error } from "../../src/lib/humanizeError";

/**
 * Helper to fabricate a viem-shaped revert error for a given errorName, the
 * way `simulateContract` would surface it after decoding against the ABI.
 * We build a real ContractFunctionRevertedError so the humanizer's
 * `err.walk(...)` traversal exercises the same instanceof check it does
 * against viem-produced errors in production.
 */
function fakeRevertError(opts: {
  errorName?: string;
  shortMessage?: string;
  message?: string;
}): BaseError {
  // viem's ContractFunctionRevertedError exposes a `data` field with
  // `{ errorName, args }`. We pass an empty `data` when errorName is undefined
  // to mimic the "RPC returned an empty revert payload" case.
  const revert = new ContractFunctionRevertedError({
    abi: [] as Abi,
    data: opts.errorName
      ? `0x${"00".repeat(4)}`
      : undefined,
    functionName: "anything",
    message: opts.message ?? "reverted",
  });
  // Force the decoded shape into the revert error: viem populates `data` from
  // a successful ABI decode. We mutate it here because we don't have a real
  // ABI to decode against in the test.
  if (opts.errorName) {
    (revert as { data?: { errorName?: string } }).data = {
      errorName: opts.errorName,
    };
  } else {
    (revert as { data?: { errorName?: string } }).data = undefined;
  }
  if (opts.shortMessage) {
    (revert as { shortMessage?: string }).shortMessage = opts.shortMessage;
  }

  // Wrap in a BaseError so `err.walk()` finds the revert at depth.
  const outer = new BaseError("simulate failed", { cause: revert });
  return outer;
}

describe("humanizeWeb3Error — user-action paths (regression)", () => {
  it("recognises wallet rejection regardless of casing", () => {
    expect(humanizeWeb3Error(new Error("User rejected the request")).headline).toBe(
      "Cancelled in wallet.",
    );
    expect(humanizeWeb3Error(new Error("user denied transaction"))).toEqual({
      headline: "Cancelled in wallet.",
    });
  });

  it("explains insufficient-funds with the faucet hint", () => {
    const result = humanizeWeb3Error(new Error("insufficient funds for gas"));
    expect(result.headline).toMatch(/Not enough AVAX/);
    expect(result.headline).toMatch(/Avalanche faucet/);
  });
});

describe("humanizeWeb3Error — WardAgentBase revert names", () => {
  it("humanises NotOwner with an ownership-mismatch sentence", () => {
    const result = humanizeWeb3Error(
      fakeRevertError({ errorName: "NotOwner" }),
    );
    expect(result.headline).toMatch(/doesn't own the agent/);
    expect(result.headline).toMatch(/original deployer/);
  });

  it("humanises NotRegistrar with a registrar-mismatch sentence", () => {
    const result = humanizeWeb3Error(
      fakeRevertError({ errorName: "NotRegistrar" }),
    );
    expect(result.headline).toMatch(/didn't register the agent/);
  });

  it("falls back to the raw errorName for unmapped revert names", () => {
    const result = humanizeWeb3Error(
      fakeRevertError({
        errorName: "PolicyAlreadyExists",
        shortMessage: "PolicyAlreadyExists()",
      }),
    );
    // shortMessage takes precedence over errorName when present.
    expect(result.headline).toBe("PolicyAlreadyExists()");
  });
});

describe("humanizeWeb3Error — setPolicyId-missing detection", () => {
  it("flags an undecoded revert during setPolicyId as a missing late-binding contract", () => {
    const result = humanizeWeb3Error(fakeRevertError({}), {
      functionName: "setPolicyId",
    });
    expect(result.headline).toMatch(/doesn't expose a setPolicyId hook/);
    expect(result.headline).toMatch(/WardAgentBase/);
  });

  it("does not mis-attribute undecoded reverts when functionName is something else", () => {
    const result = humanizeWeb3Error(fakeRevertError({}), {
      functionName: "publishPolicy",
    });
    // No NotOwner / NotRegistrar match AND no setPolicyId hint → generic.
    expect(result.headline).not.toMatch(/setPolicyId/);
  });

  it("handles RPC-flattened reverts (plain Error) when functionName === setPolicyId", () => {
    // Some RPCs (Fuji included, intermittently) strip the structured
    // revert into a flat `Error("execution reverted")` with no viem
    // ContractFunctionRevertedError wrapper. The string-match fallback must
    // still surface the late-binding hint.
    const result = humanizeWeb3Error(new Error("execution reverted"), {
      functionName: "setPolicyId",
    });
    expect(result.headline).toMatch(/doesn't expose a setPolicyId hook/);
  });

  it("backward-compatible: callers that omit options still work", () => {
    const result = humanizeWeb3Error(new Error("execution reverted"));
    // Without functionName, the helper can't claim setPolicyId is missing.
    expect(result.headline).not.toMatch(/setPolicyId/);
  });
});
