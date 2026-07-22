import type { Hex } from "viem";

/** Encode an ASCII string as Solidity's left-aligned, zero-padded `bytes32("...")`. */
function bytes32Ascii(s: string): Hex {
  if (s.length > 32) {
    throw new Error(`reason-codes: ascii string "${s}" exceeds 32 bytes`);
  }
  let hex = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) {
      throw new Error(`reason-codes: non-ASCII char in "${s}"`);
    }
    hex += c.toString(16).padStart(2, "0");
  }
  return `0x${hex.padEnd(64, "0")}` as Hex;
}

/** Canonical `bytes32(...)` reason codes emitted by `PolicyLib.validate` and `SentryOracle.checkIntent`. */
export const REASON_CODES = {
  OK: `0x${"00".repeat(32)}` as Hex,
  PAUSED: bytes32Ascii("PAUSED"),
  EXPIRED: bytes32Ascii("EXPIRED"),
  BAD_CALLDATA: bytes32Ascii("BAD_CALLDATA"),
  SELECTOR_MISMATCH: bytes32Ascii("SELECTOR_MISMATCH"),
  TARGET_NOT_ALLOWED: bytes32Ascii("TARGET_NOT_ALLOWED"),
  SELECTOR_NOT_ALLOWED: bytes32Ascii("SELECTOR_NOT_ALLOWED"),
  VALUE_CAP: bytes32Ascii("VALUE_CAP"),
  DAILY_CAP: bytes32Ascii("DAILY_CAP"),
  REQUIRES_DELAY: bytes32Ascii("REQUIRES_DELAY"),
  REQUIRES_VETO: bytes32Ascii("REQUIRES_VETO"),
} as const;

export type ReasonName = keyof typeof REASON_CODES;

const NAME_BY_CODE: Record<string, ReasonName> = Object.fromEntries(
  (Object.entries(REASON_CODES) as [ReasonName, Hex][]).map(([name, code]) => [
    code.toLowerCase(),
    name,
  ]),
) as Record<string, ReasonName>;

const DESCRIPTIONS: Record<ReasonName, string> = {
  OK: "Intent allowed by policy.",
  PAUSED: "Policy is paused; the publisher disabled it.",
  EXPIRED: "Policy expiresAt is in the past.",
  BAD_CALLDATA:
    "Intent.data is shorter than 4 bytes; cannot extract a function selector.",
  SELECTOR_MISMATCH:
    "First 4 bytes of intent.data do not match intent.selector.",
  TARGET_NOT_ALLOWED: "Target address is not on the policy's allow list.",
  SELECTOR_NOT_ALLOWED:
    "Selector is not allowed for this target under the policy.",
  VALUE_CAP: "Intent.value exceeds the per-call cap for this selector.",
  DAILY_CAP:
    "Intent.value would push today's running native-spend total past the policy's dailySpendWeiCap.",
  REQUIRES_DELAY:
    "Selector tier is DELAYED; the call must be queued and re-dispatched after the delay window.",
  REQUIRES_VETO:
    "Selector tier is VETO_REQUIRED; the call must be queued and explicitly dispatched by the policy owner.",
};

/** Decode a raw `bytes32` reason into the canonical name and description. */
export function decodeReason(reason: Hex): {
  name: ReasonName | "UNKNOWN";
  description: string;
} {
  const name = NAME_BY_CODE[reason.toLowerCase()];
  if (!name) {
    return {
      name: "UNKNOWN",
      description: `Unknown reason code ${reason}; SDK reason-code table may be out of date.`,
    };
  }
  return { name, description: DESCRIPTIONS[name] };
}
