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
      `sentry-tui ${VERSION}`,
      "",
      "Usage:",
      "  sentry-tui          Open the full-screen queue monitor TUI",
      "  sentry-tui --json   Skip the TUI; stream NDJSON of events to stdout",
      "  sentry-tui --help   Show this message",
      "  sentry-tui --version",
      "",
      "Env: PRIVATE_KEY (optional), SOMNIA_TESTNET_RPC, SENTRY_ORACLE, SENTRY_QUEUE",
      "     SENTRY_QUEUE_LOOKBACK_BLOCKS (default 50000)",
      "     SENTRY_TUI_ORACLE_DEPLOY_BLOCK or SENTRY_TUI_DEEP_BACKFILL=1 for deep policy backfill",
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
