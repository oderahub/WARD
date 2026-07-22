import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("@ward/react export shape", () => {
  it("exports the public API surface from src/index.ts", async () => {
    const mod = await import("../src/index.js");
    const names = Object.keys(mod).sort();
    expect(names).toEqual(
      [
        "WardPreflightRejectedError",
        "createWardGuardedWrite",
        "planWardAction",
        "useWardActionPlan",
        "useWardGuardedWrite",
      ].sort(),
    );
  });

  it("emits dist/index.js and dist/index.d.ts at the package root", () => {
    const root = resolve(__dirname, "..");
    expect(existsSync(resolve(root, "dist/index.js"))).toBe(true);
    expect(existsSync(resolve(root, "dist/index.d.ts"))).toBe(true);
  });

  it("does not emit dist/packages/** or dist/sdk/** subtrees", () => {
    const root = resolve(__dirname, "..");
    expect(existsSync(resolve(root, "dist/packages"))).toBe(false);
    expect(existsSync(resolve(root, "dist/sdk"))).toBe(false);
  });

  it("matches the public type-declaration shape", () => {
    const root = resolve(__dirname, "..");
    const indexDts = readFileSync(resolve(root, "dist/index.d.ts"), "utf8");
    expect(indexDts).toContain("useWardGuardedWrite");
    expect(indexDts).toContain("createWardGuardedWrite");
    expect(indexDts).toContain("WardPreflightRejectedError");
    expect(indexDts).toContain('export * from "./useWardActionPlan.js"');

    const planDts = readFileSync(resolve(root, "dist/useWardActionPlan.d.ts"), "utf8");
    expect(planDts).toContain("useWardActionPlan");
    expect(planDts).toContain("planWardAction");
    expect(planDts).toContain("WardActionPlan");
  });
});
