import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("@sentry-somnia/vite-plugin export shape", () => {
  it("exports a default plugin factory from src/index.ts", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.default).toBe("function");
    const plugin = mod.default();
    expect(plugin.name).toBe("sentry-policy-embed");
    expect(plugin.enforce).toBe("pre");
    expect(typeof plugin.transform).toBe("function");
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
    const dts = readFileSync(resolve(root, "dist/index.d.ts"), "utf8");
    expect(dts).toContain("sentryPolicy");
    expect(dts).toContain("Plugin");
    expect(dts).toContain("EvalPolicy");
  });
});
