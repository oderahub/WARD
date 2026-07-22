import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePolicy, evalPolicyFromInput, type EvalPolicy } from "@ward/sdk";
import wardPolicy from "../src/index.js";

function evaluateDefaultExport(code: string): EvalPolicy {
  return new Function(`${code.replace("export default policy;", "return policy;")}`)();
}

describe("wardPolicy", () => {
  it("ignores modules without ?eval-policy", async () => {
    const plugin = wardPolicy();
    const result = await plugin.transform?.call({} as never, "x", "/tmp/POLICY.md");
    expect(result).toBeNull();
  });

  it("transforms POLICY.md?eval-policy into a default EvalPolicy export", async () => {
    const markdown = readFileSync(
      resolve("tests/fixtures/POLICY.md"),
      "utf8",
    );
    const plugin = wardPolicy();
    const result = await plugin.transform?.call(
      {} as never,
      markdown,
      "/tmp/POLICY.md?eval-policy",
    );

    expect(result).toMatchObject({ map: null });
    const code = typeof result === "object" && result ? result.code : "";
    const actual = evaluateDefaultExport(code);
    const expected = evalPolicyFromInput(compilePolicy(markdown));

    expect(actual).toEqual(expected);
  });

  it("preserves bigint fields as bigint literals in emitted JS", async () => {
    const markdown = readFileSync(
      resolve("tests/fixtures/POLICY.md"),
      "utf8",
    );
    const plugin = wardPolicy();
    const result = await plugin.transform?.call(
      {} as never,
      markdown,
      "/tmp/POLICY.md?raw&eval-policy",
    );
    const code = typeof result === "object" && result ? result.code : "";

    expect(code).toContain('"dailySpendWeiCap": 1000000000000000000n');
    expect(code).toContain('"0x60fe47b1": 500000000000000000n');
  });
});
