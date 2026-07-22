import { describe, it, expect } from "vitest";
import {
  PolicyBuilder,
  parseEtherFlexible,
  suggestEtherFix,
} from "../src/policy-builder.js";
import { TIER_NAMES } from "../src/types.js";
import { toFunctionSelector } from "viem";

const ADDR_USDSO = "0x1111111111111111111111111111111111111111";
const ADDR_DEX = "0x2222222222222222222222222222222222222222";

describe("PolicyBuilder", () => {
  it("builds a one-target one-selector policy", () => {
    const p = new PolicyBuilder()
      .target(ADDR_USDSO)
      .selector("approve(address,uint256)", { tier: "IMMEDIATE" })
      .dailyCap("1 ether")
      .maxSlippageBps(50)
      .expiresInDays(30)
      .build();

    expect(p.targets).toHaveLength(1);
    expect(p.targets[0].selectors[0].selector).toBe(
      toFunctionSelector("approve(address,uint256)"),
    );
    expect(p.dailySpendWeiCap).toBe(10n ** 18n);
    expect(p.maxSlippageBps).toBe(50);
    expect(p.expiresAt).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  });

  it("builds a multi-target multi-selector policy", () => {
    const p = new PolicyBuilder()
      .target(ADDR_USDSO)
      .selector("approve(address,uint256)", { tier: "IMMEDIATE" })
      .target(ADDR_DEX)
      .selector("placeOrder(address,address,uint256,uint256)", { tier: "IMMEDIATE" })
      .selector("cancelOrder(bytes32)", { tier: "DELAYED", delaySeconds: 30 })
      .expiresInDays(1)
      .build();

    expect(p.targets).toHaveLength(2);
    expect(p.targets[1].selectors).toHaveLength(2);
    expect(p.targets[1].selectors[1].tier).toBe(TIER_NAMES.DELAYED);
    expect(p.targets[1].selectors[1].delaySeconds).toBe(30);
  });

  it("rejects selector before target", () => {
    expect(() => new PolicyBuilder().selector("approve(address,uint256)")).toThrow(
      /target/,
    );
  });

  it("rejects delay on IMMEDIATE", () => {
    expect(() =>
      new PolicyBuilder()
        .target(ADDR_USDSO)
        .selector("approve(address,uint256)", { tier: "IMMEDIATE", delaySeconds: 30 })
        .expiresInDays(1)
        .build(),
    ).toThrow(/IMMEDIATE/);
  });

  it("rejects delay on VETO_REQUIRED", () => {
    expect(() =>
      new PolicyBuilder()
        .target(ADDR_USDSO)
        .selector("approve(address,uint256)", { tier: "VETO_REQUIRED", delaySeconds: 30 })
        .expiresInDays(1)
        .build(),
    ).toThrow(/VETO_REQUIRED/);
  });

  it("rejects out-of-range slippage bps", () => {
    expect(() => new PolicyBuilder().maxSlippageBps(20000)).toThrow(/0\.\.10000/);
  });

  it("rejects empty target list", () => {
    expect(() => new PolicyBuilder().expiresInDays(1).build()).toThrow(/target/);
  });

  it("rejects missing expiresAt", () => {
    expect(() =>
      new PolicyBuilder()
        .target(ADDR_USDSO)
        .selector("approve(address,uint256)", { tier: "IMMEDIATE" })
        .build(),
    ).toThrow(/expiresAt/);
  });

  it("accepts a raw 0x-prefixed selector", () => {
    const p = new PolicyBuilder()
      .target(ADDR_USDSO)
      .selector("0xa9059cbb", { tier: "IMMEDIATE" })
      .expiresInDays(1)
      .build();
    expect(p.targets[0].selectors[0].selector).toBe("0xa9059cbb");
  });

  it("accepts a bigint perCallCap", () => {
    const p = new PolicyBuilder()
      .target(ADDR_USDSO)
      .selector("approve(address,uint256)", { tier: "IMMEDIATE", perCallCap: 12345n })
      .expiresInDays(1)
      .build();
    expect(p.targets[0].selectors[0].valueCapPerCall).toBe(12345n);
  });

  // NEW MED — ABI-width bounds. The builder API must agree with the compiler:
  // uint32_max passes; +1 fails for delaySeconds. uint256_max passes; +1 fails
  // for valueCapPerCall.
  it("accepts delaySeconds at uint32 max", () => {
    const p = new PolicyBuilder()
      .target(ADDR_USDSO)
      .selector("approve(address,uint256)", { tier: "DELAYED", delaySeconds: 4294967295 })
      .expiresInDays(1)
      .build();
    expect(p.targets[0].selectors[0].delaySeconds).toBe(4294967295);
  });

  it("rejects delaySeconds above uint32 max", () => {
    expect(() =>
      new PolicyBuilder()
        .target(ADDR_USDSO)
        .selector("approve(address,uint256)", { tier: "DELAYED", delaySeconds: 4294967296 })
        .expiresInDays(1)
        .build(),
    ).toThrow(/uint32 max/);
  });

  it("accepts valueCapPerCall at uint256 max", () => {
    const uint256Max = (1n << 256n) - 1n;
    const p = new PolicyBuilder()
      .target(ADDR_USDSO)
      .selector("approve(address,uint256)", { tier: "IMMEDIATE", perCallCap: uint256Max })
      .expiresInDays(1)
      .build();
    expect(p.targets[0].selectors[0].valueCapPerCall).toBe(uint256Max);
  });

  it("rejects valueCapPerCall above uint256 max", () => {
    const over = 1n << 256n;
    expect(() =>
      new PolicyBuilder()
        .target(ADDR_USDSO)
        .selector("approve(address,uint256)", { tier: "IMMEDIATE", perCallCap: over })
        .expiresInDays(1)
        .build(),
    ).toThrow(/uint256 max/);
  });

  it("rejects dailyCap above uint256 max", () => {
    expect(() =>
      new PolicyBuilder().dailyCap(1n << 256n),
    ).toThrow(/uint256 max/);
  });
});

/**
 * Native-only unit parsing. Ward meters native msg.value (AVAX) only; the
 * parser deliberately accepts ONE unit suffix (`ether`, case-insensitive) and
 * rejects every other unit (`gwei`, `wei`, `eth`, etc.) so a user typo doesn't
 * silently fall through to a confusing low-level BigInt SyntaxError at publish
 * time. Near-miss typos for `ether` get a "did you mean" hint.
 */
describe("parseEtherFlexible — unit handling and typo hints", () => {
  // Behavior of canonical inputs MUST be unchanged by the typo guard.
  it("preserves canonical inputs: '1 ether' -> 1e18", () => {
    expect(parseEtherFlexible("1 ether")).toBe(10n ** 18n);
  });

  it("preserves canonical inputs: '0.5 ether' -> 5e17", () => {
    expect(parseEtherFlexible("0.5 ether")).toBe(5n * 10n ** 17n);
  });

  it("preserves plain wei integers", () => {
    expect(parseEtherFlexible("1000000000000000000")).toBe(10n ** 18n);
  });

  it("preserves '0' -> 0n", () => {
    expect(parseEtherFlexible("0")).toBe(0n);
  });

  it("preserves case-insensitive 'ether' (e.g. '0.5ETHER', '0.5ether')", () => {
    expect(parseEtherFlexible("0.5ETHER")).toBe(5n * 10n ** 17n);
    expect(parseEtherFlexible("0.5ether")).toBe(5n * 10n ** 17n);
  });

  it("throws a hint-bearing error on '0.5ethe' (missing final r)", () => {
    expect(() => parseEtherFlexible("0.5ethe")).toThrow(/did you mean "0\.5 ether"/);
  });

  it("throws a hint-bearing error on '1 eth' (short form)", () => {
    expect(() => parseEtherFlexible("1 eth")).toThrow(/did you mean "1 ether"/);
  });

  it("throws a hint-bearing error on '2etherr' (extra r)", () => {
    expect(() => parseEtherFlexible("2etherr")).toThrow(/did you mean "2 ether"/);
  });

  // Unrecognized real units should NOT be suggested as `ether` — that would
  // be misleading. They still throw, just without the suggestion.
  it("throws WITHOUT an 'ether' suggestion on '100 gwei'", () => {
    expect(() => parseEtherFlexible("100 gwei")).toThrow();
    try {
      parseEtherFlexible("100 gwei");
    } catch (e: unknown) {
      expect((e as Error).message).not.toMatch(/did you mean/);
    }
  });

  it("throws WITHOUT an 'ether' suggestion on '5 wei'", () => {
    try {
      parseEtherFlexible("5 wei");
      throw new Error("expected throw");
    } catch (e: unknown) {
      expect((e as Error).message).not.toMatch(/did you mean/);
    }
  });
});

describe("suggestEtherFix", () => {
  it("returns null for valid canonical inputs", () => {
    expect(suggestEtherFix("1 ether")).toBeNull();
    expect(suggestEtherFix("0.5 ether")).toBeNull();
    expect(suggestEtherFix("1000000000000000000")).toBeNull();
  });

  it("returns null for plain digits and zero", () => {
    expect(suggestEtherFix("0")).toBeNull();
    expect(suggestEtherFix("42")).toBeNull();
  });

  it("suggests the canonical form for concatenated typos", () => {
    expect(suggestEtherFix("0.5ethe")).toBe("0.5 ether");
    expect(suggestEtherFix("1eth")).toBe("1 ether");
  });

  it("suggests the canonical form for spaced typos", () => {
    expect(suggestEtherFix("1 eth")).toBe("1 ether");
    expect(suggestEtherFix("2 etherr")).toBe("2 ether");
  });

  it("returns null for unrecognized real units (gwei, wei, finney)", () => {
    expect(suggestEtherFix("100 gwei")).toBeNull();
    expect(suggestEtherFix("5 wei")).toBeNull();
    expect(suggestEtherFix("3 finney")).toBeNull();
  });
});
