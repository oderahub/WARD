import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compilePolicy } from "@ward/sdk";

import { validateName } from "../src/name.js";
import { scaffold, nextStepsBlock } from "../src/scaffold.js";
import { renderTemplate } from "../src/templates/index.js";

describe("validateName", () => {
  it.each([
    "",
    "  ",
    ".",
    "..",
    "/abs",
    "./rel",
    "../parent",
    "a/b",
    "C:\\windows",
    "9starts-with-digit",
    "has space",
    "weird!chars",
  ])("rejects %j", (bad) => {
    expect(() => validateName(bad)).toThrow();
  });

  it("derives PascalCase contract + kebab-case dir from a kebab name", () => {
    const v = validateName("my-agent");
    expect(v.dirName).toBe("my-agent");
    expect(v.contractName).toBe("MyAgent");
  });

  it("derives kebab dir from a Pascal name", () => {
    const v = validateName("MyAgent");
    expect(v.dirName).toBe("my-agent");
    expect(v.contractName).toBe("MyAgent");
  });

  it("accepts snake_case + collapses to a single kebab segment", () => {
    const v = validateName("my_cool_agent");
    expect(v.dirName).toBe("my-cool-agent");
    expect(v.contractName).toBe("MyCoolAgent");
  });
});

describe("scaffold — greenfield", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "create-ward-agent-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("materializes the expected file set", () => {
    const res = scaffold({ name: "my-agent", template: "greenfield", cwd: dir });
    const root = res.projectRoot;
    for (const expected of [
      "foundry.toml",
      ".gitignore",
      "src/MyAgent.sol",
      "src/MyAgentTarget.sol",
      "script/Deploy.s.sol",
      "script/Bind.s.sol",
      "POLICY.md",
      "README.md",
    ]) {
      expect(existsSync(join(root, expected)), `${expected} not written`).toBe(true);
    }
  });

  it("MyAgent.sol derives from WardAgentBase and gates via the wardGuarded modifier", () => {
    const res = scaffold({ name: "my-agent", template: "greenfield", cwd: dir });
    const sol = readFileSync(join(res.projectRoot, "src/MyAgent.sol"), "utf8");
    expect(sol).toContain("is WardAgentBase");
    // The greenfield entrypoint should be modifier-gated, not gated through
    // an internal `_gate(...)` helper. The modifier is now 2-arg —
    // `wardGuarded(bytes4 selector, uint256 value)` — and checks the AGENT's
    // OWN selector (entrypoint-policy model). The first arg MUST be a `bytes4`
    // (`.selector` on a function reference) — `abi.encodeCall(...)` returns
    // `bytes` and fails to compile.
    expect(sol).toContain("wardGuarded(");
    expect(sol).toContain("this.tryDispatch.selector");
    // Regression: must not gate on the downstream target's selector and must
    // not pass a `target` arg as the first modifier argument.
    expect(sol).not.toContain(".act.selector");
    expect(sol).not.toMatch(/wardGuarded\(\s*target\s*,/);
    expect(sol).not.toContain("_gate(");
    expect(sol).not.toContain("abi.encodeCall(");
    // Sanity: the file should import the abstract base too.
    expect(sol).toMatch(/import\s+["']ward\/integration\/WardAgentBase\.sol["']/);
  });

  it("Deploy.s.sol passes the late-binding POLICY_ID env opt and Bind.s.sol calls setPolicyId", () => {
    const res = scaffold({ name: "my-agent", template: "greenfield", cwd: dir });
    const deploy = readFileSync(join(res.projectRoot, "script/Deploy.s.sol"), "utf8");
    const bind = readFileSync(join(res.projectRoot, "script/Bind.s.sol"), "utf8");
    expect(deploy).toContain('vm.envOr("POLICY_ID", bytes32(0))');
    expect(bind).toContain("setPolicyId(policyId)");
  });

  it("generated POLICY.md compiles via the SDK", () => {
    const res = scaffold({ name: "my-agent", template: "greenfield", cwd: dir });
    const md = readFileSync(join(res.projectRoot, "POLICY.md"), "utf8");
    const compiled = compilePolicy(md);
    expect(compiled.targets.length).toBe(1);
    expect(compiled.targets[0]!.selectors[0]!.tier).toBeDefined();
  });

  it("foundry.toml has [profile.default] and the ward remapping", () => {
    const res = scaffold({ name: "my-agent", template: "greenfield", cwd: dir });
    const toml = readFileSync(join(res.projectRoot, "foundry.toml"), "utf8");
    expect(toml).toContain("[profile.default]");
    expect(toml).toContain('"ward/=ward-src/"');
  });

  it("refuses to overwrite a non-empty target directory", () => {
    const targetDir = join(dir, "my-agent");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "stale.txt"), "hello", "utf8");
    expect(() => scaffold({ name: "my-agent", template: "greenfield", cwd: dir })).toThrow(
      /not empty/i,
    );
  });

  it("nextStepsBlock surfaces the dir name and pnpm ward push", () => {
    const res = scaffold({ name: "my-agent", template: "greenfield", cwd: dir });
    const next = nextStepsBlock(res);
    expect(next).toContain("cd my-agent");
    expect(next).toContain("pnpm ward push ./POLICY.md --label my-agent");
  });
});

describe("scaffold — counter-fixture", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "create-ward-agent-cf-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a Counter.sol target and a WardAgentBase-derived agent with both entrypoints modifier-gated", () => {
    const res = scaffold({ name: "my-counter", template: "counter-fixture", cwd: dir });
    expect(existsSync(join(res.projectRoot, "src/MyCounter.sol"))).toBe(true);
    expect(existsSync(join(res.projectRoot, "src/Counter.sol"))).toBe(true);
    const agent = readFileSync(join(res.projectRoot, "src/MyCounter.sol"), "utf8");
    expect(agent).toContain("is WardAgentBase");
    // Both entrypoints (bump + reset) modifier-gated against the AGENT's
    // own selectors (entrypoint-policy model). A regression that removes
    // either modifier fails the test.
    expect(agent).toContain("wardGuarded(this.bump.selector");
    expect(agent).toContain("wardGuarded(this.reset.selector");
    // Negative assertions: pin the absence of the pre-simplification shape
    // (tryBump / tryReset / reqId / DeniedCallRejected / manual
    // oracle.checkSelector + catch-and-emit). A regression that re-introduces
    // any of these fails the test.
    expect(agent).not.toContain("tryBump");
    expect(agent).not.toContain("tryReset");
    expect(agent).not.toContain("reqId");
    expect(agent).not.toContain("DeniedCallRejected");
    expect(agent).not.toContain("AllowedCallExecuted");
    expect(agent).not.toContain("oracle.checkSelector(");
  });

  it("scaffolded counter-fixture agent stacks an onlyOperator Solidity ACL on top of wardGuarded", () => {
    const res = scaffold({ name: "my-counter", template: "counter-fixture", cwd: dir });
    const agent = readFileSync(join(res.projectRoot, "src/MyCounter.sol"), "utf8");
    // Caller allow-list layer present.
    expect(agent).toContain("isOperator");
    expect(agent).toContain("modifier onlyOperator()");
    expect(agent).toContain("addOperator(address op)");
    expect(agent).toContain("removeOperator(address op)");
    // Modifier order is load-bearing: onlyOperator MUST be left of
    // wardGuarded so the cheap Solidity check fires before the oracle
    // call. Pin the exact left-to-right ordering on both entrypoints.
    expect(agent).toContain("onlyOperator wardGuarded(this.bump.selector");
    expect(agent).toContain("onlyOperator wardGuarded(this.reset.selector");
  });

  it("policy compiles and authorizes bump(uint256)", () => {
    const res = scaffold({ name: "my-counter", template: "counter-fixture", cwd: dir });
    const md = readFileSync(join(res.projectRoot, "POLICY.md"), "utf8");
    expect(() => compilePolicy(md)).not.toThrow();
    expect(md).toContain('selector: "bump(uint256)"');
  });
});

describe("renderTemplate — exhaustiveness + invariants", () => {
  it("every template renders 8 files with non-empty contents", () => {
    for (const template of ["greenfield", "counter-fixture"] as const) {
      const files = renderTemplate(template, { contractName: "MyAgent", dirName: "my-agent" });
      expect(files.length).toBe(8);
      for (const f of files) {
        expect(f.contents.length, `${template}:${f.path} empty`).toBeGreaterThan(0);
      }
    }
  });

  it("rejects unknown templates", () => {
    expect(() =>
      renderTemplate(
        // deliberately bogus to exercise the exhaustiveness branch
        "no-such-template" as never,
        { contractName: "X", dirName: "x" },
      ),
    ).toThrow();
  });
});
