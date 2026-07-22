import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateName, type ValidatedName } from "./name.js";
import { renderTemplate, TEMPLATES, type TemplateId, type MaterializedFile } from "./templates/index.js";

export interface ScaffoldOptions {
  name: string;
  template?: TemplateId;
  cwd?: string;
  refuseIfExists?: boolean;
}

export interface ScaffoldResult {
  name: ValidatedName;
  template: TemplateId;
  projectRoot: string;
  filesWritten: string[];
}

export function scaffold(opts: ScaffoldOptions): ScaffoldResult {
  const name = validateName(opts.name);
  const template = opts.template ?? "greenfield";
  if (!TEMPLATES.includes(template)) {
    throw new Error(
      `unknown template "${template}" — valid templates: ${TEMPLATES.join(", ")}`,
    );
  }
  const cwd = opts.cwd ?? process.cwd();
  const projectRoot = resolve(cwd, name.dirName);

  const refuseIfExists = opts.refuseIfExists ?? true;
  if (refuseIfExists && existsSync(projectRoot)) {
    // Empty pre-created directories are safe; non-empty ones are not.
    const entries = readdirSync(projectRoot);
    if (entries.length > 0) {
      throw new Error(
        `directory ${projectRoot} already exists and is not empty; refusing to overwrite`,
      );
    }
  }

  const files = renderTemplate(template, {
    contractName: name.contractName,
    dirName: name.dirName,
  });

  const written: string[] = [];
  for (const file of files) {
    const abs = writeOne(projectRoot, file);
    written.push(abs);
  }

  return { name, template, projectRoot, filesWritten: written };
}

function writeOne(projectRoot: string, file: MaterializedFile): string {
  const abs = resolve(projectRoot, file.path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, file.contents, "utf8");
  return abs;
}

export function nextStepsBlock(result: ScaffoldResult): string {
  const { name } = result;
  return [
    "",
    `Created ${result.projectRoot}`,
    "",
    "Next steps:",
    `  cd ${name.dirName}`,
    "  forge install foundry-rs/forge-std",
    "  # If you are inside the ward monorepo, link the contracts:",
    "  #   ln -s ../../contracts/src ward-src",
    "  forge build",
    "",
    "  # Publish your policy and bind it:",
    `  pnpm ward push ./POLICY.md --label ${name.dirName}`,
    "  forge script script/Deploy.s.sol --rpc-url \"$FUJI_RPC\" \\",
    "    --broadcast --legacy --gas-estimate-multiplier 2000",
    "  # Then export AGENT + POLICY_ID and run script/Bind.s.sol.",
    "",
    "See README.md inside the new directory for the full walkthrough.",
    "",
  ].join("\n");
}

export const __forTests = {
  join,
};
