import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateAiAssistPack, aiInitInternals } from "../src/cmd/ai-init.js";

const FIXTURE_SKILL = `---
name: sentry-integration
description: Tiny Sentry guide.
---

# Sentry

Use Sentry before calls.
`;

describe("sentry ai:init", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-ai-init-"));
    writeFileSync(join(dir, "SKILL.md"), FIXTURE_SKILL);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates the Cursor rule from SKILL.md", () => {
    generateAiAssistPack({ cwd: dir, cursor: true });
    const out = readFileSync(join(dir, ".cursor/rules/sentry.mdc"), "utf8");
    expect(out).toMatchInlineSnapshot(`
      "<!-- GENERATED — edit /SKILL.md and rerun \`sentry ai:init\` to update -->
      ---
      description: "Tiny Sentry guide."
      ---


      # Sentry

      Use Sentry before calls.
      "
    `);
  });

  it("generates the Claude skill with a provenance footer", () => {
    generateAiAssistPack({ cwd: dir, claude: true });
    const out = readFileSync(join(dir, ".claude/skills/sentry-integration/SKILL.md"), "utf8");
    expect(out).toMatchInlineSnapshot(`
      "<!-- GENERATED — edit /SKILL.md and rerun \`sentry ai:init\` to update -->
      ---
      name: sentry-integration
      description: Tiny Sentry guide.
      ---

      # Sentry

      Use Sentry before calls.

      ## How this file was generated

      This file was generated from the canonical /SKILL.md by \`sentry ai:init\`. Edit /SKILL.md and rerun the command to update it.
      "
    `);
  });

  it("generates the Codex section as a thin pointer to /SKILL.md (not the full body)", () => {
    generateAiAssistPack({ cwd: dir, codex: true });
    const out = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(out).toMatchInlineSnapshot(`
      "<!-- sentry-ai-init:begin -->
      <!-- GENERATED — edit /SKILL.md and rerun \`sentry ai:init\` to update -->
      ## Sentry

      Tiny Sentry guide.

      The canonical, full integration manual for Sentry lives in [/SKILL.md](SKILL.md). AI agents should read that file for Sentry conventions, contract addresses, the \`sentryGuarded\` modifier shape, policy authoring, and CLI / dashboard usage. The body is intentionally not duplicated here.
      <!-- sentry-ai-init:end -->
      "
    `);
    // The pointer-stub does NOT carry the SKILL body inline (the whole point of the dedup).
    expect(out).not.toContain("Use Sentry before calls.");
  });

  it("appends into an existing AGENTS.md and replaces the marked section on rerun", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Project rules\n\nKeep changes scoped.\n");
    generateAiAssistPack({ cwd: dir, codex: true });
    generateAiAssistPack({ cwd: dir, codex: true });

    const out = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(out.startsWith("# Project rules\n\nKeep changes scoped.\n\n")).toBe(true);
    expect(out.match(new RegExp(aiInitInternals.CODEX_BEGIN, "g"))).toHaveLength(1);
    expect(out).toContain("## Sentry");
    expect(out).toContain("[/SKILL.md](SKILL.md)");
  });

  it("refuses to overwrite hand-edited canonical files without --force", () => {
    const path = join(dir, ".cursor/rules/sentry.mdc");
    mkdirSync(join(dir, ".cursor/rules"), { recursive: true });
    writeFileSync(path, "hand edited");

    expect(() => generateAiAssistPack({ cwd: dir, cursor: true })).toThrow(/--force/);

    generateAiAssistPack({ cwd: dir, cursor: true, force: true });
    expect(readFileSync(path, "utf8")).toContain(aiInitInternals.GENERATED_HEADER);
  });
});
