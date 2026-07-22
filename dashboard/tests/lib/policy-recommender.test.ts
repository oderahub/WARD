import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import { TIER_DELAYED, TIER_IMMEDIATE, TIER_VETO_REQUIRED } from "@sentry-somnia/sdk";

import { recommendPolicies } from "../../src/lib/policy-recommender";
import type { DiscoveryReport } from "../../src/lib/discovery";

const NOW = 1_700_000_000n;
const AGENT = "0x000000000000000000000000000000000000beef" as Address;
const ORACLE = "0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf" as Address;
const REGISTRAR = "0x97F743A9AAa5AcAA73075C1B8F1921274755CF70" as Address;
const POLICY_ID = ("0x" + "ab".repeat(32)) as Hex;

function baseReport(overrides: Partial<DiscoveryReport> = {}): DiscoveryReport {
  return {
    agent: AGENT,
    chainId: 50312,
    kind: "eoa",
    hasCode: false,
    codeSize: 0,
    nonce: 0,
    balanceWei: 0n,
    tokenFingerprint: null,
    sentryAware: { sentryAware: false, reason: "no-registry-no-queue" },
    alreadyRegistered: { registered: false },
    scannedAtMs: 1,
    rpcCallsUsed: 1,
    warnings: [],
    errors: [],
    ...overrides,
  };
}

function eoaFresh(): DiscoveryReport {
  return baseReport({ kind: "eoa", hasCode: false, nonce: 0 });
}

function eoaActive(): DiscoveryReport {
  return baseReport({
    kind: "eoa",
    hasCode: false,
    nonce: 42,
    sentryAware: {
      sentryAware: true,
      evidence: {
        kind: "queue",
        execId: 7n,
        policyId: POLICY_ID,
        tier: 1,
        blockNumber: 1234n,
      },
    },
  });
}

function erc20(): DiscoveryReport {
  return baseReport({
    kind: "erc20",
    hasCode: true,
    codeSize: 200,
    nonce: 1,
    tokenFingerprint: { symbol: "TEST", decimals: 18, supports721: false },
    sentryAware: {
      sentryAware: true,
      evidence: {
        kind: "queue",
        execId: 1n,
        policyId: POLICY_ID,
        tier: 1,
        blockNumber: 1n,
      },
    },
  });
}

function erc721(): DiscoveryReport {
  return baseReport({
    kind: "erc721",
    hasCode: true,
    codeSize: 200,
    nonce: 1,
    tokenFingerprint: { symbol: "NFT", supports721: true },
    sentryAware: {
      sentryAware: true,
      evidence: {
        kind: "queue",
        execId: 1n,
        policyId: POLICY_ID,
        tier: 1,
        blockNumber: 1n,
      },
    },
  });
}

function unknownContractSentryAware(): DiscoveryReport {
  return baseReport({
    kind: "unknown-contract",
    hasCode: true,
    codeSize: 500,
    nonce: 1,
    sentryAware: {
      sentryAware: true,
      evidence: {
        kind: "registry",
        policyId: POLICY_ID,
        oracle: ORACLE,
        registrar: REGISTRAR,
        name: "test-agent",
        metadataURI: "",
        tags: [],
        updatedAt: 100n,
        active: true,
        resolvedTargets: undefined,
      },
    },
    alreadyRegistered: {
      registered: true,
      entry: {
        agent: AGENT,
        registrar: REGISTRAR,
        oracle: ORACLE,
        policyId: POLICY_ID,
        name: "test-agent",
        metadataURI: "",
        tags: [],
        updatedAt: 100n,
        active: true,
      },
    },
  });
}

function unknownContractNotSentryAware(): DiscoveryReport {
  return baseReport({
    kind: "unknown-contract",
    hasCode: true,
    codeSize: 500,
    nonce: 1,
    sentryAware: { sentryAware: false, reason: "no-registry-no-queue" },
  });
}

function registryWithResolvedTargets(): DiscoveryReport {
  return baseReport({
    kind: "unknown-contract",
    hasCode: true,
    codeSize: 500,
    nonce: 1,
    sentryAware: {
      sentryAware: true,
      evidence: {
        kind: "registry",
        policyId: POLICY_ID,
        oracle: ORACLE,
        registrar: REGISTRAR,
        name: "resolved-agent",
        metadataURI: "",
        tags: [],
        updatedAt: 100n,
        active: true,
        resolvedTargets: [
          {
            target: "0x1111111111111111111111111111111111111111" as Address,
            selectors: [
              {
                selector: "0xa9059cbb" as Hex,
                valueCapPerCall: 0n,
                tier: TIER_IMMEDIATE,
                delaySeconds: 0,
              },
            ],
          },
        ],
      },
    },
    alreadyRegistered: {
      registered: true,
      entry: {
        agent: AGENT,
        registrar: REGISTRAR,
        oracle: ORACLE,
        policyId: POLICY_ID,
        name: "resolved-agent",
        metadataURI: "",
        tags: [],
        updatedAt: 100n,
        active: true,
      },
    },
  });
}

describe("recommendPolicies", () => {
  it("returns conservative as default with observationOnly=true for non-sentry-aware EOA", () => {
    const result = recommendPolicies(eoaFresh(), { nowSec: NOW });

    expect(result.defaultTier).toBe("conservative");
    expect(result.observationOnly).toBe(true);
    expect(result.conservative.parameters.tier).toBe(TIER_VETO_REQUIRED);
    expect(result.balanced.parameters.tier).toBe(TIER_DELAYED);
    expect(result.aggressive.parameters.tier).toBe(TIER_IMMEDIATE);
  });

  it("returns balanced as default for an active EOA with nonce>0", () => {
    const result = recommendPolicies(eoaActive(), { nowSec: NOW });
    expect(result.defaultTier).toBe("balanced");
    expect(result.observationOnly).toBe(false);
  });

  it("returns conservative as default for an ERC20 token-fingerprint", () => {
    const result = recommendPolicies(erc20(), { nowSec: NOW });
    expect(result.defaultTier).toBe("conservative");
    expect(result.observationOnly).toBe(false);
    expect(result.defaultTierReason).toMatch(/ERC-20/);
  });

  it("returns conservative as default for an ERC721 token-fingerprint", () => {
    const result = recommendPolicies(erc721(), { nowSec: NOW });
    expect(result.defaultTier).toBe("conservative");
    expect(result.defaultTierReason).toMatch(/ERC-721/);
  });

  it("returns balanced as default for an unknown-contract with registry evidence", () => {
    const result = recommendPolicies(unknownContractSentryAware(), { nowSec: NOW });
    expect(result.defaultTier).toBe("balanced");
    expect(result.observationOnly).toBe(false);
  });

  it("returns conservative as default for an unknown-contract that is not Sentry-aware", () => {
    const result = recommendPolicies(unknownContractNotSentryAware(), { nowSec: NOW });
    expect(result.defaultTier).toBe("conservative");
    expect(result.observationOnly).toBe(true);
  });

  it("attaches a publish-ready PolicyInput when discovery resolved targets[] from a registry-bound policy", () => {
    const result = recommendPolicies(registryWithResolvedTargets(), { nowSec: NOW });
    // All three tiers should carry a PolicyInput because resolvedTargets is set.
    expect(result.conservative.policy).toBeDefined();
    expect(result.balanced.policy).toBeDefined();
    expect(result.aggressive.policy).toBeDefined();
    expect(result.balanced.policy!.targets[0].selectors[0].tier).toBe(TIER_DELAYED);
    expect(result.conservative.policy!.targets[0].selectors[0].tier).toBe(TIER_VETO_REQUIRED);
    expect(result.aggressive.policy!.targets[0].selectors[0].tier).toBe(TIER_IMMEDIATE);
  });

  it("does NOT attach a PolicyInput when there are no resolved targets — wizard must collect them", () => {
    const result = recommendPolicies(unknownContractSentryAware(), { nowSec: NOW });
    expect(result.conservative.policy).toBeUndefined();
    expect(result.balanced.policy).toBeUndefined();
    expect(result.aggressive.policy).toBeUndefined();
  });

  it("emits exactly 3 distinct tiers (conservative=VETO_REQUIRED, balanced=DELAYED, aggressive=IMMEDIATE) for every input", () => {
    const reports: DiscoveryReport[] = [
      eoaFresh(),
      eoaActive(),
      erc20(),
      erc721(),
      unknownContractSentryAware(),
      unknownContractNotSentryAware(),
      registryWithResolvedTargets(),
    ];
    for (const report of reports) {
      const result = recommendPolicies(report, { nowSec: NOW });
      // 3 distinct tier values.
      const tiers = new Set([
        result.conservative.parameters.tier,
        result.balanced.parameters.tier,
        result.aggressive.parameters.tier,
      ]);
      expect(tiers.size).toBe(3);
      expect(result.conservative.parameters.tier).toBe(TIER_VETO_REQUIRED);
      expect(result.balanced.parameters.tier).toBe(TIER_DELAYED);
      expect(result.aggressive.parameters.tier).toBe(TIER_IMMEDIATE);
      // Distinct tier names.
      expect(result.conservative.name).toBe("conservative");
      expect(result.balanced.name).toBe("balanced");
      expect(result.aggressive.name).toBe("aggressive");
    }
  });

  it("is deterministic — two calls with identical inputs return deep-equal outputs (no clock or random leak)", () => {
    const reports: Array<[string, DiscoveryReport]> = [
      ["eoa-fresh", eoaFresh()],
      ["eoa-active", eoaActive()],
      ["erc20", erc20()],
      ["erc721", erc721()],
      ["unknown-sentry-aware", unknownContractSentryAware()],
      ["unknown-not-sentry-aware", unknownContractNotSentryAware()],
      ["registry-resolved", registryWithResolvedTargets()],
    ];
    for (const [_name, report] of reports) {
      const a = recommendPolicies(report, { nowSec: NOW });
      const b = recommendPolicies(report, { nowSec: NOW });
      expect(a).toEqual(b);
    }
  });

  it("expiresAt absolutes align to nowSec — conservative +1d, balanced +7d, aggressive +30d", () => {
    const result = recommendPolicies(eoaActive(), { nowSec: NOW });
    expect(result.conservative.parameters.expiresAt).toBe(NOW + 86_400n);
    expect(result.balanced.parameters.expiresAt).toBe(NOW + 7n * 86_400n);
    expect(result.aggressive.parameters.expiresAt).toBe(NOW + 30n * 86_400n);
  });

  it("throws when opts.nowSec is missing — caller must pin time", () => {
    // @ts-expect-error -- exercising the programmer-error guard
    expect(() => recommendPolicies(eoaFresh(), {})).toThrow(/nowSec is required/);
  });
});
