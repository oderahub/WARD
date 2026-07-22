import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectCmd } from "../src/cmd/inspect.js";

const APPROVE_SIG_SELECTOR = "0x095ea7b3"; // approve(address,uint256)
const SPENDER = "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD";
const AMOUNT_HEX = "0000000000000000000000000000000000000000000000000000000000000064"; // 100

function approveCalldata(): string {
  return APPROVE_SIG_SELECTOR + "000000000000000000000000" + SPENDER.slice(2).toLowerCase() + AMOUNT_HEX;
}

describe("ward inspect", () => {
  let dir: string;
  let logs: string[];
  let restore: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ward-inspect-"));
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

  it("decodes a known approve intent and reports selector match", async () => {
    const intent = {
      agentId: "1",
      requestId: "1",
      target: "0x1111111111111111111111111111111111111111",
      selector: APPROVE_SIG_SELECTOR,
      data: approveCalldata(),
      value: "0",
      promptHash: "0x" + "00".repeat(32),
      taskClass: 0,
    };
    const path = join(dir, "intent.json");
    writeFileSync(path, JSON.stringify(intent));
    await inspectCmd(path);
    const out = logs.join("\n");
    expect(out).toContain("approve");
    expect(out).toContain("✓ match");
  });

  it("flags selector / calldata mismatch", async () => {
    const intent = {
      agentId: "1",
      requestId: "1",
      target: "0x1111111111111111111111111111111111111111",
      selector: "0xdeadbeef",
      data: approveCalldata(), // first 4 bytes are 0x095ea7b3, not 0xdeadbeef
      value: "0",
      promptHash: "0x" + "00".repeat(32),
      taskClass: 0,
    };
    const path = join(dir, "intent.json");
    writeFileSync(path, JSON.stringify(intent));
    await inspectCmd(path);
    const out = logs.join("\n");
    expect(out).toContain("WARNING");
    expect(out).toContain("SELECTOR_MISMATCH");
  });

  it("handles an unknown selector gracefully", async () => {
    const intent = {
      agentId: "1",
      requestId: "1",
      target: "0x1111111111111111111111111111111111111111",
      selector: "0xdeadbeef",
      data: "0xdeadbeef00",
      value: "0",
      promptHash: "0x" + "00".repeat(32),
      taskClass: 0,
    };
    const path = join(dir, "intent.json");
    writeFileSync(path, JSON.stringify(intent));
    await inspectCmd(path);
    const out = logs.join("\n");
    expect(out).toContain("unknown selector");
  });
});
