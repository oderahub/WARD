import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import { applyPolicyToObservedCall, type ObservedCall } from "../src/policy-eval.js";
import {
  TIER_DELAYED,
  TIER_IMMEDIATE,
  type PolicyInput,
} from "../src/types.js";

const TARGET: Address = "0x1111111111111111111111111111111111111111";
const OTHER_TARGET: Address = "0x9999999999999999999999999999999999999999";
const ASKER: Address = "0x2222222222222222222222222222222222222222";
const SELECTOR: Hex = "0xa9059cbb"; // transfer(address,uint256)
const OTHER_SELECTOR: Hex = "0x095ea7b3"; // approve(address,uint256)

function makePolicy(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    targets: [
      {
        target: TARGET,
        selectors: [
          {
            selector: SELECTOR,
            valueCapPerCall: 1_000_000_000_000_000_000n, // 1 ETH
            tier: TIER_IMMEDIATE,
            delaySeconds: 0,
          },
        ],
      },
    ],
    dailySpendWeiCap: 0n,
    maxSlippageBps: 0,
    expiresAt: 4_102_444_800n, // 2100-01-01
    paused: false,
    ...overrides,
  };
}

function makeCall(overrides: Partial<ObservedCall> = {}): ObservedCall {
  return {
    target: TARGET,
    selector: SELECTOR,
    valueWei: 0n,
    asker: ASKER,
    timestampSec: 1_700_000_000n,
    ...overrides,
  };
}

describe("applyPolicyToObservedCall", () => {
  it("rejects PAUSED policies", () => {
    const verdict = applyPolicyToObservedCall(makePolicy({ paused: true }), makeCall(), 0n);
    expect(verdict).toEqual({ allowed: false, reason: "PAUSED" });
  });

  it("rejects EXPIRED calls (timestamp > expiresAt)", () => {
    const verdict = applyPolicyToObservedCall(
      makePolicy({ expiresAt: 1_000n }),
      makeCall({ timestampSec: 1_001n }),
      0n
    );
    expect(verdict).toEqual({ allowed: false, reason: "EXPIRED" });
  });

  it("rejects with NO_TARGET when call.target is not in policy", () => {
    const verdict = applyPolicyToObservedCall(
      makePolicy(),
      makeCall({ target: OTHER_TARGET }),
      0n
    );
    expect(verdict).toEqual({ allowed: false, reason: "NO_TARGET" });
  });

  it("rejects with SELECTOR_NOT_ALLOWED when selector is not in target's allowlist", () => {
    const verdict = applyPolicyToObservedCall(
      makePolicy(),
      makeCall({ selector: OTHER_SELECTOR }),
      0n
    );
    expect(verdict).toEqual({ allowed: false, reason: "SELECTOR_NOT_ALLOWED" });
  });

  it("rejects with VALUE_EXCEEDS_CAP when call.valueWei > entry.valueCapPerCall", () => {
    const verdict = applyPolicyToObservedCall(
      makePolicy(),
      makeCall({ valueWei: 2_000_000_000_000_000_000n }), // 2 ETH > 1 ETH cap
      0n
    );
    expect(verdict).toEqual({ allowed: false, reason: "VALUE_EXCEEDS_CAP" });
  });

  // Plan #5: dailySpendWeiCap=0 means "no native spend allowed" (PolicyLib.sol:21
  // — `i.value > p.dailySpendWeiCap - spentToday` reverts DAILY_CAP for any
  // positive value when the cap is 0). The SDK watch-mode evaluator must agree
  // with the on-chain enforcer, otherwise the dashboard verdict misleads the user.
  it("rejects DAILY_CAP_EXCEEDED when dailySpendWeiCap=0 and value>0", () => {
    const policy = makePolicy({ dailySpendWeiCap: 0n });
    const verdict = applyPolicyToObservedCall(
      policy,
      makeCall({ valueWei: 1n }),
      0n
    );
    expect(verdict).toEqual({ allowed: false, reason: "DAILY_CAP_EXCEEDED" });
  });

  it("allows pure-data calls (value=0) when dailySpendWeiCap=0", () => {
    const policy = makePolicy({ dailySpendWeiCap: 0n });
    const verdict = applyPolicyToObservedCall(
      policy,
      makeCall({ valueWei: 0n }),
      0n
    );
    expect(verdict).toMatchObject({ allowed: true });
  });

  it("allows when dailySpendWeiCap>0 and spentToday+value <= cap", () => {
    const policy = makePolicy({ dailySpendWeiCap: 10_000_000_000_000_000_000n }); // 10 ETH
    const verdict = applyPolicyToObservedCall(
      policy,
      makeCall({ valueWei: 1_000_000_000_000_000_000n }),
      8_000_000_000_000_000_000n
    );
    expect(verdict).toMatchObject({ allowed: true, tier: "IMMEDIATE", delaySeconds: 0 });
  });

  it("rejects with DAILY_CAP_EXCEEDED when spentToday+value > cap", () => {
    const policy = makePolicy({ dailySpendWeiCap: 10_000_000_000_000_000_000n }); // 10 ETH
    const verdict = applyPolicyToObservedCall(
      policy,
      makeCall({ valueWei: 1_000_000_000_000_000_000n }),
      9_500_000_000_000_000_000n
    );
    expect(verdict).toEqual({ allowed: false, reason: "DAILY_CAP_EXCEEDED" });
  });

  it("returns tier=IMMEDIATE + delaySeconds=0 for an IMMEDIATE-tier match", () => {
    const verdict = applyPolicyToObservedCall(makePolicy(), makeCall(), 0n);
    expect(verdict).toEqual({ allowed: true, tier: "IMMEDIATE", delaySeconds: 0 });
  });

  it("returns tier=DELAYED + matching delaySeconds for a DELAYED-tier match", () => {
    const policy = makePolicy({
      targets: [
        {
          target: TARGET,
          selectors: [
            {
              selector: SELECTOR,
              valueCapPerCall: 1_000_000_000_000_000_000n,
              tier: TIER_DELAYED,
              delaySeconds: 3600,
            },
          ],
        },
      ],
    });
    const verdict = applyPolicyToObservedCall(policy, makeCall(), 0n);
    expect(verdict).toEqual({ allowed: true, tier: "DELAYED", delaySeconds: 3600 });
  });

  it("compares selectors case-insensitively", () => {
    const verdict = applyPolicyToObservedCall(
      makePolicy(),
      makeCall({ selector: SELECTOR.toUpperCase() as Hex }),
      0n
    );
    expect(verdict).toMatchObject({ allowed: true });
  });
});
