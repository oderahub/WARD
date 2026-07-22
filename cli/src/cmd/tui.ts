import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface TuiOptions {
  exitOnFailure?: boolean;
}

export function runTuiCmd(args: string[] = [], opts: TuiOptions = {}): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dist = join(root, "tui", "dist", "index.js");
  const src = join(root, "tui", "src", "index.tsx");
  const tsx = join(
    root,
    "tui",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );

  const command = existsSync(dist) ? process.execPath : tsx;
  const commandArgs = existsSync(dist) ? [dist, ...args] : [src, ...args];

  if (!existsSync(command)) {
    throw new Error("Sentry TUI is not installed yet. Run `pnpm install` first.");
  }

  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  if (result.signal) {
    if (opts.exitOnFailure !== false) process.kill(process.pid, result.signal);
    throw new Error(`Sentry TUI exited by signal ${result.signal}`);
  }
  if ((result.status ?? 1) !== 0) {
    if (opts.exitOnFailure !== false) process.exit(result.status ?? 1);
    throw new Error(`Sentry TUI exited with code ${result.status ?? 1}`);
  }
}
