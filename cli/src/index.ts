#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import cac from "cac";
import kleur from "kleur";

// Load cwd .env before other modules read process.env; shell values win.
(function loadDotenv() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
})();

import { compileCmd, policyIdCmd, pushCmd } from "./cmd/policy.js";
import { inspectCmd } from "./cmd/inspect.js";
import { aiInitCmd } from "./cmd/ai-init.js";
import { policyInitCmd } from "./cmd/policy-init.js";
import { lintCmd } from "./cmd/lint.js";
import { analyzeGateCmd } from "./cmd/analyze-gate.js";
import { preflightCmd } from "./cmd/preflight.js";
import { queueDispatchCmd, queueEnqueueCmd, queueExpireCmd, queueHandoffCmd, queueStatusCmd, queueVetoCmd } from "./cmd/queue.js";
import { runTuiCmd } from "./cmd/tui.js";
import { runInteractive } from "./interactive.js";
import { parseEther, type Address, type Hex } from "viem";

const cli = cac("ward");
cli.usage("[command] [options]");

function rawOptionValue(name: string): string | undefined {
  const flag = `--${name}`;
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === flag) return raw[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function stringOption(parsed: unknown, name: string): string | undefined {
  const raw = rawOptionValue(name);
  if (raw !== undefined) return raw;
  if (parsed === undefined) return undefined;
  return String(parsed);
}

cli.command("compile <path>", "Compile a POLICY.md to canonical JSON").action(async (path: string) => {
  await compileCmd(path);
});

cli
  .command("push <path>", "Compile + publish POLICY.md to WardOracle under your wallet's namespace")
  .option("--label <name>", "ASCII label (≤32 bytes) for your policy namespace", { default: "default", type: [String] })
  .action(async (path: string, opts: { label?: string }) => {
    await pushCmd(path, { label: stringOption(opts.label, "label") ?? "default" });
  });

cli
  .command("policyid <label>", "Compute the WardOracle policyId for a (publisher, label) pair")
  .option("--publisher <addr>", "Publisher address (default: wallet from PRIVATE_KEY)", { type: [String] })
  .action(async (label: string, opts: { publisher?: string }) => {
    await policyIdCmd(label, stringOption(opts.publisher, "publisher"));
  });

cli
  .command("inspect <intent.json>", "Pretty-print an Intent JSON with calldata decoded")
  .action(async (path: string) => {
    await inspectCmd(path);
  });

cli
  .command("queue:status <execId>", "Pretty-print a WardQueue record header (cheap; skips intent.data)")
  .action(async (id: string) => {
    await queueStatusCmd(id);
  });

cli
  .command("queue:handoff <execId>", "Print operator handoff guidance for a queued execution")
  .option("--agent <addr>", "Integrator agent address; used when its ABI exposes dispatchQueued(uint256)", { type: [String] })
  .option("--abi <path>", "Agent ABI JSON or Foundry artifact JSON", { type: [String] })
  .action(async (id: string, opts: { agent?: string; abi?: string }) => {
    await queueHandoffCmd(id, {
      agent: stringOption(opts.agent, "agent") as `0x${string}` | undefined,
      abi: stringOption(opts.abi, "abi"),
    });
  });

cli
  .command("handoff <execId>", "Alias for queue:handoff")
  .option("--agent <addr>", "Integrator agent address; used when its ABI exposes dispatchQueued(uint256)", { type: [String] })
  .option("--abi <path>", "Agent ABI JSON or Foundry artifact JSON", { type: [String] })
  .action(async (id: string, opts: { agent?: string; abi?: string }) => {
    await queueHandoffCmd(id, {
      agent: stringOption(opts.agent, "agent") as `0x${string}` | undefined,
      abi: stringOption(opts.abi, "abi"),
    });
  });

cli
  .command(
    "queue:dispatch <execId>",
    "Mark a queued intent Committed; with --execute also send the intent's tx in the same command",
  )
  .option("--execute", "After dispatch succeeds, send the intent (to=target, data, value) from this wallet", { default: false })
  .action(async (id: string, opts: { execute: boolean }) => {
    await queueDispatchCmd(id, { execute: opts.execute });
  });

cli
  .command(
    "queue:enqueue <intent.json> <policyId>",
    "Submit an Intent to WardQueue under a policyId (DELAYED / VETO_REQUIRED only)",
  )
  .option("--spent-today <wei>", "Caller's running spent-today in wei (decimal string)", { default: "0", type: [String] })
  .action(async (intentPath: string, policyId: string, opts: { spentToday?: string }) => {
    await queueEnqueueCmd(intentPath, policyId, { spentToday: stringOption(opts.spentToday, "spent-today") ?? "0" });
  });

cli
  .command("queue:veto <execId> <reason>", "Veto a pending queued intent (policy owner only; ≤32-byte reason)")
  .action(async (id: string, reason: string) => {
    await queueVetoCmd(id, reason);
  });

cli
  .command("queue:expire <execId>", "Mark a stale pending queued intent Expired (anyone can call after deadline)")
  .action(async (id: string) => {
    await queueExpireCmd(id);
  });

cli
  .command("ai:init", "Generate Ward assistant context files from SKILL.md")
  .option("--cursor", "Write .cursor/rules/ward.mdc")
  .option("--claude", "Write .claude/skills/ward-integration/SKILL.md")
  .option("--codex", "Create or update the marked Ward section in AGENTS.md")
  .option("--all", "Write Cursor, Claude, and Codex files")
  .option("--force", "Overwrite hand-edited generated destinations")
  .action(async (opts: { cursor?: boolean; claude?: boolean; codex?: boolean; all?: boolean; force?: boolean }) => {
    await aiInitCmd(opts);
  });

cli
  .command("lint <path>", "Lint POLICY.md for common Ward integration mistakes")
  .option("--abi <path>", "ABI JSON or Foundry artifact JSON", { type: [String] })
  .option("--oracle <addr>", "WardOracle address for on-chain rules", { type: [String] })
  .option("--rpc <url>", "RPC URL for on-chain rules", { type: [String] })
  .option("--policy-id <id>", "Policy id for policyOwner checks", { type: [String] })
  .option("--fail-on <rules>", "Comma-separated rule ids to promote to errors", { type: [String] })
  .option("--json", "Print machine-readable diagnostics", { default: false })
  .action(async (
    path: string,
    opts: { abi?: string; oracle?: string; rpc?: string; policyId?: string; failOn?: string; json?: boolean },
  ) => {
    await lintCmd(path, {
      abi: stringOption(opts.abi, "abi"),
      oracle: stringOption(opts.oracle, "oracle") as Address | undefined,
      rpc: stringOption(opts.rpc, "rpc"),
      policyId: stringOption(opts.policyId, "policy-id") as Hex | undefined,
      failOn: (stringOption(opts.failOn, "fail-on") ?? "").split(",").map((v) => v.trim()).filter(Boolean),
      json: opts.json,
    });
  });

cli
  .command("analyze:gate <path>", "Static check that every dispatch in an agent contract is gated")
  .option("--json", "Print machine-readable findings", { default: false })
  .action(async (path: string, opts: { json?: boolean }) => {
    await analyzeGateCmd(path, { json: opts.json });
  });

cli
  .command("policy:init", "Generate a starter POLICY.md from a contract ABI")
  .option("--abi <path>", "ABI JSON or Foundry artifact JSON", { type: [String] })
  .option("--target <addr>", "Contract address the policy should gate", { type: [String] })
  .option("--profile <name>", "strict, balanced, or aggressive", { default: "balanced", type: [String] })
  .option("--expires <iso>", "Policy expiry timestamp, e.g. 2026-12-31T23:59:59.000Z", { type: [String] })
  .action(async (opts: { abi?: string; target?: string; profile?: string; expires?: string }) => {
    await policyInitCmd({
      abi: stringOption(opts.abi, "abi") ?? "",
      target: stringOption(opts.target, "target") ?? "",
      profile: (stringOption(opts.profile, "profile") ?? "balanced") as never,
      expires: stringOption(opts.expires, "expires"),
    });
  });

cli
  .command("preflight", "Check env + wallet balance against Avalanche Fuji")
  .option("--min-balance <eth>", "Minimum recommended balance in AVAX", { default: "0.5", type: [String] })
  .action(async (opts: { minBalance?: string }) => {
    const result = await preflightCmd({ minBalance: parseEther(stringOption(opts.minBalance, "min-balance") ?? "0.5") });
    if (!result.ok) process.exit(1);
  });

cli
  .command("tui [...args]", "Open the full-screen Ink queue monitor TUI")
  .option("--json", "Stream queue events as NDJSON instead of opening the TUI")
  .allowUnknownOptions()
  .action(() => {
    const raw = process.argv.slice(2);
    const tuiIndex = raw.indexOf("tui");
    runTuiCmd(tuiIndex >= 0 ? raw.slice(tuiIndex + 1) : []);
  });

cli.help((sections) => {
  const usageIndex = sections.findIndex((section) => section.title === "Usage");
  sections.splice(usageIndex + 1, 0, {
    title: "Interactive",
    body: "  $ ward\n    Open the guided menu.",
  });
  return sections;
});
// Resolve relative to this file so version loading works under `tsx` and built JS.
const { version: CLI_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
cli.version(CLI_VERSION);

try {
  if (process.argv.slice(2).length === 0) {
    await runInteractive();
    process.exit(0);
  }
  cli.parse();
} catch (e) {
  console.error(kleur.red((e as Error).message));
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  console.error(kleur.red((reason as Error)?.message ?? String(reason)));
  process.exit(1);
});
