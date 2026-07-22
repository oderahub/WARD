import { describe, it, expect } from "vitest";
import { compilePolicy } from "../src/policy-compiler.js";
import { TIER_NAMES } from "../src/types.js";
import { toFunctionSelector } from "viem";

const ADDR_USDSO = "0x1111111111111111111111111111111111111111";
const ADDR_DEX = "0x2222222222222222222222222222222222222222";

// Policy lifetime is capped at 5y; pick a fixture timestamp 2y out so these
// tests don't drift into "exceeds 5y" failures over time. Keep both an ISO
// and a unix-seconds form because the compiler accepts either.
const EXP_DATE = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000);
const EXP_ISO = EXP_DATE.toISOString();
const EXP_UNIX = Math.floor(EXP_DATE.getTime() / 1000);

function md(yaml: string, tag = "policy"): string {
  return `# POLICY.md\n\n\`\`\`${tag}\n${yaml}\n\`\`\`\n`;
}

describe("compilePolicy", () => {
  it("compiles a minimal policy with one target one selector", () => {
    const out = compilePolicy(md(`
version: "0.1"
expiresAt: "${EXP_ISO}"
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`));
    expect(out.targets).toHaveLength(1);
    expect(out.targets[0].target.toLowerCase()).toBe(ADDR_USDSO.toLowerCase());
    expect(out.targets[0].selectors).toHaveLength(1);
    expect(out.targets[0].selectors[0].selector).toBe(toFunctionSelector("approve(address,uint256)"));
    expect(out.targets[0].selectors[0].tier).toBe(TIER_NAMES.IMMEDIATE);
    expect(out.expiresAt).toBeGreaterThan(0n);
    expect(out.paused).toBe(false);
  });

  it("accepts a raw 0x… selector as well as a signature", () => {
    const out = compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "0xa9059cbb"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`));
    expect(out.targets[0].selectors[0].selector).toBe("0xa9059cbb");
  });

  it("parses ether suffix in dailySpendWeiCap and valueCapPerCall", () => {
    const out = compilePolicy(md(`
version: "0.1"
dailySpendWeiCap: "1 ether"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0.5 ether"
        tier: IMMEDIATE
`));
    expect(out.dailySpendWeiCap).toBe(10n ** 18n);
    expect(out.targets[0].selectors[0].valueCapPerCall).toBe(5n * 10n ** 17n);
  });

  it("compiles two targets each with multiple selectors", () => {
    const out = compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
maxSlippageBps: 50
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
  - target: "${ADDR_DEX}"
    selectors:
      - selector: "placeOrder(address,address,uint256,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
      - selector: "cancelOrder(bytes32)"
        valueCapPerCall: "0"
        tier: DELAYED
        delaySeconds: 30
`));
    expect(out.targets).toHaveLength(2);
    expect(out.targets[1].selectors).toHaveLength(2);
    expect(out.targets[1].selectors[1].tier).toBe(TIER_NAMES.DELAYED);
    expect(out.targets[1].selectors[1].delaySeconds).toBe(30);
    expect(out.maxSlippageBps).toBe(50);
  });

  it("falls back to untagged fence when no `policy` block exists", () => {
    const out = compilePolicy(`# notes\n\`\`\`\nversion: "0.1"\nexpiresAt: ${EXP_UNIX}\ntargets:\n  - target: "${ADDR_USDSO}"\n    selectors:\n      - selector: "approve(address,uint256)"\n        valueCapPerCall: "0"\n        tier: IMMEDIATE\n\`\`\``);
    expect(out.targets).toHaveLength(1);
  });

  it("rejects missing fenced block", () => {
    expect(() => compilePolicy("# nothing here")).toThrow(/no fenced/);
  });

  it("rejects schema-invalid YAML (unknown top-level key)", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
nonsense: true
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`))
    ).toThrow(/schema validation failed/);
  });

  it("rejects an invalid tier", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: BOGUS
`))
    ).toThrow(/schema validation failed/);
  });

  it("rejects delay on IMMEDIATE tier (normalize-time check)", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
        delaySeconds: 30
`))
    ).toThrow(/IMMEDIATE.*delaySeconds/);
  });

  it("rejects delay on VETO_REQUIRED tier", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: VETO_REQUIRED
        delaySeconds: 30
`))
    ).toThrow(/VETO_REQUIRED.*delaySeconds/);
  });

  it("rejects malformed target address", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "0xnothex"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`))
    ).toThrow(/schema validation failed/);
  });

  it("rejects perCallCap (removed alias)", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        perCallCap: "0.5 ether"
        tier: IMMEDIATE
`))
    ).toThrow(/schema validation failed/);
  });

  it("rejects unparseable expiresAt", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: "totally-not-a-date"
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`))
    ).toThrow(/cannot parse expiresAt/);
  });

  // Cap published-policy lifetime at 5 years out and refuse uint64 overflow.
  it("rejects expiresAt more than 5 years in the future", () => {
    const sixYearsOut = Math.floor(Date.now() / 1000) + 6 * 365 * 24 * 60 * 60;
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${sixYearsOut}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`))
    ).toThrow(/more than 5 years/);
  });

  it("rejects expiresAt beyond uint64 range", () => {
    const beyondU64 = (1n << 64n).toString();
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: "${beyondU64}"
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`))
    ).toThrow(/uint64 range/);
  });

  // valueCapPerCall must be explicit per selector.
  it("rejects a selector that omits valueCapPerCall", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        tier: IMMEDIATE
`))
    ).toThrow(/valueCapPerCall is required/);
  });

  // Dedupe by target and by computed bytes4 selector.
  it("rejects duplicate target addresses (case-insensitive)", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
  - target: "${ADDR_USDSO.toUpperCase().replace("0X", "0x")}"
    selectors:
      - selector: "transfer(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`))
    ).toThrow(/duplicate target/);
  });

  it("rejects duplicate selectors within a target (same bytes4)", () => {
    // approve(address,uint256) has bytes4 0x095ea7b3 — spell it both ways.
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
      - selector: "0x095ea7b3"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`))
    ).toThrow(/duplicate selector/);
  });

  // Plan #12 partial: SDK compiler must reject the zero-address placeholder
  // with the same friendly message as the dashboard. Otherwise a CLI user
  // bypassing the dashboard could ship a policy whose target every call would
  // miss (NO_TARGET on the contract side).
  it("rejects zero-address target with friendly placeholder message", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "0x0000000000000000000000000000000000000000"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`))
    ).toThrow(/zero address \(placeholder\)/);
  });

  // NEW MED — ABI-width bounds. uint32_max passes; +1 fails. The cap exists
  // so a draft above the on-chain field width can't silently truncate at the
  // contract boundary.
  it("accepts delaySeconds at uint32 max", () => {
    const out = compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: DELAYED
        delaySeconds: 4294967295
`));
    expect(out.targets[0].selectors[0].delaySeconds).toBe(4294967295);
  });

  it("rejects delaySeconds above uint32 max", () => {
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: DELAYED
        delaySeconds: 4294967296
`))
    ).toThrow(/uint32 max/);
  });

  it("accepts valueCapPerCall at uint256 max", () => {
    const uint256MaxStr = ((1n << 256n) - 1n).toString();
    const out = compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "${uint256MaxStr}"
        tier: IMMEDIATE
`));
    expect(out.targets[0].selectors[0].valueCapPerCall).toBe((1n << 256n) - 1n);
  });

  it("rejects valueCapPerCall above uint256 max", () => {
    const overStr = ((1n << 256n)).toString();
    expect(() =>
      compilePolicy(md(`
version: "0.1"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "${overStr}"
        tier: IMMEDIATE
`))
    ).toThrow(/uint256 max/);
  });

  it("rejects dailySpendWeiCap above uint256 max", () => {
    const overStr = ((1n << 256n)).toString();
    expect(() =>
      compilePolicy(md(`
version: "0.1"
dailySpendWeiCap: "${overStr}"
expiresAt: ${EXP_UNIX}
targets:
  - target: "${ADDR_USDSO}"
    selectors:
      - selector: "approve(address,uint256)"
        valueCapPerCall: "0"
        tier: IMMEDIATE
`))
    ).toThrow(/dailySpendWeiCap exceeds uint256 max/);
  });
});
