// Input-domain guards for `evalCheckIntent`. ABI-impossible inputs (negative
// bigints, values past uint256, malformed hex, non-4-byte selectors, etc.)
// must throw synchronously — they can't ever round-trip through
// `SentryOracle.checkIntent`, so accepting them would silently diverge the
// off-chain preflight from the on-chain decision.

import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import {
  evalCheckIntent,
  evalPolicyFromInput,
  type EvalIntent,
  type EvalPolicy,
} from "../src/policy-eval.js";
import { TIER_IMMEDIATE, type PolicyInput } from "../src/types.js";

const TARGET: Address = "0x1111111111111111111111111111111111111111";
const SELECTOR: Hex = "0xa9059cbb";
const ZERO_HASH: Hex = `0x${"0".repeat(64)}` as Hex;

const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

function makePolicyInput(): PolicyInput {
  return {
    targets: [
      {
        target: TARGET,
        selectors: [
          {
            selector: SELECTOR,
            tier: TIER_IMMEDIATE,
            valueCapPerCall: 10n ** 18n,
            delaySeconds: 0,
          },
        ],
      },
    ],
    dailySpendWeiCap: 10n ** 18n,
    expiresAt: UINT64_MAX,
    paused: false,
  };
}

function makeIntent(overrides: Partial<EvalIntent> = {}): EvalIntent {
  return {
    agentId: 1n,
    requestId: 1n,
    target: TARGET,
    selector: SELECTOR,
    // valid calldata: selector + 64 bytes of zero args
    data: (`${SELECTOR}${"0".repeat(128)}`) as Hex,
    value: 0n,
    promptHash: ZERO_HASH,
    taskClass: 0,
    ...overrides,
  };
}

function makePolicy(): EvalPolicy {
  return evalPolicyFromInput(makePolicyInput());
}

describe("evalCheckIntent input-domain guards", () => {
  it("accepts a fully valid input", () => {
    expect(() =>
      evalCheckIntent(makePolicy(), makeIntent(), 0n, 0n),
    ).not.toThrow();
  });

  it("throws RangeError on negative intent.value", () => {
    expect(() =>
      evalCheckIntent(makePolicy(), makeIntent({ value: -1n }), 0n, 0n),
    ).toThrow(/intent\.value \(-1\) is out of uint256 domain/);
  });

  it("throws RangeError on intent.value > uint256.max", () => {
    expect(() =>
      evalCheckIntent(
        makePolicy(),
        makeIntent({ value: UINT256_MAX + 1n }),
        0n,
        0n,
      ),
    ).toThrow(/intent\.value .* is out of uint256 domain/);
  });

  it("throws RangeError on negative spentTodayWei", () => {
    expect(() =>
      evalCheckIntent(makePolicy(), makeIntent(), -1n, 0n),
    ).toThrow(/spentTodayWei \(-1\) is out of uint256 domain/);
  });

  it("throws RangeError on negative nowSec", () => {
    expect(() =>
      evalCheckIntent(makePolicy(), makeIntent(), 0n, -1n),
    ).toThrow(/nowSec \(-1\) is out of uint64 domain/);
  });

  it("throws RangeError on nowSec > uint64.max", () => {
    expect(() =>
      evalCheckIntent(makePolicy(), makeIntent(), 0n, UINT64_MAX + 1n),
    ).toThrow(/nowSec .* is out of uint64 domain/);
  });

  it("throws RangeError on policy.expiresAt > uint64.max", () => {
    const policy = makePolicy();
    policy.expiresAt = UINT64_MAX + 1n;
    expect(() => evalCheckIntent(policy, makeIntent(), 0n, 0n)).toThrow(
      /policy\.expiresAt .* is out of uint64 domain/,
    );
  });

  it("throws TypeError on malformed intent.selector (wrong length)", () => {
    expect(() =>
      evalCheckIntent(
        makePolicy(),
        makeIntent({ selector: "0xabcd" as Hex }),
        0n,
        0n,
      ),
    ).toThrow(/intent\.selector .* is not a 4-byte hex selector/);
  });

  it("throws TypeError on odd-length intent.data", () => {
    expect(() =>
      evalCheckIntent(
        makePolicy(),
        makeIntent({ data: "0xabc" as Hex }),
        0n,
        0n,
      ),
    ).toThrow(/intent\.data .* is not even-length 0x-prefixed hex/);
  });

  it("accepts empty intent.data (will fail BAD_CALLDATA, not throw)", () => {
    const r = evalCheckIntent(makePolicy(), makeIntent({ data: "0x" as Hex }), 0n, 0n);
    expect(r.ok).toBe(false);
  });

  it("throws TypeError on malformed intent.target", () => {
    expect(() =>
      evalCheckIntent(
        makePolicy(),
        makeIntent({ target: "0x1234" as Address }),
        0n,
        0n,
      ),
    ).toThrow(/intent\.target .* is not a 20-byte hex address/);
  });

  it("throws TypeError on malformed intent.promptHash (wrong length)", () => {
    expect(() =>
      evalCheckIntent(
        makePolicy(),
        makeIntent({ promptHash: "0xdead" as Hex }),
        0n,
        0n,
      ),
    ).toThrow(/intent\.promptHash .* is not a 32-byte hex value/);
  });

  it("throws RangeError on negative intent.taskClass", () => {
    expect(() =>
      evalCheckIntent(makePolicy(), makeIntent({ taskClass: -1 }), 0n, 0n),
    ).toThrow(/intent\.taskClass \(-1\) is out of uint8 domain/);
  });

  it("throws RangeError on intent.taskClass > 255", () => {
    expect(() =>
      evalCheckIntent(makePolicy(), makeIntent({ taskClass: 256 }), 0n, 0n),
    ).toThrow(/intent\.taskClass \(256\) is out of uint8 domain/);
  });

  it("throws RangeError on negative intent.agentId", () => {
    expect(() =>
      evalCheckIntent(makePolicy(), makeIntent({ agentId: -1n }), 0n, 0n),
    ).toThrow(/intent\.agentId \(-1\) is out of uint256 domain/);
  });

  it("throws RangeError on negative intent.requestId", () => {
    expect(() =>
      evalCheckIntent(makePolicy(), makeIntent({ requestId: -1n }), 0n, 0n),
    ).toThrow(/intent\.requestId \(-1\) is out of uint256 domain/);
  });

  it("throws RangeError on policy.dailySpendWeiCap > uint256.max", () => {
    const policy = makePolicy();
    policy.dailySpendWeiCap = UINT256_MAX + 1n;
    expect(() => evalCheckIntent(policy, makeIntent(), 0n, 0n)).toThrow(
      /policy\.dailySpendWeiCap .* is out of uint256 domain/,
    );
  });

  it("throws RangeError on a per-call cap entry > uint256.max", () => {
    const policy = makePolicy();
    const t = TARGET.toLowerCase();
    const s = SELECTOR.toLowerCase();
    policy.valueCapPerCall[t]![s] = UINT256_MAX + 1n;
    expect(() => evalCheckIntent(policy, makeIntent(), 0n, 0n)).toThrow(
      /policy\.valueCapPerCall.* is out of uint256 domain/,
    );
  });

  it("throws RangeError on a delaySeconds entry > uint32.max", () => {
    const policy = makePolicy();
    const t = TARGET.toLowerCase();
    const s = SELECTOR.toLowerCase();
    policy.delaySeconds[t]![s] = Number(UINT64_MAX); // > uint32
    expect(() => evalCheckIntent(policy, makeIntent(), 0n, 0n)).toThrow(
      /policy\.delaySeconds.* is out of uint32 domain/,
    );
  });
});
