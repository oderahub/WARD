import { describe, it, expect } from "vitest";
import { ownerIndexThrottleKey } from "../../src/lib/owner-index-throttle";

describe("ownerIndexThrottleKey", () => {
  it("lowercases oracle and owner so casing differences map to the same slot", () => {
    const upper = ownerIndexThrottleKey(
      43113,
      "0xABCDEF0000000000000000000000000000000001",
      "0xCAFEBABE00000000000000000000000000000002",
    );
    const lower = ownerIndexThrottleKey(
      43113,
      "0xabcdef0000000000000000000000000000000001",
      "0xcafebabe00000000000000000000000000000002",
    );
    expect(upper).toBe(lower);
  });

  it("includes the chainId so the same (oracle, owner) on different chains keeps separate slots", () => {
    const oracle = "0xabcdef0000000000000000000000000000000001";
    const owner = "0xcafebabe00000000000000000000000000000002";
    expect(ownerIndexThrottleKey(43113, oracle, owner)).not.toBe(
      ownerIndexThrottleKey(1, oracle, owner),
    );
  });

  it("changes when the oracle changes, so an oracle swap is not falsely suppressed", () => {
    const owner = "0xcafebabe00000000000000000000000000000002";
    expect(
      ownerIndexThrottleKey(43113, "0xabcdef0000000000000000000000000000000001", owner),
    ).not.toBe(
      ownerIndexThrottleKey(43113, "0x1111111111111111111111111111111111111111", owner),
    );
  });

  it("changes when the owner changes, so a wallet swap is not falsely suppressed", () => {
    const oracle = "0xabcdef0000000000000000000000000000000001";
    expect(
      ownerIndexThrottleKey(43113, oracle, "0xcafebabe00000000000000000000000000000002"),
    ).not.toBe(
      ownerIndexThrottleKey(43113, oracle, "0xdeadbeef00000000000000000000000000000003"),
    );
  });

  it("uses colon as the separator across all three components", () => {
    expect(
      ownerIndexThrottleKey(
        43113,
        "0xAAaa000000000000000000000000000000000001",
        "0xBBbb000000000000000000000000000000000002",
      ),
    ).toBe(
      "43113:0xaaaa000000000000000000000000000000000001:0xbbbb000000000000000000000000000000000002",
    );
  });
});
