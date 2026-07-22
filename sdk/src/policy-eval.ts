import type { Address, Hex } from "viem";
import {
  TIER_DELAYED,
  TIER_IMMEDIATE,
  TIER_VETO_REQUIRED,
  type PolicyInput,
  type TierName,
} from "./types.js";
import { REASON_CODES } from "./reason-codes.js";

/** A call observed off-chain (e.g. from txlist polling) that we want to evaluate against a policy. */
export interface ObservedCall {
  target: Address;
  selector: Hex; // 0x + 8 hex
  valueWei: bigint;
  asker: Address;
  timestampSec: bigint;
}

export type Verdict =
  | { allowed: true; tier: TierName; delaySeconds: number }
  | { allowed: false; reason: string };

const TIER_BY_INDEX: Record<number, TierName> = {
  [TIER_IMMEDIATE]: "IMMEDIATE",
  [TIER_DELAYED]: "DELAYED",
  [TIER_VETO_REQUIRED]: "VETO_REQUIRED",
};

/** Pure off-chain policy evaluation for observed calls that need English `reason` strings. */
export function applyPolicyToObservedCall(
  policy: PolicyInput,
  call: ObservedCall,
  spentTodayWei: bigint,
): Verdict {
  if (policy.paused) return { allowed: false, reason: "PAUSED" };
  if (call.timestampSec > policy.expiresAt) return { allowed: false, reason: "EXPIRED" };

  const callTarget = call.target.toLowerCase();
  const target = policy.targets.find((t) => t.target.toLowerCase() === callTarget);
  if (!target) return { allowed: false, reason: "NO_TARGET" };

  const callSelector = call.selector.toLowerCase();
  const entry = target.selectors.find((s) => s.selector.toLowerCase() === callSelector);
  if (!entry) return { allowed: false, reason: "SELECTOR_NOT_ALLOWED" };

  if (call.valueWei > entry.valueCapPerCall) {
    return { allowed: false, reason: "VALUE_EXCEEDS_CAP" };
  }

  // With cap=0, PolicyLib allows zero-value calls and rejects positive native spend.
  if (policy.dailySpendWeiCap === 0n) {
    if (call.valueWei > 0n) {
      return { allowed: false, reason: "DAILY_CAP_EXCEEDED" };
    }
  } else if (spentTodayWei + call.valueWei > policy.dailySpendWeiCap) {
    return { allowed: false, reason: "DAILY_CAP_EXCEEDED" };
  }

  return {
    allowed: true,
    tier: TIER_BY_INDEX[entry.tier]!,
    delaySeconds: Number(entry.delaySeconds),
  };
}

/** Mirrors the Solidity `Intent` struct in `contracts/src/PolicyTypes.sol`. */
export interface EvalIntent {
  agentId: bigint;
  requestId: bigint;
  target: Address;
  selector: Hex; // 4-byte
  data: Hex; // calldata; first 4 bytes must equal `selector`
  value: bigint;
  promptHash: Hex;
  taskClass: number;
}

/** Normalized form of the on-chain `Policy` mappings, keyed by lowercase target and selector. */
export interface EvalPolicy {
  /** Lowercased target address => true if the target is on the allow list. */
  isTargetAllowed: Record<string, boolean>;
  /** Lowercased target address => lowercased selector => true if allowed. */
  isSelectorAllowed: Record<string, Record<string, boolean>>;
  /** Lowercased target address => lowercased selector => per-call value cap (wei). */
  valueCapPerCall: Record<string, Record<string, bigint>>;
  /** Lowercased target address => lowercased selector => tier (0,1,2). */
  tier: Record<string, Record<string, number>>;
  /** Lowercased target address => lowercased selector => delay seconds (uint32). */
  delaySeconds: Record<string, Record<string, number>>;
  dailySpendWeiCap: bigint;
  expiresAt: bigint;
  paused: boolean;
}

/** Project `PolicyInput` into the lookup maps used by `evalCheckIntent`. */
export function evalPolicyFromInput(input: PolicyInput): EvalPolicy {
  const out: EvalPolicy = {
    isTargetAllowed: {},
    isSelectorAllowed: {},
    valueCapPerCall: {},
    tier: {},
    delaySeconds: {},
    dailySpendWeiCap: input.dailySpendWeiCap,
    expiresAt: input.expiresAt,
    paused: input.paused,
  };
  for (const t of input.targets) {
    const tKey = t.target.toLowerCase();
    if (out.isTargetAllowed[tKey]) {
      throw new Error(`evalPolicyFromInput: duplicate target ${t.target}`);
    }
    out.isTargetAllowed[tKey] = true;
    out.isSelectorAllowed[tKey] = {};
    out.valueCapPerCall[tKey] = {};
    out.tier[tKey] = {};
    out.delaySeconds[tKey] = {};
    for (const s of t.selectors) {
      const sKey = s.selector.toLowerCase();
      if (out.isSelectorAllowed[tKey]![sKey]) {
        throw new Error(
          `evalPolicyFromInput: duplicate selector ${s.selector} on target ${t.target}`,
        );
      }
      out.isSelectorAllowed[tKey]![sKey] = true;
      out.valueCapPerCall[tKey]![sKey] = s.valueCapPerCall;
      out.tier[tKey]![sKey] = s.tier;
      out.delaySeconds[tKey]![sKey] = s.delaySeconds;
    }
  }
  return out;
}

/** Extract the lowercased 4-byte selector from calldata, or null for `BAD_CALLDATA`. */
function selectorOfCalldata(data: Hex): Hex | null {
  // 0x-prefixed; each byte is 2 hex chars. 4 bytes => 8 hex chars => length 10.
  if (data.length < 10) return null;
  return (`0x${data.slice(2, 10)}`).toLowerCase() as Hex;
}

// ABI-domain bounds for the on-chain checkIntent surface.
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT32_MAX = (1n << 32n) - 1n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;
const HEX_EVEN_RE = /^0x([0-9a-fA-F]{2})*$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function assertUintRange(name: string, v: bigint, max: bigint): void {
  if (typeof v !== "bigint") {
    throw new TypeError(`evalCheckIntent: ${name} must be a bigint`);
  }
  if (v < 0n || v > max) {
    throw new RangeError(`evalCheckIntent: ${name} (${v}) is out of uint${bitWidthOf(max)} domain`);
  }
}

function bitWidthOf(max: bigint): number {
  if (max === UINT256_MAX) return 256;
  if (max === UINT64_MAX) return 64;
  if (max === UINT32_MAX) return 32;
  return max.toString(2).length;
}

/** Reject inputs outside the Solidity ABI domain for `WardOracle.checkIntent`. */
function validateInputDomain(
  intent: EvalIntent,
  spentTodayWei: bigint,
  nowSec: bigint,
  policy: EvalPolicy,
): void {
  assertUintRange("intent.value", intent.value, UINT256_MAX);
  assertUintRange("spentTodayWei", spentTodayWei, UINT256_MAX);
  assertUintRange("policy.dailySpendWeiCap", policy.dailySpendWeiCap, UINT256_MAX);
  assertUintRange("intent.requestId", intent.requestId, UINT256_MAX);
  assertUintRange("intent.agentId", intent.agentId, UINT256_MAX);
  assertUintRange("policy.expiresAt", policy.expiresAt, UINT64_MAX);
  assertUintRange("nowSec", nowSec, UINT64_MAX);

  if (!Number.isInteger(intent.taskClass) || intent.taskClass < 0 || intent.taskClass > 255) {
    throw new RangeError(
      `evalCheckIntent: intent.taskClass (${intent.taskClass}) is out of uint8 domain`,
    );
  }

  if (typeof intent.target !== "string" || !ADDRESS_RE.test(intent.target)) {
    throw new TypeError(
      `evalCheckIntent: intent.target (${intent.target}) is not a 20-byte hex address`,
    );
  }
  if (typeof intent.selector !== "string" || !SELECTOR_RE.test(intent.selector)) {
    throw new TypeError(
      `evalCheckIntent: intent.selector (${intent.selector}) is not a 4-byte hex selector`,
    );
  }
  if (typeof intent.data !== "string" || !HEX_EVEN_RE.test(intent.data)) {
    throw new TypeError(
      `evalCheckIntent: intent.data (${intent.data}) is not even-length 0x-prefixed hex`,
    );
  }
  if (typeof intent.promptHash !== "string" || !BYTES32_RE.test(intent.promptHash)) {
    throw new TypeError(
      `evalCheckIntent: intent.promptHash (${intent.promptHash}) is not a 32-byte hex value`,
    );
  }

  // Walk hand-built policies too, not just compiler-produced maps.
  for (const targetKey of Object.keys(policy.valueCapPerCall)) {
    if (!ADDRESS_RE.test(targetKey)) {
      throw new TypeError(
        `evalCheckIntent: policy target (${targetKey}) is not a 20-byte hex address`,
      );
    }
    const caps = policy.valueCapPerCall[targetKey]!;
    const delays = policy.delaySeconds[targetKey] ?? {};
    for (const selectorKey of Object.keys(caps)) {
      if (!SELECTOR_RE.test(selectorKey)) {
        throw new TypeError(
          `evalCheckIntent: policy selector (${selectorKey}) on target ${targetKey} is not a 4-byte hex selector`,
        );
      }
      assertUintRange(
        `policy.valueCapPerCall[${targetKey}][${selectorKey}]`,
        caps[selectorKey]!,
        UINT256_MAX,
      );
      const d = delays[selectorKey];
      if (d !== undefined) {
        if (!Number.isInteger(d) || d < 0 || BigInt(d) > UINT32_MAX) {
          throw new RangeError(
            `evalCheckIntent: policy.delaySeconds[${targetKey}][${selectorKey}] (${d}) is out of uint32 domain`,
          );
        }
      }
    }
  }

  // Sweep `policy.delaySeconds` independently in case a hand-built policy has inconsistent maps.
  for (const targetKey of Object.keys(policy.delaySeconds)) {
    if (!ADDRESS_RE.test(targetKey)) {
      throw new TypeError(
        `evalCheckIntent: policy.delaySeconds target (${targetKey}) is not a 20-byte hex address`,
      );
    }
    const delays = policy.delaySeconds[targetKey]!;
    for (const selectorKey of Object.keys(delays)) {
      if (!SELECTOR_RE.test(selectorKey)) {
        throw new TypeError(
          `evalCheckIntent: policy.delaySeconds selector (${selectorKey}) on target ${targetKey} is not a 4-byte hex selector`,
        );
      }
      const d = delays[selectorKey]!;
      if (!Number.isInteger(d) || d < 0 || BigInt(d) > UINT32_MAX) {
        throw new RangeError(
          `evalCheckIntent: policy.delaySeconds[${targetKey}][${selectorKey}] (${d}) is out of uint32 domain`,
        );
      }
    }
  }
}

/** Bit-faithful pure TS port of `WardOracle.checkIntent`, returning canonical `(ok, reason)`. */
export function evalCheckIntent(
  policy: EvalPolicy,
  intent: EvalIntent,
  spentTodayWei: bigint,
  nowSec: bigint,
): { ok: boolean; reason: Hex } {
  // Match what the ABI encoder would accept before applying policy rules.
  validateInputDomain(intent, spentTodayWei, nowSec, policy);

  if (policy.paused) return { ok: false, reason: REASON_CODES.PAUSED };

  // Solidity uses `block.timestamp > expiresAt`; equality is still allowed.
  if (nowSec > policy.expiresAt) return { ok: false, reason: REASON_CODES.EXPIRED };

  const derivedSelector = selectorOfCalldata(intent.data);
  if (derivedSelector === null) {
    return { ok: false, reason: REASON_CODES.BAD_CALLDATA };
  }

  if (derivedSelector !== intent.selector.toLowerCase()) {
    return { ok: false, reason: REASON_CODES.SELECTOR_MISMATCH };
  }

  const targetKey = intent.target.toLowerCase();
  const selectorKey = intent.selector.toLowerCase();

  if (!policy.isTargetAllowed[targetKey]) {
    return { ok: false, reason: REASON_CODES.TARGET_NOT_ALLOWED };
  }

  if (!policy.isSelectorAllowed[targetKey]?.[selectorKey]) {
    return { ok: false, reason: REASON_CODES.SELECTOR_NOT_ALLOWED };
  }

  // Missing per-call caps default to 0 on-chain.
  const valueCap = policy.valueCapPerCall[targetKey]?.[selectorKey] ?? 0n;
  if (intent.value > valueCap) {
    return { ok: false, reason: REASON_CODES.VALUE_CAP };
  }

  // Preserve PolicyLib.sol's cap=0 behavior: zero-value calls still pass.
  if (
    spentTodayWei > policy.dailySpendWeiCap ||
    intent.value > policy.dailySpendWeiCap - spentTodayWei
  ) {
    return { ok: false, reason: REASON_CODES.DAILY_CAP };
  }

  // Missing tiers default to IMMEDIATE on-chain.
  const tier = policy.tier[targetKey]?.[selectorKey] ?? 0;
  if (tier === TIER_DELAYED) {
    return { ok: false, reason: REASON_CODES.REQUIRES_DELAY };
  }
  if (tier === TIER_VETO_REQUIRED) {
    return { ok: false, reason: REASON_CODES.REQUIRES_VETO };
  }

  return { ok: true, reason: REASON_CODES.OK };
}
