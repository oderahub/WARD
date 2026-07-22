import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintPolicy, type LintRule } from "../src/cmd/lint.js";

const TARGET = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const POLICY_ID = `0x${"ab".repeat(32)}` as const;
const FUTURE = "2026-12-31T23:59:59.000Z";
const PAST = "2025-01-01T00:00:00.000Z";

const ABI = [
  { type: "function", name: "pay", inputs: [], stateMutability: "payable" },
  { type: "function", name: "mutate", inputs: [{ name: "value", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "owner", inputs: [], stateMutability: "view" },
  { type: "function", name: "withdraw", inputs: [{ name: "to", type: "address" }], stateMutability: "nonpayable" },
];

describe("sentry lint", () => {
  let dir: string;
  let policyPath: string;
  let abiPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-lint-"));
    policyPath = join(dir, "POLICY.md");
    abiPath = join(dir, "abi.json");
    writeFileSync(abiPath, JSON.stringify(ABI));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writePolicy = (entries: string, extra = "") => {
    writeFileSync(
      policyPath,
      `# Policy
\`\`\`policy
version: "0.1"
dailySpendWeiCap: "0 ether"
expiresAt: "${FUTURE}"
targets:
  - target: "${TARGET}"
    selectors:
${entries}${extra}
\`\`\`
`,
    );
  };

  const rules = async () => (await lintPolicy(policyPath, { abi: abiPath, now: Date.parse("2026-01-01T00:00:00Z") })).map((d) => d.rule);

  it("fires dailyCapZeroWithPayable for payable selectors under zero daily cap", async () => {
    writePolicy(entry("pay()", "IMMEDIATE", 0));
    expect(await rules()).toContain("dailyCapZeroWithPayable");
  });

  it("does not fire dailyCapZeroWithPayable for nonpayable selectors", async () => {
    writePolicy(entry("mutate(uint256)", "IMMEDIATE", 0));
    expect(await rules()).not.toContain("dailyCapZeroWithPayable");
  });

  it("fires vetoRequiredWithoutOwner when on-chain owner is zero", async () => {
    writePolicy(entry("withdraw(address)", "VETO_REQUIRED", 0));
    const diagnostics = await lintPolicy(policyPath, {
      abi: abiPath,
      oracle: TARGET,
      policyId: POLICY_ID,
      policyOwner: async () => ZERO,
      now: Date.parse("2026-01-01T00:00:00Z"),
    });
    expect(diagnostics.find((d) => d.rule === "vetoRequiredWithoutOwner")?.severity).toBe("error");
  });

  it("does not fire vetoRequiredWithoutOwner when a policy owner exists", async () => {
    writePolicy(entry("withdraw(address)", "VETO_REQUIRED", 0));
    const diagnostics = await lintPolicy(policyPath, {
      abi: abiPath,
      oracle: TARGET,
      policyId: POLICY_ID,
      policyOwner: async () => TARGET,
      now: Date.parse("2026-01-01T00:00:00Z"),
    });
    expect(diagnostics.map((d) => d.rule)).not.toContain("vetoRequiredWithoutOwner");
  });

  it("fires targetHasNoCode when lookup returns 0x", async () => {
    writePolicy(entry("mutate(uint256)", "IMMEDIATE", 0));
    const diagnostics = await lintPolicy(policyPath, { getCode: async () => "0x", now: Date.parse("2026-01-01T00:00:00Z") });
    expect(diagnostics.map((d) => d.rule)).toContain("targetHasNoCode");
  });

  it("does not fire targetHasNoCode when bytecode exists", async () => {
    writePolicy(entry("mutate(uint256)", "IMMEDIATE", 0));
    const diagnostics = await lintPolicy(policyPath, { getCode: async () => "0x6000", now: Date.parse("2026-01-01T00:00:00Z") });
    expect(diagnostics.map((d) => d.rule)).not.toContain("targetHasNoCode");
  });

  it("fires selectorNotInAbi with a closest-match suggestion", async () => {
    writePolicy(entry("mutatee(uint256)", "IMMEDIATE", 0));
    const diagnostics = await lintPolicy(policyPath, { abi: abiPath, now: Date.parse("2026-01-01T00:00:00Z") });
    const diagnostic = diagnostics.find((d) => d.rule === "selectorNotInAbi");
    expect(diagnostic?.message).toContain("mutate(uint256)");
  });

  it("does not fire selectorNotInAbi for ABI selectors", async () => {
    writePolicy(entry("mutate(uint256)", "IMMEDIATE", 0));
    expect(await rules()).not.toContain("selectorNotInAbi");
  });

  it("fires immediateWithDelay", async () => {
    writePolicy(entry("mutate(uint256)", "IMMEDIATE", 10));
    expect(await rules()).toContain("immediateWithDelay");
  });

  it("does not fire immediateWithDelay when delay is zero", async () => {
    writePolicy(entry("mutate(uint256)", "IMMEDIATE", 0));
    expect(await rules()).not.toContain("immediateWithDelay");
  });

  it("fires delayedWithZeroDelay", async () => {
    writePolicy(entry("mutate(uint256)", "DELAYED", 0));
    expect(await rules()).toContain("delayedWithZeroDelay");
  });

  it("does not fire delayedWithZeroDelay when delay is positive", async () => {
    writePolicy(entry("mutate(uint256)", "DELAYED", 300));
    expect(await rules()).not.toContain("delayedWithZeroDelay");
  });

  it("fires viewFunctionGated for view functions", async () => {
    writePolicy(entry("owner()", "IMMEDIATE", 0));
    expect(await rules()).toContain("viewFunctionGated");
  });

  it("does not fire viewFunctionGated for mutating functions", async () => {
    writePolicy(entry("mutate(uint256)", "IMMEDIATE", 0));
    expect(await rules()).not.toContain("viewFunctionGated");
  });

  it("fires policyExpired", async () => {
    writeFileSync(
      policyPath,
      `\`\`\`policy
version: "0.1"
dailySpendWeiCap: "0 ether"
expiresAt: "${PAST}"
targets:
  - target: "${TARGET}"
    selectors:
${entry("mutate(uint256)", "IMMEDIATE", 0)}
\`\`\`
`,
    );
    expect(await rules()).toContain("policyExpired");
  });

  it("promotes warn-only rules through failOn", async () => {
    writePolicy(entry("owner()", "IMMEDIATE", 0));
    const diagnostics = await lintPolicy(policyPath, {
      abi: abiPath,
      failOn: ["viewFunctionGated" satisfies LintRule],
      now: Date.parse("2026-01-01T00:00:00Z"),
    });
    expect(diagnostics.find((d) => d.rule === "viewFunctionGated")?.severity).toBe("error");
  });
});

function entry(selector: string, tier: string, delay: number): string {
  return `      - selector: "${selector}"
        tier: ${tier}
        valueCapPerCall: "0 ether"
        delaySeconds: ${delay}
`;
}
