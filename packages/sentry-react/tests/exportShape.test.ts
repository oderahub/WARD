import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("@sentry-somnia/react export shape", () => {
  it("exports the public API surface from src/index.ts", async () => {
    const mod = await import("../src/index.js");
    const names = Object.keys(mod).sort();
    expect(names).toEqual(
      [
        "SentryPreflightRejectedError",
        "createSentryGuardedWrite",
        "planSentryAction",
        "useSentryActionPlan",
        "useSentryGuardedWrite",
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
    expect(indexDts).toContain("useSentryGuardedWrite");
    expect(indexDts).toContain("createSentryGuardedWrite");
    expect(indexDts).toContain("SentryPreflightRejectedError");
    expect(indexDts).toContain('export * from "./useSentryActionPlan.js"');

    const planDts = readFileSync(resolve(root, "dist/useSentryActionPlan.d.ts"), "utf8");
    expect(planDts).toContain("useSentryActionPlan");
    expect(planDts).toContain("planSentryAction");
    expect(planDts).toContain("SentryActionPlan");
  });
});
