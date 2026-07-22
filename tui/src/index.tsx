#!/usr/bin/env node
import { render } from "ink";
import kleur from "kleur";
import { App } from "./components/App.js";
import { runJsonMode } from "./json-mode.js";

const args = process.argv.slice(2);
const VERSION = "0.9.0";

if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(
    [
      `ward-tui ${VERSION}`,
      "",
      "Usage:",
      "  ward-tui          Open the full-screen queue monitor TUI",
      "  ward-tui --json   Skip the TUI; stream NDJSON of events to stdout",
      "  ward-tui --help   Show this message",
      "  ward-tui --version",
      "",
      "Env: PRIVATE_KEY (optional), SOMNIA_TESTNET_RPC, WARD_ORACLE, WARD_QUEUE",
      "     WARD_QUEUE_LOOKBACK_BLOCKS (default 50000)",
      "     WARD_TUI_ORACLE_DEPLOY_BLOCK or WARD_TUI_DEEP_BACKFILL=1 for deep policy backfill",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (args.includes("-v") || args.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (args.includes("--json")) {
  runJsonMode().catch((e: Error) => {
    process.stderr.write(kleur.red(`error: ${e.message}\n`));
    process.exit(1);
  });
} else {
  render(<App />);
}

process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    kleur.red(`unhandled: ${(reason as Error)?.message ?? String(reason)}\n`),
  );
  process.exit(1);
});
