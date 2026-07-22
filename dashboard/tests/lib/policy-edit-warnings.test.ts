import { describe, it, expect } from "vitest";
import type { PolicyInput } from "@sentry-somnia/sdk";
import {
  computeAggregateCapNote,
  computeDestructive,
  computePerCallExceedsDailyWarnings,
  policyLifetimeState,
} from "../../src/lib/policy-edit-warnings";

const ADDR_A = "0xA1601891Da4b60c9311B3A024e3E03C5136460e4" as const;
const ADDR_B = "0xB2701892Da4b60c9311B3A024e3E03C5136460e4" as const;
const SEL_X = "0x11111111" as const;
const SEL_Y = "0x22222222" as const;

function selector(
  sel: string,
  cap: bigint,
  tier = 0,
  delaySeconds = 0,
) {
  return { selector: sel as `0x${string}`, valueCapPerCall: cap, tier, delaySeconds };
}

function policy(
  targets: PolicyInput["targets"],
  opts: Partial<Omit<PolicyInput, "targets">> = {},
): PolicyInput {
  return {
    targets,
    dailySpendWeiCap: opts.dailySpendWeiCap ?? 0n,
    maxSlippageBps: opts.maxSlippageBps ?? 0,
    expiresAt: opts.expiresAt ?? 0n,
    paused: opts.paused ?? false,
  };
}

describe("computePerCallExceedsDailyWarnings", () => {
  it("returns empty when dailyCap is zero", () => {
    const input = policy(
      [{ target: ADDR_A, selectors: [selector(SEL_X, 10n ** 18n)] }],
      { dailySpendWeiCap: 0n },
    );
    expect(computePerCallExceedsDailyWarnings(input).size).toBe(0);
  });

  it("flags selectors whose per-call cap exceeds the daily cap", () => {
    const input = policy(
      [
        {
          target: ADDR_A,
          selectors: [
            selector(SEL_X, 2n * 10n ** 18n), // 2 STT > 1 STT daily
            selector(SEL_Y, 5n * 10n ** 17n), // 0.5 STT < 1 STT daily
          ],
        },
      ],
      { dailySpendWeiCap: 10n ** 18n },
    );
    const warnings = computePerCallExceedsDailyWarnings(input);
    expect(warnings.size).toBe(1);
    expect(warnings.get("targets.0.selectors.0.valueCapPerCall")).toMatch(
      /Per-call native cap.*exceeds daily native cap/,
    );
    expect(warnings.has("targets.0.selectors.1.valueCapPerCall")).toBe(false);
  });

  it("does not flag selectors whose per-call cap equals the daily cap", () => {
    const input = policy(
      [{ target: ADDR_A, selectors: [selector(SEL_X, 10n ** 18n)] }],
      { dailySpendWeiCap: 10n ** 18n },
    );
    expect(computePerCallExceedsDailyWarnings(input).size).toBe(0);
  });
});

describe("computeAggregateCapNote", () => {
  it("returns null when dailyCap is zero (per-row #9 handles that case)", () => {
    const input = policy(
      [{ target: ADDR_A, selectors: [selector(SEL_X, 10n ** 18n)] }],
      { dailySpendWeiCap: 0n },
    );
    expect(computeAggregateCapNote(input).note).toBeNull();
  });

  it("returns null when sum of per-call caps fits inside the daily cap", () => {
    const input = policy(
      [
        {
          target: ADDR_A,
          selectors: [
            selector(SEL_X, 3n * 10n ** 17n), // 0.3 STT
            selector(SEL_Y, 4n * 10n ** 17n), // 0.4 STT — sum 0.7 < 1
          ],
        },
      ],
      { dailySpendWeiCap: 10n ** 18n },
    );
    expect(computeAggregateCapNote(input).note).toBeNull();
  });

  it("returns a note with both numbers when sum exceeds daily cap", () => {
    const input = policy(
      [
        {
          target: ADDR_A,
          selectors: [
            selector(SEL_X, 6n * 10n ** 17n), // 0.6 STT
            selector(SEL_Y, 7n * 10n ** 17n), // 0.7 STT — sum 1.3 > 1
          ],
        },
      ],
      { dailySpendWeiCap: 10n ** 18n },
    );
    const { note } = computeAggregateCapNote(input);
    expect(note).not.toBeNull();
    expect(note).toContain("1.3 STT");
    expect(note).toContain("1 STT");
    expect(note).toMatch(/Only a subset of payable calls can succeed per day/);
  });
});

describe("policyLifetimeState", () => {
  const NOW = 2_000_000_000n;

  it("treats legacy expiresAt=0 as expired regardless of nowSec", () => {
    expect(
      policyLifetimeState({ paused: false, expiresAt: 0n }, NOW),
    ).toEqual({ isPaused: false, isExpired: true });
  });

  it("treats expiresAt in the past as expired", () => {
    expect(
      policyLifetimeState({ paused: false, expiresAt: NOW - 1n }, NOW),
    ).toEqual({ isPaused: false, isExpired: true });
  });

  it("treats expiresAt == now as expired (inclusive)", () => {
    expect(
      policyLifetimeState({ paused: false, expiresAt: NOW }, NOW),
    ).toEqual({ isPaused: false, isExpired: true });
  });

  it("future expiry, not paused -> neither", () => {
    expect(
      policyLifetimeState({ paused: false, expiresAt: NOW + 1n }, NOW),
    ).toEqual({ isPaused: false, isExpired: false });
  });

  it("paused + future expiry -> only paused", () => {
    expect(
      policyLifetimeState({ paused: true, expiresAt: NOW + 1n }, NOW),
    ).toEqual({ isPaused: true, isExpired: false });
  });
});

describe("computeDestructive", () => {
  const baseTargets = [
    {
      target: ADDR_A,
      selectors: [selector(SEL_X, 10n ** 18n)],
    },
  ];
  const before = policy(baseTargets, { dailySpendWeiCap: 10n ** 18n });

  it("returns false for identical policies", () => {
    expect(computeDestructive(before, before)).toBe(false);
  });

  it("returns false when caps are RAISED and targets/selectors only added", () => {
    const after = policy(
      [
        {
          target: ADDR_A,
          selectors: [
            selector(SEL_X, 2n * 10n ** 18n),
            selector(SEL_Y, 5n * 10n ** 17n),
          ],
        },
        { target: ADDR_B, selectors: [selector(SEL_X, 10n ** 18n)] },
      ],
      { dailySpendWeiCap: 2n * 10n ** 18n },
    );
    expect(computeDestructive(before, after)).toBe(false);
  });

  it("flags lowered daily cap", () => {
    const after = policy(baseTargets, { dailySpendWeiCap: 5n * 10n ** 17n });
    expect(computeDestructive(before, after)).toBe(true);
  });

  it("flags a removed target", () => {
    const after = policy([], { dailySpendWeiCap: 10n ** 18n });
    expect(computeDestructive(before, after)).toBe(true);
  });

  it("flags a removed selector", () => {
    const before2 = policy(
      [
        {
          target: ADDR_A,
          selectors: [selector(SEL_X, 10n ** 18n), selector(SEL_Y, 10n ** 18n)],
        },
      ],
      { dailySpendWeiCap: 10n ** 18n },
    );
    const after = policy(
      [{ target: ADDR_A, selectors: [selector(SEL_X, 10n ** 18n)] }],
      { dailySpendWeiCap: 10n ** 18n },
    );
    expect(computeDestructive(before2, after)).toBe(true);
  });

  it("flags a lowered per-call cap", () => {
    const after = policy(
      [{ target: ADDR_A, selectors: [selector(SEL_X, 5n * 10n ** 17n)] }],
      { dailySpendWeiCap: 10n ** 18n },
    );
    expect(computeDestructive(before, after)).toBe(true);
  });

  it("case-only address differences are not removals", () => {
    const after = policy(
      [
        {
          target: ADDR_A.toLowerCase() as `0x${string}`,
          selectors: [selector(SEL_X, 10n ** 18n)],
        },
      ],
      { dailySpendWeiCap: 10n ** 18n },
    );
    expect(computeDestructive(before, after)).toBe(false);
  });
});
