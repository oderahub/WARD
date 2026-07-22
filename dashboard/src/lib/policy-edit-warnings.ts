import { formatEther } from "viem";
import type { PolicyInput } from "@ward/sdk";

/**
 * Pure helpers extracted from the policy edit modals for UX warnings.
 * Kept here (instead of inline in the components) so they can be unit-tested
 * without React/wagmi setup. Imports from `viem` only — no DOM, no hooks.
 */

/**
 * Per-selector dotted path -> info message map for the
 * "per-call cap exceeds daily cap" note.
 *
 * Rendered as a per-row INFO note (not an error): the on-chain contract still
 * lets the first such call through each day; we just want the operator to
 * know subsequent calls in the same UTC day will be blocked by the daily cap.
 *
 * Returns an empty map when `dailySpendWeiCap === 0n` (zero means "no native
 * spend allowed at all" post-Wave-1 honesty rename — the per-call vs daily
 * comparison is meaningless when the daily cap is a hard zero).
 */
export function computePerCallExceedsDailyWarnings(
  input: PolicyInput,
): Map<string, string> {
  const out = new Map<string, string>();
  const daily = input.dailySpendWeiCap;
  if (daily <= 0n) return out;
  input.targets.forEach((t, ti) => {
    t.selectors.forEach((s, si) => {
      if (s.valueCapPerCall > daily) {
        const path = `targets.${ti}.selectors.${si}.valueCapPerCall`;
        out.set(
          path,
          `Per-call native cap (${formatEther(s.valueCapPerCall)} STT) exceeds daily native cap (${formatEther(daily)} STT). Only the first such payable call per day will succeed.`,
        );
      }
    });
  });
  return out;
}

/**
 * Aggregate-cap info note: when the SUM of every selector's
 * `valueCapPerCall` exceeds the daily cap, only a subset of calls can succeed
 * per UTC day. This is NOT an error — it's a perfectly legal policy shape and
 * sometimes intentional (e.g. high per-call caps for occasional large trades,
 * low daily ceiling) — but the operator should know the daily cap, not the
 * per-call caps, is the binding constraint.
 *
 * Returns `{ note: null }` when `dailySpendWeiCap === 0n` (the per-call vs
 * daily comparison is meaningless; per-row zero-cap warnings handle that case)
 * or when the sum fits inside the daily cap.
 */
export function computeAggregateCapNote(
  input: PolicyInput,
): { note: string | null } {
  const daily = input.dailySpendWeiCap;
  if (daily <= 0n) return { note: null };
  let sum = 0n;
  for (const t of input.targets) {
    for (const s of t.selectors) {
      sum += s.valueCapPerCall;
    }
  }
  if (sum <= daily) return { note: null };
  return {
    note: `Sum of per-call native caps (${formatEther(sum)} STT) exceeds daily native cap (${formatEther(daily)} STT). Only a subset of payable calls can succeed per day.`,
  };
}

/**
 * Whether a PolicyInput is currently paused or expired at the given epoch
 * second. Matches PolicyDrawer's legacy-0 treatment: `expiresAt === 0n`
 * counts as expired regardless of `nowSec` (the Ward contract treats the
 * sentinel as already-elapsed post-Wave-1).
 *
 * Returned shape lets the caller pick the right wording — "paused", "expired",
 * or "paused and expired" — without re-deriving the booleans.
 */
export function policyLifetimeState(
  input: Pick<PolicyInput, "paused" | "expiresAt">,
  nowSec: bigint,
): { isPaused: boolean; isExpired: boolean } {
  const isPaused = input.paused === true;
  const isExpired =
    input.expiresAt === 0n || input.expiresAt <= nowSec;
  return { isPaused, isExpired };
}

/**
 * Detects "destructive" edits to a PolicyInput body: changes that REMOVE
 * capabilities the previous policy allowed, or LOWER any per-call / daily
 * cap. Drives the acknowledgement checkbox in EditPolicyModal —
 * operators should consciously confirm they're shrinking the policy.
 *
 * Adding targets/selectors, raising caps, or extending the expiry are NOT
 * destructive from the policy-capability perspective. Separately, any saved
 * policy body update invalidates pending WardQueue entries through the
 * on-chain policy version check.
 *
 * Targets/selectors are compared lower-cased to mirror `policyInputsEqual`
 * — the on-chain key is the lowercased bytes, so case-only diffs aren't
 * removals.
 */
export function computeDestructive(
  before: PolicyInput,
  after: PolicyInput,
): boolean {
  if (after.dailySpendWeiCap < before.dailySpendWeiCap) return true;

  const afterTargets = new Map(
    after.targets.map((t) => [t.target.toLowerCase(), t]),
  );

  for (const bt of before.targets) {
    const at = afterTargets.get(bt.target.toLowerCase());
    if (!at) return true; // target removed
    const afterSelectors = new Map(
      at.selectors.map((s) => [s.selector.toLowerCase(), s]),
    );
    for (const bs of bt.selectors) {
      const as = afterSelectors.get(bs.selector.toLowerCase());
      if (!as) return true; // selector removed
      if (as.valueCapPerCall < bs.valueCapPerCall) return true; // cap lowered
    }
  }
  return false;
}
