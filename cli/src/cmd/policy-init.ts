import { readFileSync } from "node:fs";
import { isAddress } from "viem";

export type PolicyProfile = "strict" | "balanced" | "aggressive";

export interface PolicyInitOptions {
  abi: string;
  target: string;
  profile?: PolicyProfile;
  expires?: string;
}

interface AbiParam {
  type: string;
  components?: AbiParam[];
}

interface AbiFunction {
  type: "function";
  name: string;
  inputs?: AbiParam[];
  stateMutability?: "pure" | "view" | "nonpayable" | "payable";
}

export async function policyInitCmd(opts: PolicyInitOptions): Promise<void> {
  console.log(generatePolicyStarter(opts));
}

export function generatePolicyStarter(opts: PolicyInitOptions): string {
  if (!opts.abi) throw new Error("--abi is required");
  if (!opts.target) throw new Error("--target is required");
  if (!isAddress(opts.target)) throw new Error(`--target ${opts.target} is not a valid address`);

  const profile = opts.profile ?? "balanced";
  if (!["strict", "balanced", "aggressive"].includes(profile)) {
    throw new Error(`unknown --profile ${profile}; expected strict, balanced, or aggressive`);
  }

  const abi = readAbi(opts.abi);
  const functions = abi.filter((item): item is AbiFunction => {
    return item.type === "function" && item.stateMutability !== "view" && item.stateMutability !== "pure";
  });

  if (functions.length === 0) {
    throw new Error("ABI has no non-view/non-pure functions to gate");
  }

  // cac can surface omitted string options as the literal "undefined".
  const expiresProvided =
    typeof opts.expires === "string" &&
    opts.expires.trim() !== "" &&
    opts.expires.trim() !== "undefined";
  const expires = expiresProvided
    ? opts.expires!.trim()
    : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const dailySpendWeiCap = profile === "aggressive" ? `"1 ether"  # TODO confirm cap` : `"0 ether"`;

  const lines = [
    "# Starter Ward policy",
    "",
    "```policy",
    'version: "0.1"',
    `dailySpendWeiCap: ${dailySpendWeiCap}`,
    `expiresAt: "${expires}"`,
    "targets:",
    `  - target: "${opts.target}"`,
    "    selectors:",
  ];

  for (const fn of functions) {
    const rule = ruleFor(fn, profile);
    lines.push(`      - selector: "${functionSignature(fn)}"`);
    lines.push(`        tier: ${rule.tier}`);
    lines.push(`        valueCapPerCall: ${rule.valueCap}`);
    lines.push(`        delaySeconds: ${rule.delay}`);
  }

  lines.push("```", "", "");
  return lines.join("\n");
}

function readAbi(path: string): AbiFunction[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const abi = Array.isArray(parsed) ? parsed : (parsed as { abi?: unknown }).abi;
  if (!Array.isArray(abi)) throw new Error(`${path} does not contain an ABI array`);
  return abi as AbiFunction[];
}

function ruleFor(fn: AbiFunction, profile: PolicyProfile): { tier: string; valueCap: string; delay: string } {
  const payable = fn.stateMutability === "payable";
  if (profile === "strict") {
    return {
      tier: "DELAYED",
      valueCap: payable ? `"0 ether"  # TODO set cap` : `"0 ether"  # TODO confirm cap`,
      delay: "86400  # TODO set delay",
    };
  }

  if (profile === "aggressive") {
    return {
      tier: "IMMEDIATE",
      valueCap: payable ? `"1 ether"  # TODO confirm cap` : `"0 ether"  # TODO confirm cap`,
      delay: "0",
    };
  }

  if (isOwnerSensitive(fn.name)) {
    return {
      tier: "VETO_REQUIRED",
      valueCap: payable ? `"0 ether"  # TODO set cap` : `"0 ether"  # TODO confirm cap`,
      delay: "0",
    };
  }

  if (isViewLikeName(fn.name)) {
    return {
      tier: "IMMEDIATE",
      valueCap: payable ? `"0 ether"  # TODO set cap` : `"0 ether"  # TODO confirm cap`,
      delay: "0",
    };
  }

  return {
    tier: "DELAYED",
    valueCap: payable ? `"0 ether"  # TODO set cap` : `"0 ether"  # TODO confirm cap`,
    delay: "300  # TODO set delay",
  };
}

function isOwnerSensitive(name: string): boolean {
  return /(withdraw|transferOwnership|migrate|upgrade|destroy)/i.test(name);
}

function isViewLikeName(name: string): boolean {
  return /^(get|read|peek)/i.test(name);
}

function functionSignature(fn: AbiFunction): string {
  return `${fn.name}(${(fn.inputs ?? []).map(abiType).join(",")})`;
}

function abiType(param: AbiParam): string {
  if (!param.type.startsWith("tuple")) return param.type;
  const suffix = param.type.slice("tuple".length);
  const inner = (param.components ?? []).map(abiType).join(",");
  return `(${inner})${suffix}`;
}
