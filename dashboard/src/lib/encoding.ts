import { stringToHex, type Hex } from "viem";

/**
 * Encode a label/reason string to a right-padded `bytes32`.
 *
 * Mirrors the CLI exactly:
 *   - policy.ts `encodeLabel`: `stringToHex(label, { size: 32 })`
 *   - queue.ts veto reason:    UTF-8 encode → right-pad to 32
 *
 * Both forms produce the same on-chain bytes for any UTF-8 string ≤ 32 bytes.
 * We use `stringToHex(..., { size: 32 })`, which UTF-8 encodes and
 * right-pads with zero bytes — matching `padHex(..., { dir: "right" })`.
 *
 * Throws if the encoded string exceeds 32 bytes; callers should validate
 * upstream for a nicer UX, but this guarantees we never silently truncate.
 */
export function encodeBytes32Label(label: string): Hex {
  const byteLength = new TextEncoder().encode(label).length;
  if (byteLength > 32) {
    throw new Error(`label "${label}" is ${byteLength} bytes; must be ≤ 32 bytes`);
  }
  return stringToHex(label, { size: 32 });
}

export type ParsedIdInput =
  | { kind: "policy"; policyId: Hex }
  | { kind: "exec"; execId: bigint };

/**
 * Parse the jump-to-id top-bar input.
 *
 * Rules (in order):
 *   1. A 0x-prefixed 64-hex-digit string → `policy` (bytes32 policyId).
 *   2. A decimal integer (e.g. "142") → `exec` (uint256 execId).
 *   3. A 0x-prefixed hex shorter than bytes32 → `exec` (parsed as uint).
 *   4. Anything else → null.
 *
 * Whitespace is trimmed.
 */
export function parseIdInput(input: string): ParsedIdInput | null {
  const s = input.trim();
  if (s.length === 0) return null;

  // bytes32 policy id: 0x + 64 hex chars
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
    return { kind: "policy", policyId: s as Hex };
  }

  // decimal exec id
  if (/^[0-9]+$/.test(s)) {
    try {
      return { kind: "exec", execId: BigInt(s) };
    } catch {
      return null;
    }
  }

  // short 0x-prefixed hex → treat as a uint exec id
  if (/^0x[0-9a-fA-F]+$/.test(s)) {
    try {
      return { kind: "exec", execId: BigInt(s) };
    } catch {
      return null;
    }
  }

  return null;
}
