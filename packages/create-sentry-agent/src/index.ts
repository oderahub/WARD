#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import cac from "cac";
import kleur from "kleur";
import { scaffold, nextStepsBlock } from "./scaffold.js";
import { TEMPLATES, type TemplateId } from "./templates/index.js";

interface RunOptions {
  template?: string;
  dryRun?: boolean;
}

export async function main(argv: string[]): Promise<number> {
  const cli = cac("create-sentry-agent");
  cli.usage("[name] [options]");

  let exitCode = 0;

  cli
    .command("[name]", "Scaffold a new SentryAgentBase-derived agent project")
    .option("--template <id>", `Template: ${TEMPLATES.join(" | ")}`, { default: "greenfield" })
    .option("--dry-run", "Validate inputs and render templates without writing to disk", { default: false })
    .action(async (rawName: string | undefined, opts: RunOptions) => {
      try {
        exitCode = await run(rawName, opts);
      } catch (e) {
        process.stderr.write(kleur.red((e as Error).message) + "\n");
        exitCode = 1;
      }
    });

  cli.help();
  cli.version("0.1.0");
  // cac.parse is fire-and-forget, so await the matched command explicitly.
  cli.parse(["node", "create-sentry-agent", ...argv], { run: false });
  await cli.runMatchedCommand();
  return exitCode;
}

async function run(rawName: string | undefined, opts: RunOptions): Promise<number> {
  const name = rawName ?? (await promptName());
  if (!name) {
    process.stderr.write(kleur.red("name is required") + "\n");
    return 1;
  }

  const template = normalizeTemplate(opts.template);

  if (opts.dryRun) {
    const { renderTemplate } = await import("./templates/index.js");
    const { validateName } = await import("./name.js");
    const validated = validateName(name);
    const files = renderTemplate(template, {
      contractName: validated.contractName,
      dirName: validated.dirName,
    });
    process.stdout.write(
      kleur.bold().cyan(`# dry-run: would create ${validated.dirName}/\n`),
    );
    for (const f of files) {
      process.stdout.write(`  ${kleur.dim(validated.dirName + "/")}${f.path}\n`);
    }
    return 0;
  }

  const result = scaffold({ name, template });
  process.stdout.write(kleur.green(`Scaffolded ${result.name.dirName}/\n`));
  process.stdout.write(nextStepsBlock(result));
  return 0;
}

function normalizeTemplate(raw: string | undefined): TemplateId {
  const value = (raw ?? "greenfield").trim();
  if (!TEMPLATES.includes(value as TemplateId)) {
    throw new Error(
      `unknown template "${value}" — valid: ${TEMPLATES.join(", ")}`,
    );
  }
  return value as TemplateId;
}

async function promptName(): Promise<string> {
  if (!stdin.isTTY) return "";
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("Agent name: ");
    return answer.trim();
  } finally {
    rl.close();
  }
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isDirectInvocation) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
