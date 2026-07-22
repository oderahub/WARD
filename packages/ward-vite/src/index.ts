import {
  compilePolicy,
  evalPolicyFromInput,
  type EvalPolicy,
} from "@ward/sdk";
import type { Plugin } from "vite";

const QUERY = "eval-policy";

export default function wardPolicy(): Plugin {
  return {
    name: "ward-policy-embed",
    enforce: "pre",
    transform(code, id) {
      if (!hasEvalPolicyQuery(id)) return null;

      const policy = evalPolicyFromInput(compilePolicy(code));
      return {
        code: `const policy = ${serialize(policy)};\nexport default policy;\n`,
        map: null,
      };
    },
  };
}

function hasEvalPolicyQuery(id: string): boolean {
  const query = id.split("?", 2)[1];
  if (!query) return false;
  return query.split("&").includes(QUERY);
}

function serialize(value: unknown): string {
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => serialize(item)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${JSON.stringify(key)}: ${serialize(item)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  throw new TypeError(`serialize: unsupported value ${String(value)}`);
}

export type { EvalPolicy };
