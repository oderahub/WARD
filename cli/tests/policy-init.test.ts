import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePolicyStarter, type PolicyProfile } from "../src/cmd/policy-init.js";

const TARGET = "0x1111111111111111111111111111111111111111";
const EXPIRES = "2026-12-31T23:59:59.000Z";

const ABIS = {
  counter: [
    { type: "function", name: "count", inputs: [], stateMutability: "view" },
    { type: "function", name: "increment", inputs: [], stateMutability: "nonpayable" },
    { type: "function", name: "setCount", inputs: [{ name: "value", type: "uint256" }], stateMutability: "nonpayable" },
  ],
  treasury: [
    { type: "function", name: "deposit", inputs: [], stateMutability: "payable" },
    {
      type: "function",
      name: "withdraw",
      inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "transferOwnership",
      inputs: [{ name: "newOwner", type: "address" }],
      stateMutability: "nonpayable",
    },
  ],
  router: [
    {
      type: "function",
      name: "getQuote",
      inputs: [{ name: "amountIn", type: "uint256" }],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "swapExactETHForTokens",
      inputs: [{ name: "minOut", type: "uint256" }, { name: "to", type: "address" }],
      stateMutability: "payable",
    },
    {
      type: "function",
      name: "upgradeTo",
      inputs: [{ name: "implementation", type: "address" }],
      stateMutability: "nonpayable",
    },
  ],
} as const;

const PROFILES: PolicyProfile[] = ["strict", "balanced", "aggressive"];

describe("ward policy:init", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ward-policy-init-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const abiName of Object.keys(ABIS) as Array<keyof typeof ABIS>) {
    for (const profile of PROFILES) {
      it(`matches fixture for ${abiName} ${profile}`, () => {
        const abiPath = join(dir, `${abiName}.json`);
        writeFileSync(abiPath, JSON.stringify({ abi: ABIS[abiName] }));

        const got = generatePolicyStarter({ abi: abiPath, target: TARGET, profile, expires: EXPIRES });
        const expected = readFileSync(join("tests/fixtures/policy-init", `${abiName}.${profile}.md`), "utf8");

        expect(got).toBe(expected);
      });
    }
  }

  it("rejects an ABI with no mutable functions", () => {
    const abiPath = join(dir, "view-only.json");
    writeFileSync(abiPath, JSON.stringify([{ type: "function", name: "totalSupply", inputs: [], stateMutability: "view" }]));

    expect(() => generatePolicyStarter({ abi: abiPath, target: TARGET, expires: EXPIRES })).toThrow(/no non-view/);
  });
});
