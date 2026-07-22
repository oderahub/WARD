import { readFileSync } from "node:fs";
import { type Address, type Hex } from "viem";
import kleur from "kleur";
import { tryDecode } from "../lib/decode.js";

interface IntentJson {
  agentId: string;
  requestId: string;
  target: Address;
  selector: Hex;
  data: Hex;
  value: string;
  promptHash: Hex;
  taskClass: number;
}

export async function inspectCmd(path: string): Promise<void> {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as IntentJson;
  console.log(kleur.bold().cyan("# intent"));
  console.log(`  agentId   ${raw.agentId}`);
  console.log(`  requestId ${raw.requestId}`);
  console.log(`  target    ${raw.target}`);
  console.log(`  selector  ${raw.selector}`);
  console.log(`  value     ${raw.value} wei`);
  console.log(`  taskClass ${raw.taskClass}`);
  console.log(`  promptHash ${raw.promptHash}`);

  console.log(kleur.bold().cyan("\n# calldata inspector"));
  const decoded = tryDecode(raw.data);
  if (decoded.abiSource && decoded.functionName) {
    console.log(`  ${kleur.green(decoded.abiSource + "." + decoded.functionName)}(${formatArgs(decoded.args ?? [])})`);
  } else {
    console.log(`  ${kleur.yellow("(unknown selector)")} ${decoded.selector}`);
    console.log(`  raw: ${decoded.raw}`);
  }

  const dataSelector = raw.data.slice(0, 10).toLowerCase();
  if (dataSelector !== raw.selector.toLowerCase()) {
    console.log(
      kleur.red(
        `\nWARNING: intent.selector ${raw.selector} does not match first 4 bytes of intent.data ${dataSelector}.` +
          ` Sentry will reject with SELECTOR_MISMATCH.`,
      ),
    );
  } else {
    console.log(kleur.green(`\nselector / calldata first-4-bytes: ✓ match`));
  }
}

function formatArgs(args: readonly unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "bigint") return a.toString();
      if (typeof a === "string") return a;
      return JSON.stringify(a);
    })
    .join(", ");
}
