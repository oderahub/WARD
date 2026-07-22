/**
 * Selector → human-readable signature lookup for the policy drawer's TARGETS
 * section and probe picker.
 *
 * The on-chain PolicyInput stores function permissions as raw 4-byte selectors
 * (`bytes4`). For display we want "transfer(address,uint256)" rather than
 * "0xa9059cbb". The tx calldata that originally published the policy doesn't
 * carry the signature strings — they're hashed away into bytes4 — so we can't
 * recover them from chain.
 *
 * This module ships a small hardcoded map of the selectors the Sentry tutorial
 * + common ERC-20 / agent-trading flows actually use. Unknown selectors render
 * as their hex form (which is still useful: an operator can paste it into
 * 4byte.directory if they need the human name). Async 4byte lookup is
 * intentionally deferred — the drawer must render synchronously and a network
 * round-trip per selector would slow it down for no functional benefit.
 *
 * Selector hashes here are the canonical bytes4 prefixes of keccak256 of the
 * function signature (verified via viem's `toFunctionSelector`).
 */
import type { Hex } from "viem";

const KNOWN_SELECTORS: ReadonlyMap<Hex, string> = new Map<Hex, string>([
  // ERC-20 core
  ["0xa9059cbb", "transfer(address,uint256)"],
  ["0x23b872dd", "transferFrom(address,address,uint256)"],
  ["0x095ea7b3", "approve(address,uint256)"],
  ["0x70a08231", "balanceOf(address)"],
  ["0x40c10f19", "mint(address,uint256)"],
  ["0x42966c68", "burn(uint256)"],
]);

/**
 * Normalize a selector hex to lowercase. The on-chain ABI guarantees lowercase
 * bytes4 but cached / hand-edited JSON sometimes carries mixed case, and Map
 * lookup is case-sensitive. Centralizing this keeps the lookup tolerant
 * without baking an extra entry per selector into the map.
 */
function normalizeSelector(selector: Hex): Hex {
  return selector.toLowerCase() as Hex;
}

/**
 * Returns the human-readable signature for a known selector, or `undefined`
 * if the selector isn't in the built-in map. Use `formatSelector` when you
 * want a guaranteed-display string instead.
 */
export function lookupSelector(selector: Hex): string | undefined {
  return KNOWN_SELECTORS.get(normalizeSelector(selector));
}

/**
 * Display formatter: returns the signature if known, otherwise the lowercased
 * hex form. Always safe to render in the UI without an `??`-fallback. The
 * unknown-case returning the hex is intentional — it's the most useful thing
 * we can show without a network round-trip.
 */
export function formatSelector(selector: Hex): string {
  return lookupSelector(selector) ?? normalizeSelector(selector);
}

/**
 * Edit-flow seed helper: turns an on-chain bytes4 selector into the string the
 * SelectorDraft form input should show. If the selector matches a known
 * signature, return the signature so the operator sees `transfer(address,
 * uint256)` instead of `0xa9059cbb` — the signature round-trips cleanly through
 * the SDK compiler back to the same bytes4. If unknown, return the lowercased
 * hex form (the schema's semantic path accepts both, and SelectorRow renders
 * an inline "raw bytes4" warning so the operator can paste a signature in to
 * replace it).
 *
 * Distinct from `formatSelector` (display-only) because the SAME string is
 * also fed into the form input — keeping the helpers separate makes it
 * explicit which call sites are display vs. round-trippable form seed.
 */
export function selectorToDraftString(selector: Hex): string {
  return lookupSelector(selector) ?? normalizeSelector(selector);
}

/**
 * Tier name lookup (mirrors the SDK's TIER_NAMES order). Lives here rather
 * than re-exporting from the SDK so the drawer's render code stays self-
 * contained to a single helper module.
 */
const TIER_LABELS = ["IMMEDIATE", "DELAYED", "VETO_REQUIRED"] as const;
export type TierLabel = (typeof TIER_LABELS)[number];

export function tierLabel(tier: number): TierLabel | string {
  return TIER_LABELS[tier] ?? `tier:${tier}`;
}

/**
 * Plain-English label for each tier. The enum names (IMMEDIATE / DELAYED /
 * VETO_REQUIRED) are kept as the canonical value at the contract / SDK / form
 * boundary, but DISPLAY surfaces (drawer badges, select option text, diff
 * rows) read better with human wording — operators routinely stumble on
 * "veto" especially. Keep these short; the longer subtitle copy already
 * lives in `SelectorRow.TIER_DESCRIPTIONS`.
 */
export const TIER_HUMAN_LABELS = {
  IMMEDIATE: "Auto-approve",
  DELAYED: "Wait then auto-approve",
  VETO_REQUIRED: "Needs owner approval",
} as const;

/**
 * Display-only humanizer for tier values. Accepts either the enum string or
 * the numeric tier int that the on-chain struct uses (PolicyDiff renders
 * straight from `SelectorRule.tier: number`). Unknown values fall back to
 * the tier-int form so nothing crashes on a hypothetical future tier.
 */
export function humanizeTier(
  tier: "IMMEDIATE" | "DELAYED" | "VETO_REQUIRED" | number,
): string {
  const key = typeof tier === "number" ? tierLabel(tier) : tier;
  return (
    TIER_HUMAN_LABELS[key as keyof typeof TIER_HUMAN_LABELS] ?? String(key)
  );
}

/**
 * Plain-English labels for the POLICY.md scalar field names that surface in
 * the diff view. The publish form stays closer to the YAML field names (so
 * operators editing the markdown directly recognize them), but the diff
 * preview is a read-only confirmation surface where the friendlier wording
 * is less ambiguous. Unknown keys fall through to the raw field name in the
 * consumer.
 */
export const FIELD_HUMAN_LABELS: Record<string, string> = {
  dailySpendWeiCap: "Daily native (STT) spend cap",
  maxSlippageBps: "Max slippage (adapter metadata)",
  expiresAt: "Valid until",
  paused: "Paused",
};

/**
 * Known-target lookup — same shape as KNOWN_SELECTORS but for contract
 * addresses. Lets the policy drawer and edit modal render canonical Sentry
 * deployments under a friendly label instead of an opaque hex address.
 * Lowercased addresses are the lookup key; the lookup is case-insensitive.
 *
 * Currently empty: the v2 oracle + queue addresses are already resolved
 * synchronously by `contractName.ts`'s LOCAL map (which is the source of
 * truth for AddressChip rendering). The map is kept so consumers that
 * already call `lookupTarget` for downstream targets keep compiling — they
 * just fall through to the shortened-hex UI.
 */
const KNOWN_TARGETS: ReadonlyMap<string, string> = new Map<string, string>([]);

/**
 * Returns the friendly label for a known target address, or `undefined` if
 * the address isn't in the built-in map. Accepts any-case input.
 */
export function lookupTarget(address: string): string | undefined {
  return KNOWN_TARGETS.get(address.toLowerCase());
}
