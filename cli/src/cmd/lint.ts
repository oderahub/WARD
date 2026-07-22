import { readFileSync } from "node:fs";
import { compilePolicy, SENTRY_ORACLE_ABI } from "@sentry-somnia/sdk";
import kleur from "kleur";
import { isAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { publicClient } from "../lib/env.js";

export type LintRule =
  | "dailyCapZeroWithPayable"
  | "vetoRequiredWithoutOwner"
  | "targetHasNoCode"
  | "selectorNotInAbi"
  | "immediateWithDelay"
  | "delayedWithZeroDelay"
  | "viewFunctionGated"
  | "policyExpired";

export interface LintDiagnostic {
  rule: LintRule;
  severity: "warn" | "error";
  message: string;
  file: string;
  line: number;
  col: number;
}

export interface LintOptions {
  abi?: string;
  oracle?: Address;
  rpc?: string;
  policyId?: Hex;
  failOn?: string[];
  json?: boolean;
  now?: number;
  getCode?: (address: Address) => Promise<Hex>;
  policyOwner?: (policyId: Hex) => Promise<Address>;
}

interface RawPolicyDoc {
  dailySpendWeiCap?: string;
  expiresAt?: { value: string; line: number; col: number };
  targets: RawTarget[];
}

interface RawTarget {
  target: Address;
  line: number;
  col: number;
  selectors: RawSelector[];
}

interface RawSelector {
  selector: string;
  line: number;
  col: number;
  tier?: string;
  delaySeconds?: number;
}

interface AbiFn {
  type: "function";
  name: string;
  inputs?: AbiParam[];
  stateMutability?: "pure" | "view" | "nonpayable" | "payable";
}

interface AbiParam {
  type: string;
  components?: AbiParam[];
}

const DEFAULT_ERROR_RULES = new Set<LintRule>([
  "immediateWithDelay",
  "policyExpired",
  "vetoRequiredWithoutOwner",
]);

export async function lintCmd(path: string, opts: LintOptions = {}): Promise<void> {
  const diagnostics = await lintPolicy(path, opts);
  if (opts.json) {
    console.log(JSON.stringify({ ok: diagnostics.every((d) => d.severity !== "error"), diagnostics }, null, 2));
  } else {
    console.log(kleur.bold().cyan("# sentry lint"));
    if (diagnostics.length === 0) {
      console.log(kleur.green("  OK · no diagnostics"));
    } else {
      for (const d of diagnostics) {
        const color = d.severity === "error" ? kleur.red : kleur.yellow;
        console.log(color(`${d.file}:${d.line}:${d.col} ${d.severity.toUpperCase()} ${d.rule} ${d.message}`));
      }
    }
  }
  if (diagnostics.some((d) => d.severity === "error")) process.exitCode = 1;
}

export async function lintPolicy(path: string, opts: LintOptions = {}): Promise<LintDiagnostic[]> {
  const markdown = readFileSync(path, "utf8");
  const raw = parseRawPolicy(markdown);
  const abi = opts.abi ? readAbi(opts.abi) : [];
  const abiBySignature = new Map(abi.map((fn) => [signature(fn), fn]));
  const abiBySelector = new Map(abi.map((fn) => [selectorForSignature(signature(fn)), fn]));
  const failOn = new Set((opts.failOn ?? []).filter(Boolean) as LintRule[]);
  const diagnostics: LintDiagnostic[] = [];

  try {
    compilePolicy(markdown, { oracleAddress: opts.oracle });
  } catch {
    // Keep friendly lints available even when the compiler rejects the document.
  }

  const add = (rule: LintRule, selector: Pick<RawSelector, "line" | "col">, message: string) => {
    diagnostics.push({
      rule,
      severity: failOn.has(rule) || DEFAULT_ERROR_RULES.has(rule) ? "error" : "warn",
      message,
      file: path,
      line: selector.line,
      col: selector.col,
    });
  };

  if (isDailyCapZero(raw.dailySpendWeiCap)) {
    for (const target of raw.targets) {
      for (const sel of target.selectors) {
        const fn = abiFunctionFor(sel, abiBySignature, abiBySelector);
        if (fn?.stateMutability === "payable") {
          add("dailyCapZeroWithPayable", sel, "policy will block all value-bearing calls");
        }
      }
    }
  }

  for (const target of raw.targets) {
    for (const sel of target.selectors) {
      if (sel.tier === "IMMEDIATE" && (sel.delaySeconds ?? 0) !== 0) {
        add("immediateWithDelay", sel, "IMMEDIATE selectors must use delaySeconds: 0");
      }
      if (sel.tier === "DELAYED" && (sel.delaySeconds ?? 0) === 0) {
        add("delayedWithZeroDelay", sel, "DELAYED with zero delay is just IMMEDIATE");
      }

      const fn = abiFunctionFor(sel, abiBySignature, abiBySelector);
      if (abi.length > 0 && !fn) {
        const suggestion = closestSelector(sel.selector, [...abiBySignature.keys()]);
        add(
          "selectorNotInAbi",
          sel,
          suggestion ? `selector ${sel.selector} not found in ABI; closest match: ${suggestion}` : `selector ${sel.selector} not found in ABI`,
        );
      } else if (fn?.stateMutability === "view" || fn?.stateMutability === "pure") {
        add("viewFunctionGated", sel, "view functions don't need gating");
      }
    }
  }

  if (raw.expiresAt) {
    const expiresAt = Date.parse(stripQuotes(raw.expiresAt.value));
    if (!Number.isNaN(expiresAt) && expiresAt < (opts.now ?? Date.now())) {
      add("policyExpired", raw.expiresAt, "policy expiry is in the past");
    }
  }

  if ((opts.oracle && opts.rpc) || opts.getCode) {
    const getCode = opts.getCode ?? (async (target: Address) => {
      const client = publicClient(opts.rpc);
      return await client.getBytecode({ address: target }) ?? "0x";
    });
    for (const target of raw.targets) {
      if ((await getCode(target.target)) === "0x") {
        diagnostics.push({
          rule: "targetHasNoCode",
          severity: failOn.has("targetHasNoCode") ? "error" : "warn",
          message: "target has no bytecode",
          file: path,
          line: target.line,
          col: target.col,
        });
      }
    }
  }

  if (opts.oracle && opts.policyId && raw.targets.some((t) => t.selectors.some((s) => s.tier === "VETO_REQUIRED"))) {
    const owner = opts.policyOwner
      ? await opts.policyOwner(opts.policyId)
      : ((await publicClient(opts.rpc).readContract({
          address: opts.oracle,
          abi: SENTRY_ORACLE_ABI as never,
          functionName: "policyOwner",
          args: [opts.policyId],
        })) as Address);
    if (owner.toLowerCase() === "0x0000000000000000000000000000000000000000") {
      const sel = raw.targets.flatMap((t) => t.selectors).find((s) => s.tier === "VETO_REQUIRED")!;
      add("vetoRequiredWithoutOwner", sel, "no policy owner can dispatch");
    }
  }

  return diagnostics;
}

function parseRawPolicy(markdown: string): RawPolicyDoc {
  const block = markdown.match(/```policy\s*\n([\s\S]*?)```/)?.[1] ?? markdown;
  const lines = block.split("\n");
  const doc: RawPolicyDoc = { targets: [] };
  let currentTarget: RawTarget | undefined;
  let currentSelector: RawSelector | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]!;
    const lineNo = i + 1;
    const daily = rawLine.match(/^\s*dailySpendWeiCap:\s*(.+?)\s*(?:#.*)?$/);
    if (daily) doc.dailySpendWeiCap = daily[1]!.trim();

    const expires = rawLine.match(/^\s*expiresAt:\s*(.+?)\s*(?:#.*)?$/);
    if (expires) doc.expiresAt = { value: expires[1]!.trim(), line: lineNo, col: rawLine.indexOf("expiresAt") + 1 };

    const target = rawLine.match(/^\s*-\s*target:\s*["']?(0x[0-9a-fA-F]{40})["']?/);
    if (target && isAddress(target[1]!)) {
      currentTarget = { target: target[1]! as Address, line: lineNo, col: rawLine.indexOf("target") + 1, selectors: [] };
      doc.targets.push(currentTarget);
      currentSelector = undefined;
      continue;
    }

    const selector = rawLine.match(/^\s*-\s*selector:\s*["']?([^"']+)["']?/);
    if (selector && currentTarget) {
      currentSelector = { selector: selector[1]!.trim(), line: lineNo, col: rawLine.indexOf("selector") + 1 };
      currentTarget.selectors.push(currentSelector);
      continue;
    }

    const tier = rawLine.match(/^\s*tier:\s*([A-Z_]+)/);
    if (tier && currentSelector) currentSelector.tier = tier[1]!;

    const delay = rawLine.match(/^\s*delaySeconds:\s*(\d+)/);
    if (delay && currentSelector) currentSelector.delaySeconds = Number(delay[1]);
  }

  return doc;
}

function readAbi(path: string): AbiFn[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const abi = Array.isArray(parsed) ? parsed : (parsed as { abi?: unknown }).abi;
  if (!Array.isArray(abi)) throw new Error(`${path} does not contain an ABI array`);
  return abi.filter((item): item is AbiFn => {
    return typeof item === "object" && item !== null && (item as { type?: unknown }).type === "function";
  });
}

function abiFunctionFor(sel: RawSelector, bySignature: Map<string, AbiFn>, bySelector: Map<string, AbiFn>): AbiFn | undefined {
  if (sel.selector.startsWith("0x")) return bySelector.get(sel.selector.toLowerCase());
  return bySignature.get(sel.selector);
}

function signature(fn: AbiFn): string {
  return `${fn.name}(${(fn.inputs ?? []).map(abiType).join(",")})`;
}

function abiType(param: AbiParam): string {
  if (!param.type.startsWith("tuple")) return param.type;
  const suffix = param.type.slice("tuple".length);
  return `(${(param.components ?? []).map(abiType).join(",")})${suffix}`;
}

function selectorForSignature(sig: string): string {
  try {
    return toFunctionSelector(`function ${sig}`).toLowerCase();
  } catch {
    return "";
  }
}

function isDailyCapZero(value: string | undefined): boolean {
  if (!value) return false;
  return /^["']?0(?:\s*ether)?["']?$/.test(value.trim());
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function closestSelector(selector: string, choices: string[]): string | undefined {
  if (selector.startsWith("0x") || choices.length === 0) return undefined;
  let best: { choice: string; distance: number } | undefined;
  for (const choice of choices) {
    const distance = levenshtein(selector, choice);
    if (!best || distance < best.distance) best = { choice, distance };
  }
  return best?.choice;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let last = i - 1;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = old;
    }
  }
  return prev[b.length]!;
}
