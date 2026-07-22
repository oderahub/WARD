import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import kleur from "kleur";

export interface AiInitOptions {
  cursor?: boolean;
  claude?: boolean;
  codex?: boolean;
  all?: boolean;
  force?: boolean;
  cwd?: string;
  skillPath?: string;
}

const GENERATED_HEADER = "<!-- GENERATED — edit /SKILL.md and rerun `sentry ai:init` to update -->";
const CODEX_BEGIN = "<!-- sentry-ai-init:begin -->";
const CODEX_END = "<!-- sentry-ai-init:end -->";

export async function aiInitCmd(opts: AiInitOptions = {}): Promise<void> {
  const result = generateAiAssistPack(opts);
  console.log(kleur.bold().cyan("# sentry ai:init"));
  for (const file of result.written) console.log(kleur.green(`  wrote ${file}`));
}

export interface AiInitResult {
  written: string[];
}

export function generateAiAssistPack(opts: AiInitOptions = {}): AiInitResult {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const skillPath = resolve(cwd, opts.skillPath ?? "SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  const parsed = parseSkill(skill);
  const targets = selectedTargets(opts);
  const written: string[] = [];

  if (targets.cursor) {
    const path = join(cwd, ".cursor/rules/sentry.mdc");
    writeGeneratedFile(path, renderCursorRule(parsed), opts.force);
    written.push(relativeDisplay(cwd, path));
  }

  if (targets.claude) {
    const path = join(cwd, ".claude/skills/sentry-integration/SKILL.md");
    writeGeneratedFile(path, renderClaudeSkill(skill), opts.force);
    written.push(relativeDisplay(cwd, path));
  }

  if (targets.codex) {
    const path = join(cwd, "AGENTS.md");
    writeCodexAgents(path, renderCodexSection(skill), opts.force);
    written.push(relativeDisplay(cwd, path));
  }

  return { written };
}

interface ParsedSkill {
  description: string;
  body: string;
}

function selectedTargets(opts: AiInitOptions): Required<Pick<AiInitOptions, "cursor" | "claude" | "codex">> {
  const explicit = Boolean(opts.cursor || opts.claude || opts.codex || opts.all);
  return {
    cursor: opts.all || opts.cursor || !explicit,
    claude: opts.all || opts.claude || !explicit,
    codex: opts.all || opts.codex || !explicit,
  };
}

function parseSkill(skill: string): ParsedSkill {
  if (!skill.startsWith("---\n")) return { description: "Sentry integration guide", body: skill };
  const end = skill.indexOf("\n---", 4);
  if (end < 0) return { description: "Sentry integration guide", body: skill };
  const frontmatter = skill.slice(4, end).trim();
  const body = skill.slice(end + "\n---".length).replace(/^\n/, "");
  const descriptionLine = frontmatter.split("\n").find((line) => line.trim().startsWith("description:"));
  const description = descriptionLine
    ? descriptionLine.slice(descriptionLine.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "")
    : "Sentry integration guide";
  return { description, body };
}

function renderCursorRule(skill: ParsedSkill): string {
  return `${GENERATED_HEADER}
---
description: ${JSON.stringify(skill.description)}
---

${skill.body}`;
}

function renderClaudeSkill(skill: string): string {
  return `${GENERATED_HEADER}
${skill.trimEnd()}

## How this file was generated

This file was generated from the canonical /SKILL.md by \`sentry ai:init\`. Edit /SKILL.md and rerun the command to update it.
`;
}

function renderCodexSection(skill: string): string {
  // Keep AGENTS.md as a thin pointer so /SKILL.md remains the single source of truth.
  const parsed = parseSkill(skill);
  return `${CODEX_BEGIN}
${GENERATED_HEADER}
## Sentry

${parsed.description}

The canonical, full integration manual for Sentry lives in [/SKILL.md](SKILL.md). AI agents should read that file for Sentry conventions, contract addresses, the \`sentryGuarded\` modifier shape, policy authoring, and CLI / dashboard usage. The body is intentionally not duplicated here.
${CODEX_END}`;
}

function writeGeneratedFile(path: string, content: string, force = false): void {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (!force && !existing.includes(GENERATED_HEADER)) {
      throw new Error(`${path} exists and does not look generated; rerun with --force to overwrite it`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeCodexAgents(path: string, section: string, force = false): void {
  if (!existsSync(path)) {
    writeGeneratedFile(path, `${section}\n`, true);
    return;
  }

  const existing = readFileSync(path, "utf8");
  const start = existing.indexOf(CODEX_BEGIN);
  const end = existing.indexOf(CODEX_END);
  if (start >= 0 && end >= start) {
    const sectionEnd = end + CODEX_END.length;
    const oldSection = existing.slice(start, sectionEnd);
    if (!force && !oldSection.includes(GENERATED_HEADER)) {
      throw new Error(`${path} has a hand-edited Sentry section; rerun with --force to replace it`);
    }
    writeFileSync(path, `${existing.slice(0, start)}${section}${existing.slice(sectionEnd)}`);
    return;
  }

  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, `${existing}${sep}${section}\n`);
}

function relativeDisplay(cwd: string, path: string): string {
  return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

export const aiInitInternals = {
  GENERATED_HEADER,
  CODEX_BEGIN,
  CODEX_END,
  parseSkill,
  renderCursorRule,
  renderClaudeSkill,
  renderCodexSection,
};
