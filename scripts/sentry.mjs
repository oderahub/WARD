#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dist = join(root, "cli", "dist", "index.js");
const src = join(root, "cli", "src", "index.ts");
const tsx = join(
  root,
  "cli",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

const command = existsSync(dist) ? process.execPath : tsx;
const commandArgs = existsSync(dist) ? [dist, ...args] : [src, ...args];

if (!existsSync(command)) {
  console.error("Sentry CLI is not installed yet. Run `pnpm install` first.");
  process.exit(1);
}

const result = spawnSync(command, commandArgs, {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
