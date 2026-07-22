import yaml from "js-yaml";
import Ajv, { type JSONSchemaType } from "ajv";
import {
  isAddress,
  parseAbiItem,
  toFunctionSelector,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import {
  TIER_NAMES,
  type PolicyInput,
  type SelectorRule,
  type Tier,
  type TierName,
} from "./types.js";
import { parseEtherFlexible } from "./policy-builder.js";

/** The on-disk shape of a POLICY.md fenced YAML block. */
interface RawSelector {
  selector: string; // "0x12345678" OR "transfer(address,uint256)"
  valueCapPerCall?: string | number;
  tier: TierName;
  delaySeconds?: number;
}

interface RawTarget {
  target: string;
  selectors: RawSelector[];
}

interface RawPolicy {
  version: string;
  dailySpendWeiCap?: string | number;
  maxSlippageBps?: number;
  expiresAt: string | number;
  paused?: boolean;
  targets: RawTarget[];
}

const schema: JSONSchemaType<RawPolicy> = {
  type: "object",
  additionalProperties: false,
  required: ["version", "expiresAt", "targets"],
  properties: {
    version: { type: "string" },
    dailySpendWeiCap: {
      type: ["string", "number"] as unknown as "string",
      nullable: true,
    } as never,
    maxSlippageBps: { type: "integer", minimum: 0, maximum: 10000, nullable: true },
    expiresAt: { type: ["string", "number"] as unknown as "string" } as never,
    paused: { type: "boolean", nullable: true },
    targets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "selectors"],
        properties: {
          target: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          selectors: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["selector", "tier"],
              properties: {
                selector: { type: "string" },
                valueCapPerCall: {
                  type: ["string", "number"] as unknown as "string",
                  nullable: true,
                } as never,
                tier: {
                  type: "string",
                  enum: ["IMMEDIATE", "DELAYED", "VETO_REQUIRED"],
                },
                delaySeconds: { type: "integer", minimum: 0, nullable: true },
              },
            },
          },
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validateRaw = ajv.compile<RawPolicy>(schema);

/** Clock-skew slack for the past-expiry refine; mirrors dashboard `SAFETY_WINDOW_MS`. */
const SAFETY_WINDOW_SEC = 60n;

/** Cap policy lifetime at 5 years; mirrors dashboard `MAX_POLICY_LIFETIME_MS`. */
const MAX_POLICY_LIFETIME_SEC = 157_680_000n; // 5 * 365 * 24 * 60 * 60

/** `Policy.expiresAt` is uint64 on-chain; reject above this to avoid silent truncation. */
const UINT64_MAX = (1n << 64n) - 1n;

/** Zero address is the starter-template placeholder; rejected for a friendlier error. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** ABI-width bounds for `dailySpendWeiCap` / `valueCapPerCall` (uint256) and `delaySeconds` (uint32). */
const UINT32_MAX = (1n << 32n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/** Canonical EVM precompiles (0x01..0x0a) plus RIP-7212 (0x100). */
const PRECOMPILE_ADDRESSES: readonly number[] = [
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x100,
];

export interface CompileOptions {
  /** Tag name to look for on the fenced block. Default: "policy". An untagged block also matches. */
  fenceTag?: string;
  /** Oracle deployment address; matching targets are rejected. */
  oracleAddress?: Address;
  /** Action-queue deployment address; matching targets are rejected. */
  queueAddress?: Address;
  /**
   * Policy label supplied separately to `setPolicy`; rejects control bytes but allows spaces
   * for round-tripping existing on-chain labels.
   */
  label?: string;
}

/** Compile a POLICY.md fenced YAML block into canonical `PolicyInput`. */
export function compilePolicy(markdown: string, opts: CompileOptions = {}): PolicyInput {
  const tag = opts.fenceTag ?? "policy";
  const block = extractFencedBlock(markdown, tag);
  if (!block) {
    throw new Error(
      `compilePolicy: no fenced \`${tag}\` block found (and no untagged block). Wrap your YAML in \`\`\`${tag} ... \`\`\``
    );
  }

  let raw: unknown;
  try {
    raw = yaml.load(block);
  } catch (e) {
    throw new Error(`compilePolicy: YAML parse error: ${(e as Error).message}`);
  }
  // Target `name` is not stored on-chain; reject it instead of silently dropping authored metadata.
  if (raw && typeof raw === "object" && Array.isArray((raw as { targets?: unknown }).targets)) {
    const targets = (raw as { targets: unknown[] }).targets;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t && typeof t === "object" && "name" in (t as object)) {
        throw new Error(
          "compilePolicy: Target `name` is not stored on-chain. Use a description in the policy header instead.",
        );
      }
    }
  }
  if (!validateRaw(raw)) {
    const msg = (validateRaw.errors ?? [])
      .map((e) => `${e.instancePath || "<root>"} ${e.message ?? ""}`.trim())
      .join("; ");
    throw new Error(`compilePolicy: schema validation failed: ${msg}`);
  }

  if (opts.label !== undefined) {
    validateLabel(opts.label);
  }

  return normalize(raw, opts);
}

function extractFencedBlock(md: string, tag: string): string | null {
  const tagged = new RegExp("```" + tag + "\\s*\\n([\\s\\S]*?)```", "m");
  const taggedMatch = md.match(tagged);
  if (taggedMatch) return taggedMatch[1] ?? null;
  const untaggedAll = [...md.matchAll(/```\s*\n([\s\S]*?)```/gm)];
  if (untaggedAll.length === 1) return untaggedAll[0][1] ?? null;
  if (untaggedAll.length > 1) {
    throw new Error(
      `compilePolicy: ${untaggedAll.length} untagged code blocks found; tag one with \`\`\`${tag} to disambiguate.`
    );
  }
  return null;
}

function normalize(raw: RawPolicy, opts: CompileOptions): PolicyInput {
  const reserved = buildReservedSet(opts);
  const targets = raw.targets.map((t) => normalizeTarget(t, reserved));
  // Match the contract's duplicate target/selector rejects before publishing.
  const seenTargets = new Set<string>();
  for (const t of targets) {
    const key = t.target.toLowerCase();
    if (seenTargets.has(key)) {
      throw new Error(
        `compilePolicy: duplicate target ${t.target} (case-insensitive); the on-chain Policy stores one entry per target.`,
      );
    }
    seenTargets.add(key);
    const seenSelectors = new Set<string>();
    for (const s of t.selectors) {
      const key2 = s.selector.toLowerCase();
      if (seenSelectors.has(key2)) {
        throw new Error(
          `compilePolicy: duplicate selector ${s.selector} on target ${t.target} (same bytes4 as another in this target).`,
        );
      }
      seenSelectors.add(key2);
    }
  }
  const dailyCap = raw.dailySpendWeiCap !== undefined
    ? parseEtherFlexible(String(raw.dailySpendWeiCap))
    : 0n;
  // `Policy.dailySpendWeiCap` is uint256 on-chain.
  if (dailyCap > UINT256_MAX) {
    throw new Error(
      "compilePolicy: dailySpendWeiCap exceeds uint256 max.",
    );
  }
  const expiresAt = normalizeTimestamp(raw.expiresAt);

  // `expiresAt: 0` is already expired on-chain.
  if (expiresAt === 0n) {
    throw new Error(
      "compilePolicy: Policy expiresAt cannot be 0 (Sentry treats 0 as already-expired).",
    );
  }
  // The slack absorbs client/RPC clock skew at the publish boundary.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiresAt > 0n && expiresAt <= nowSec + SAFETY_WINDOW_SEC) {
    throw new Error(
      `compilePolicy: Policy expiresAt (${expiresAt.toString()}) is at or before now+${SAFETY_WINDOW_SEC.toString()}s safety window (now=${nowSec.toString()}). Pick a timestamp further in the future.`,
    );
  }
  // Check uint64 before the 5-year soft cap so the error names the hard bound.
  if (expiresAt > UINT64_MAX) {
    throw new Error(
      `compilePolicy: Policy expiresAt (${expiresAt.toString()}) exceeds uint64 range; the on-chain Policy stores expiresAt as uint64.`,
    );
  }
  if (expiresAt > nowSec + MAX_POLICY_LIFETIME_SEC) {
    throw new Error(
      `compilePolicy: Policy expiresAt (${expiresAt.toString()}) is more than 5 years from now (now=${nowSec.toString()}, max=${(nowSec + MAX_POLICY_LIFETIME_SEC).toString()}).`,
    );
  }

  return {
    targets,
    dailySpendWeiCap: dailyCap,
    maxSlippageBps: raw.maxSlippageBps ?? 0,
    expiresAt,
    paused: raw.paused ?? false,
  };
}

function normalizeTarget(
  t: RawTarget,
  reserved: Set<string>,
): { target: Address; selectors: SelectorRule[] } {
  // Reject the starter-template placeholder before checksum/reserved-address checks.
  if (t.target.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(
      "compilePolicy: Target cannot be the zero address (placeholder).",
    );
  }
  // Viem strict mode rejects bad mixed-case EIP-55 checksums.
  if (!isAddress(t.target, { strict: true })) {
    throw new Error(
      `compilePolicy: target ${t.target} fails EIP-55 checksum (use all-lowercase or a correctly-checksummed mixed-case address).`,
    );
  }
  // Policies cannot target their own gatekeeper or canonical EVM precompiles.
  if (reserved.has(t.target.toLowerCase())) {
    throw new Error(
      `compilePolicy: target ${t.target} is a reserved address (oracle, queue, or EVM precompile); a policy cannot target its own gatekeeper or a precompile.`,
    );
  }
  return {
    target: t.target as Address,
    selectors: t.selectors.map((s) => normalizeSelector(s)),
  };
}

function normalizeSelector(s: RawSelector): SelectorRule {
  const selector = computeSelector(s.selector);
  const tier: Tier = TIER_NAMES[s.tier];
  const delay = s.delaySeconds ?? 0;
  // `SelectorRule.delaySeconds` is uint32 on-chain.
  if (BigInt(delay) > UINT32_MAX) {
    throw new Error(
      `compilePolicy: Selector ${s.selector}: delaySeconds exceeds uint32 max (4294967295).`,
    );
  }
  // `valueCapPerCall` must be explicit, including "0".
  if (s.valueCapPerCall === undefined) {
    throw new Error(
      `compilePolicy: Selector ${s.selector}: valueCapPerCall is required. Use "0" to block all native value.`,
    );
  }
  const cap = parseEtherFlexible(String(s.valueCapPerCall));
  // `SelectorRule.valueCapPerCall` is uint256 on-chain.
  if (cap > UINT256_MAX) {
    throw new Error(
      `compilePolicy: Selector ${s.selector}: valueCapPerCall exceeds uint256 max.`,
    );
  }
  if (tier === TIER_NAMES.IMMEDIATE && delay !== 0) {
    throw new Error(`compilePolicy: IMMEDIATE selector ${s.selector} must not set delaySeconds`);
  }
  if (tier === TIER_NAMES.VETO_REQUIRED && delay !== 0) {
    throw new Error(`compilePolicy: VETO_REQUIRED selector ${s.selector} must not set delaySeconds`);
  }
  // DELAYED with `delaySeconds: 0` collapses to IMMEDIATE semantics on-chain.
  if (tier === TIER_NAMES.DELAYED && delay <= 0) {
    throw new Error(
      `compilePolicy: DELAYED selector ${s.selector} requires delaySeconds > 0 (otherwise it behaves as IMMEDIATE).`,
    );
  }
  return {
    selector,
    valueCapPerCall: cap,
    tier,
    delaySeconds: delay,
  };
}

/** Resolve a selector field to canonical 4-byte hex, validating signature-form selectors with viem. */
function computeSelector(raw: string): Hex {
  if (isHexSelector(raw)) return raw as Hex;
  try {
    // Prefixing with `function` narrows `parseAbiItem` to an `AbiFunction`.
    const item = parseAbiItem(`function ${raw}`) as AbiFunction;
    return toFunctionSelector(item);
  } catch (e) {
    throw new Error(
      `compilePolicy: malformed function signature \`${raw}\`: ${(e as Error).message}`,
    );
  }
}

function normalizeTimestamp(v: string | number): bigint {
  if (typeof v === "number") return BigInt(Math.floor(v));
  const trimmed = v.trim();
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  const parsed = Date.parse(trimmed);
  if (isNaN(parsed)) {
    throw new Error(`compilePolicy: cannot parse expiresAt: ${v}`);
  }
  return BigInt(Math.floor(parsed / 1000));
}

function isHexSelector(s: string): boolean {
  return /^0x[0-9a-fA-F]{8}$/.test(s);
}

function buildReservedSet(opts: CompileOptions): Set<string> {
  const set = new Set<string>();
  if (opts.oracleAddress) set.add(opts.oracleAddress.toLowerCase());
  if (opts.queueAddress) set.add(opts.queueAddress.toLowerCase());
  for (const n of PRECOMPILE_ADDRESSES) {
    set.add(`0x${n.toString(16).padStart(40, "0")}`);
  }
  return set;
}

/** Reject label control bytes that survive bytes32 padding and corrupt text rendering. */
function validateLabel(label: string): void {
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (code === 0) {
      throw new Error("compilePolicy: label must not contain NUL (\\0) bytes.");
    }
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `compilePolicy: label must not contain control bytes (found U+${code
          .toString(16)
          .padStart(4, "0")
          .toUpperCase()} at index ${i}).`,
      );
    }
  }
}
