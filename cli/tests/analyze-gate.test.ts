import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeGate } from "../src/cmd/analyze-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures/analyze-gate");
const COUNTER_AGENT = resolve(__dirname, "../../examples/ward-counter/src/CounterAgent.sol");
const CLI_ENTRY = resolve(__dirname, "../dist/index.js");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("ward analyze:gate", () => {
  it("CounterAgent.sol passes clean (it uses _gate properly)", () => {
    const findings = analyzeGate(COUNTER_AGENT, read(COUNTER_AGENT));
    expect(findings).toEqual([]);
  });

  it("emits a finding for a raw target.call(...) with no preceding _gate", () => {
    const path = resolve(FIXTURES, "UngatedAgent.sol");
    const findings = analyzeGate(path, read(path));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.function).toBe("dispatch");
    expect(findings[0]!.severity).toBe("warn");
    // The dispatch sits on the line `(bool ok,) = target.call(intentData);`
    // which is the 8th line of the fixture.
    expect(findings[0]!.line).toBe(8);
  });

  it("recognizes WardCall.check(...) as a valid gate", () => {
    const path = resolve(FIXTURES, "WardCallAgent.sol");
    const findings = analyzeGate(path, read(path));
    expect(findings).toEqual([]);
  });

  it("ignores pure/view functions (no false positives)", () => {
    const path = resolve(FIXTURES, "PureViewOnly.sol");
    const findings = analyzeGate(path, read(path));
    expect(findings).toEqual([]);
  });

  it("--json output is parseable JSON with the expected shape", () => {
    const path = resolve(FIXTURES, "UngatedAgent.sol");
    let raw = "";
    try {
      raw = execFileSync(process.execPath, [CLI_ENTRY, "analyze:gate", path, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // exit code 1 is expected when findings exist; capture stdout.
      raw = (e as { stdout?: string }).stdout ?? "";
    }
    const parsed = JSON.parse(raw) as { ok: boolean; findings: Array<{ severity: string; file: string; line: number; function: string; message: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.severity).toBe("warn");
    expect(parsed.findings[0]!.function).toBe("dispatch");
    expect(parsed.findings[0]!.line).toBe(8);
  });
});
