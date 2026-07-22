import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileCmd } from "../src/cmd/policy.js";

const ADDR = "0x1111111111111111111111111111111111111111";

describe("ward policy compile", () => {
  let dir: string;
  let logs: string[];
  let restore: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ward-cli-"));
    logs = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    };
    restore = () => {
      console.log = orig;
    };
  });

  afterEach(() => {
    restore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints canonical JSON for a valid POLICY.md", async () => {
    const path = join(dir, "POLICY.md");
    // valueCapPerCall is mandatory in the SDK — fixture must include it on
    // every selector or schema validation fails before we ever check the
    // printed output. Expiry is computed at runtime so the fixture stays
    // valid even as the calendar advances past the previously-hardcoded
    // year-2100 epoch (which now trips the 5-year lifetime cap).
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // +30d
    writeFileSync(
      path,
      `# Demo\n\`\`\`policy\nversion: "0.1"\nexpiresAt: ${expiresAt}\ntargets:\n  - target: "${ADDR}"\n    selectors:\n      - selector: "approve(address,uint256)"\n        tier: IMMEDIATE\n        valueCapPerCall: "0"\n\`\`\`\n`,
    );
    await compileCmd(path);
    const out = logs.join("\n");
    expect(out).toContain("compiled PolicyInput");
    expect(out).toContain(ADDR);
    expect(out).toContain("targets");
  });

  it("throws on missing fenced block", async () => {
    const path = join(dir, "BAD.md");
    writeFileSync(path, "nothing here");
    await expect(compileCmd(path)).rejects.toThrow(/no fenced/);
  });

  it("throws on schema error", async () => {
    // This fixture must reject ONLY because of the BOGUS tier (AJV enum
    // violation → "schema validation failed"). Without `valueCapPerCall`,
    // the valueCapPerCall-required check in `normalize` would fire instead
    // if AJV ever stopped catching the tier enum, masking the intended
    // assertion behind a different (non-"schema validation") error.
    // Likewise the previously-hardcoded year-2100 expiry (epoch 4102444800)
    // would trip the 5-year lifetime cap if AJV stopped firing first — pin
    // a near-future hardcoded epoch instead (1764460800 = 2026-11-30, mirrors
    // the dashboard test fixtures) so the BOGUS-tier intent stays isolated.
    // Hardcoded (not Date.now-derived) so the fixture is stable for snapshot
    // diffing.
    const path = join(dir, "BAD.md");
    writeFileSync(
      path,
      `\`\`\`policy\nversion: "0.1"\nexpiresAt: 1764460800\ntargets:\n  - target: "${ADDR}"\n    selectors:\n      - selector: "approve(address,uint256)"\n        tier: BOGUS\n        valueCapPerCall: "0"\n\`\`\`\n`,
    );
    await expect(compileCmd(path)).rejects.toThrow(/schema validation/);
  });

  it("rejects ambiguous untagged fences", async () => {
    const path = join(dir, "AMBIG.md");
    writeFileSync(
      path,
      "```\nfirst block\n```\n\n```\nsecond block\n```\n",
    );
    await expect(compileCmd(path)).rejects.toThrow(/untagged code blocks/);
  });
});

describe("decode lib", () => {
  it("decodes a known approve selector", async () => {
    const { tryDecode } = await import("../src/lib/decode.js");
    // approve(address,uint256) selector = 0x095ea7b3
    const data = "0x095ea7b3000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd0000000000000000000000000000000000000000000000000000000000000064";
    const decoded = tryDecode(data as `0x${string}`);
    expect(decoded.functionName).toBe("approve");
    expect(decoded.abiSource).toBeDefined();
  });

  it("falls back to selector when no ABI matches", async () => {
    const { tryDecode } = await import("../src/lib/decode.js");
    const data = "0xdeadbeef00000000";
    const decoded = tryDecode(data as `0x${string}`);
    expect(decoded.selector).toBe("0xdeadbeef");
    expect(decoded.functionName).toBeUndefined();
  });

  it("returns the 0x00000000 placeholder selector for sub-4-byte calldata", async () => {
    const { tryDecode } = await import("../src/lib/decode.js");
    const decoded = tryDecode("0x" as `0x${string}`);
    expect(decoded.selector).toBe("0x00000000");
    expect(decoded.functionName).toBeUndefined();
  });
});

describe("env loader", () => {
  it("returns undefined for missing PRIVATE_KEY", async () => {
    delete process.env.PRIVATE_KEY;
    delete process.env.WARD_ORACLE;
    const { loadEnv, requirePrivateKey, requireWardOracle } = await import("../src/lib/env.js");
    const e = loadEnv();
    expect(e.privateKey).toBeUndefined();
    expect(() => requirePrivateKey(e)).toThrow(/PRIVATE_KEY/);
    expect(() => requireWardOracle(e)).toThrow(/WARD_ORACLE/);
  });
});

describe("friendlyRevertReason", () => {
  // The simulate-first wrapper in `pushCmd` prints THIS string to stderr, so the
  // operator sees a one-line "would revert: …" instead of viem's screen-tall
  // ContractFunctionExecutionError. Pure helper, no RPC.
  it("prefers `shortMessage` (viem's contract revert summary)", async () => {
    const { friendlyRevertReason } = await import("../src/cmd/policy.js");
    const fakeViemErr = {
      shortMessage: "The contract function \"publishPolicy\" reverted with the following reason: ReservedTarget()",
      message: "ContractFunctionExecutionError: ...\n  Contract Call:\n    ...stacktrace lines...",
    };
    expect(friendlyRevertReason(fakeViemErr)).toContain("ReservedTarget");
    expect(friendlyRevertReason(fakeViemErr)).not.toContain("stacktrace");
  });

  it("falls back to the first line of `message` when shortMessage is absent", async () => {
    const { friendlyRevertReason } = await import("../src/cmd/policy.js");
    const err = { message: "fetch failed\n  at node:internal/...\n  at async ..." };
    expect(friendlyRevertReason(err)).toBe("fetch failed");
  });

  it("stringifies opaque throws so the CLI never prints `[object Object]` raw", async () => {
    const { friendlyRevertReason } = await import("../src/cmd/policy.js");
    expect(friendlyRevertReason(42)).toBe("42");
    expect(friendlyRevertReason("just a string")).toBe("just a string");
  });
});
