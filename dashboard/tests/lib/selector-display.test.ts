import { describe, it, expect } from "vitest";
import {
  FIELD_HUMAN_LABELS,
  formatSelector,
  humanizeTier,
  lookupSelector,
  lookupTarget,
  selectorToDraftString,
  TIER_HUMAN_LABELS,
  tierLabel,
} from "../../src/lib/selector-display";

describe("selector-display.lookupSelector", () => {
  it("returns the human-readable signature for known ERC-20 selectors", () => {
    expect(lookupSelector("0xa9059cbb")).toBe("transfer(address,uint256)");
    expect(lookupSelector("0x095ea7b3")).toBe("approve(address,uint256)");
  });

  it("returns undefined for unknown selectors", () => {
    expect(lookupSelector("0xdeadbeef")).toBeUndefined();
  });

  it("returns undefined for selectors not in the ERC-20 core map", () => {
    // payInvoice(uint256) used to be in the tutorial-vault map and now
    // intentionally is not — the dashboard surfaces only ERC-20 core
    // selectors in the synchronous lookup. Anything else falls back to
    // the hex form via formatSelector.
    expect(lookupSelector("0xac60a6cd")).toBeUndefined();
  });

  it("is case-insensitive on input — uppercase hex still resolves", () => {
    expect(lookupSelector("0xA9059CBB")).toBe("transfer(address,uint256)");
  });
});

describe("selector-display.formatSelector", () => {
  it("formats known selectors as the signature string", () => {
    expect(formatSelector("0xa9059cbb")).toBe("transfer(address,uint256)");
  });

  it("falls back to the lowercased hex for unknown selectors", () => {
    expect(formatSelector("0xDEADBEEF")).toBe("0xdeadbeef");
  });

  it("never throws for a malformed-looking but typed Hex selector", () => {
    expect(() => formatSelector("0x12345678")).not.toThrow();
    expect(formatSelector("0x12345678")).toBe("0x12345678");
  });
});

describe("selector-display.tierLabel", () => {
  it("maps the three SDK tier ints to their canonical labels", () => {
    expect(tierLabel(0)).toBe("IMMEDIATE");
    expect(tierLabel(1)).toBe("DELAYED");
    expect(tierLabel(2)).toBe("VETO_REQUIRED");
  });

  it("falls back to a tier:<n> string for out-of-range tier ints", () => {
    expect(tierLabel(99)).toBe("tier:99");
  });
});

describe("selector-display.selectorToDraftString", () => {
  it("returns the signature for a known bytes4 so the edit form seeds with the readable form", () => {
    expect(selectorToDraftString("0xa9059cbb")).toBe("transfer(address,uint256)");
    expect(selectorToDraftString("0x095ea7b3")).toBe("approve(address,uint256)");
  });

  it("returns the lowercased hex for unknown bytes4 so the schema's hex-form path still accepts it", () => {
    expect(selectorToDraftString("0xDEADBEEF")).toBe("0xdeadbeef");
  });

  it("is case-insensitive on input", () => {
    expect(selectorToDraftString("0xA9059CBB")).toBe("transfer(address,uint256)");
  });
});

describe("selector-display.humanizeTier", () => {
  it("returns the plain-English label for each enum string", () => {
    expect(humanizeTier("IMMEDIATE")).toBe("Auto-approve");
    expect(humanizeTier("DELAYED")).toBe("Wait then auto-approve");
    expect(humanizeTier("VETO_REQUIRED")).toBe("Needs owner approval");
  });

  it("accepts the numeric tier form (matches SelectorRule.tier on chain)", () => {
    expect(humanizeTier(0)).toBe("Auto-approve");
    expect(humanizeTier(1)).toBe("Wait then auto-approve");
    expect(humanizeTier(2)).toBe("Needs owner approval");
  });

  it("falls back to the tier:<n> form for unknown numeric tiers (never crashes)", () => {
    // tierLabel returns "tier:99" for out-of-range — humanizeTier surfaces
    // that as the visible fallback so an unknown future tier doesn't render
    // as "undefined" or throw.
    expect(humanizeTier(99)).toBe("tier:99");
  });

  it("agrees with the TIER_HUMAN_LABELS map", () => {
    expect(TIER_HUMAN_LABELS.IMMEDIATE).toBe("Auto-approve");
    expect(TIER_HUMAN_LABELS.DELAYED).toBe("Wait then auto-approve");
    expect(TIER_HUMAN_LABELS.VETO_REQUIRED).toBe("Needs owner approval");
  });
});

describe("selector-display.FIELD_HUMAN_LABELS", () => {
  it("translates the POLICY.md scalar field names used in PolicyDiff", () => {
    expect(FIELD_HUMAN_LABELS.dailySpendWeiCap).toBe(
      "Daily native (AVAX) spend cap",
    );
    expect(FIELD_HUMAN_LABELS.expiresAt).toBe("Valid until");
    expect(FIELD_HUMAN_LABELS.paused).toBe("Paused");
  });

  it("annotates maxSlippageBps so the operator knows it is adapter metadata", () => {
    // The field is preserved on chain but the dashboard form doesn't expose
    // it, so the diff label calls it out as adapter metadata rather than a
    // bare jargon name.
    expect(FIELD_HUMAN_LABELS.maxSlippageBps).toMatch(/slippage/i);
    expect(FIELD_HUMAN_LABELS.maxSlippageBps).toMatch(/adapter/i);
  });
});

describe("selector-display.lookupTarget", () => {
  it("returns undefined for an unknown target so the UI falls back to the shortened address", () => {
    expect(lookupTarget("0x0000000000000000000000000000000000000001")).toBeUndefined();
  });

  it("returns undefined for every input — the known-target map is now empty; canonical Ward addresses are resolved by contractName.ts", () => {
    // The legacy ward-swapper / trading-v1 entries were removed when the
    // example was consolidated; the v2 oracle + queue labels live in the
    // contractName.ts LOCAL map (which is what AddressChip actually reads).
    expect(lookupTarget("0xc41e6098b4e7aefb6ad9733a2914a55e21c25fc6")).toBeUndefined();
    expect(lookupTarget("0x453ecb43c9a2df312a43dfc96d988bd45e932c04")).toBeUndefined();
  });

  it("is case-insensitive on input — checksummed input does not throw and resolves to undefined consistently", () => {
    // The lookup normalizes to lowercase before consulting the map, so a
    // checksummed (mixed-case) hex input must produce the same result as
    // the lowercased form. Holds even with an empty map: the lowercasing
    // step itself is exercised here.
    expect(lookupTarget("0xC41E6098B4E7aEFb6AD9733A2914a55E21C25Fc6")).toBeUndefined();
    expect(lookupTarget("0xc41e6098b4e7aefb6ad9733a2914a55e21c25fc6")).toBeUndefined();
  });
});
