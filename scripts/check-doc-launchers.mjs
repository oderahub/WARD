#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const roots = [
  "README.md",
  "SKILL.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "sdk/README.md",
  "examples",
];

const skipDirs = new Set(["node_modules", "dist", ".git", ".codegraph"]);
const extensions = new Set([".md", ".html", ".sh", ".txt"]);
const files = [];

const rules = [
  {
    name: "direct CLI dist launcher",
    regex: /(?:^|[^\w/-])(?:\.\/*)?cli\/dist\/index\.js\b/g,
  },
  {
    name: "direct TUI JSON dist launcher",
    regex: /(?:^|[^\w/-])(?:\.\/*)?tui\/dist\/index\.js\s+--json\b/g,
  },
  {
    name: "non-silent TUI JSON pipe",
    regex: /pnpm\s+sentry\s+tui\s+--json\s*\|/g,
  },
];

function extOf(path) {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

function walk(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    const name = path.split("/").at(-1);
    if (skipDirs.has(name)) return;
    for (const child of readdirSync(path)) {
      walk(join(path, child));
    }
    return;
  }
  if (extensions.has(extOf(path))) files.push(path);
}

for (const entry of roots) {
  walk(join(root, entry));
}

const findings = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      const before = text.slice(0, match.index);
      const lineNo = before.split(/\r?\n/).length;
      const line = lines[lineNo - 1]?.trim() ?? "";
      findings.push({
        file: relative(root, file),
        lineNo,
        rule: rule.name,
        line,
      });
    }
  }
}

if (findings.length > 0) {
  console.error("Found stale Sentry launcher guidance:");
  for (const f of findings) {
    console.error(`- ${f.file}:${f.lineNo} [${f.rule}] ${f.line}`);
  }
  console.error("\nUse `pnpm sentry ...` for interactive commands and `pnpm --silent sentry tui --json` for NDJSON pipelines.");
  process.exit(1);
}

console.log("docs launcher guidance OK");
