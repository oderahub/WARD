/**
 * Deterministic policy-tier recommender for the Watch Wizard.
 *
 * Consumes a `DiscoveryReport` (see `./discovery.ts`) and produces three
 * tiered recommendations (CONSERVATIVE / BALANCED / AGGRESSIVE) plus a
 * defaultTier hint and a boolean `observationOnly` flag.
 *
 * Hard constraints:
 *
 *   1. Pure function. Same `(report, opts.nowSec)` → byte-identical output.
 *      No `Date.now()`, no `Math.random()`, no env reads, no I/O.
 *      `opts.nowSec` is REQUIRED — pin time at the call site.
 *
 *   2. NO speculative defaults. The recommender does NOT fabricate a
 *      `(target, selector)` pair from heuristics:
 *
 *        - NEVER emits `SelectorRule.selector === '0x00000000'` — that
 *          reverts `ZeroSelector(target)` in PolicyNormalizer.copy, which
 *          simulateAndWritePublish surfaces, breaking the publish path.
 *
 *        - NEVER substitutes the oracle / queue / registry address for a
 *          "real" target — the SDK YAML compiler rejects those as reserved,
 *          so the operator could not later refine the emitted policy.
 *
 *      A fully-formed `PolicyInput` is attached ONLY when discovery resolved
 *      a real `targets[]` from a live registry-bound policy. Otherwise the
 *      wizard's Step 3 picker collects real `(target, selector[])` pairs and
 *      builds the input via `buildPolicyInputFromRecommendation`.
 *
 *   3. Observation-only honesty. `observationOnly = !wardAware`. The
 *      recommender does NOT emit a tier=VETO_REQUIRED policy for an agent
 *      that will never call WardOracle.checkIntent.
 *
 * Default-tier rules live in `pickDefaultTier` and tier parameters in
 * `tierParametersFor`; reading those two functions reproduces every
 * recommendation by hand.
 */

import type { Address, Hex } from "viem";
import {
  TIER_DELAYED,
  TIER_IMMEDIATE,
  TIER_VETO_REQUIRED,
  type PolicyInput,
  type SelectorRule,
  type TargetRule,
  type Tier,
} from "@ward/sdk";

import type { DiscoveryReport } from "./discovery";

export type TierName = "conservative" | "balanced" | "aggressive";

/**
 * Tier parameters that don't depend on the operator-supplied (target,
 * selector) set. These are the per-tier knobs the recommender CAN set
 * deterministically; they slot into a `PolicyInput` once the wizard's
 * Step 3 picker supplies a real `TargetRule[]`.
 */
export interface TierParameters {
  /** Maps to `SelectorRule.tier`. */
  tier: Tier;
  /** Maps to `SelectorRule.delaySeconds`. Only non-zero for DELAYED. */
  delaySeconds: number;
  /** Maps to `SelectorRule.valueCapPerCall`. */
  valueCapPerCall: bigint;
  /** Maps to `PolicyInput.dailySpendWeiCap`. */
  dailySpendWeiCap: bigint;
  /** Maps to `PolicyInput.maxSlippageBps`. */
  maxSlippageBps: number;
  /** Maps to `PolicyInput.expiresAt` — absolute unix seconds (NOT a delta). */
  expiresAt: bigint;
  /** Maps to `PolicyInput.paused`. */
  paused: boolean;
}

/**
 * One tier's full recommendation. `policy` is present ONLY when discovery
 * resolved real targets from a live registry-bound policy.
 */
export interface TierRecommendation {
  name: TierName;
  parameters: TierParameters;
  /** Structured reasoning the wizard renders as a bullet list. */
  reasoningBullets: string[];
  /**
   * Joined human-readable form of `reasoningBullets`. Provided for callers
   * that just want a single string (e.g. tooltip, log line) without
   * re-joining at the call site.
   */
  reasoning: string;
  /**
   * Fully-formed PolicyInput. Set ONLY when:
   *   - report.wardAware.wardAware === true
   *   - report.wardAware.evidence.kind === 'registry'
   *   - report.wardAware.evidence.resolvedTargets !== undefined and
   *     non-empty (every TargetRule has at least one SelectorRule with a
   *     non-zero selector).
   *
   * In that case the recommender re-stamps the existing targets[] with
   * this tier's `(tier, delaySeconds, valueCapPerCall)` so simulate+publish
   * is a one-click apply. When `policy === undefined`, the wizard's Step 3
   * picker MUST collect real (target, selector) pairs and call
   * `buildPolicyInputFromRecommendation` to assemble the on-chain payload.
   */
  policy: PolicyInput | undefined;
}

export interface RecommendationResult {
  conservative: TierRecommendation;
  balanced: TierRecommendation;
  aggressive: TierRecommendation;
  defaultTier: TierName;
  /**
   * True iff the agent is NOT Ward-aware. The wizard surfaces this so
   * the operator sees the "alerts are observation-only, calls are not
   * gated in real time" banner before they pick a tier.
   */
  observationOnly: boolean;
  /**
   * Reasoning attached to the defaultTier selection itself (separate from
   * each tier's reasoning). Lets the wizard show "we picked BALANCED
   * because …" beside the tier card without recomputing.
   */
  defaultTierReason: string;
}

export interface RecommendOpts {
  /**
   * Current unix-seconds timestamp, pinned by the caller. REQUIRED. The
   * caller MUST capture it to a single moment (e.g. the wizard pins it at
   * discovery time via `BigInt(Math.floor(Date.now() / 1000))`; the unit
   * test pins a fixed literal). Within one such moment, retries with the
   * same `(report, nowSec)` produce byte-identical policy output. There is
   * intentionally no fallback; callers must pin time once.
   */
  nowSec: bigint;
}

const SECONDS_PER_HOUR = 3_600n;
const SECONDS_PER_DAY = 24n * SECONDS_PER_HOUR;
const ONE_STT_WEI = 10n ** 18n;
const TENTH_STT_WEI = 10n ** 17n;

/** 5-minute delay window — matches the spec note about "human window to react to a Slack alert". */
const BALANCED_DELAY_SECONDS = 300;

function tierParametersFor(tier: TierName, nowSec: bigint): TierParameters {
  switch (tier) {
    case "conservative":
      return {
        tier: TIER_VETO_REQUIRED,
        delaySeconds: 0,
        valueCapPerCall: 0n,
        dailySpendWeiCap: 0n,
        maxSlippageBps: 50,
        expiresAt: nowSec + SECONDS_PER_DAY,
        paused: false,
      };
    case "balanced":
      return {
        tier: TIER_DELAYED,
        delaySeconds: BALANCED_DELAY_SECONDS,
        valueCapPerCall: TENTH_STT_WEI,
        dailySpendWeiCap: ONE_STT_WEI,
        maxSlippageBps: 100,
        expiresAt: nowSec + 7n * SECONDS_PER_DAY,
        paused: false,
      };
    case "aggressive":
      return {
        tier: TIER_IMMEDIATE,
        delaySeconds: 0,
        valueCapPerCall: ONE_STT_WEI,
        dailySpendWeiCap: 5n * ONE_STT_WEI,
        maxSlippageBps: 300,
        expiresAt: nowSec + 30n * SECONDS_PER_DAY,
        paused: false,
      };
  }
}

/**
 * Tier-agnostic narration of what each tier MEANS at the oracle level.
 * Prepended to the branch-specific bullet so the operator understands the
 * semantics without cross-referencing PolicyLib.sol.
 */
function tierSemanticsBullet(tier: TierName): string {
  switch (tier) {
    case "conservative":
      return "VETO_REQUIRED: WardOracle.checkIntent rejects every matching call with REQUIRES_VETO. Only the policy owner can dispatch it via WardQueue.";
    case "balanced":
      return `DELAYED: WardOracle.checkIntent rejects with REQUIRES_DELAY; the call must be enqueued and waits ${BALANCED_DELAY_SECONDS}s before WardQueue lets it through.`;
    case "aggressive":
      return "IMMEDIATE: WardOracle.checkIntent returns (true, 0) for matching calls. No delay, no human gate.";
  }
}

/**
 * Per-branch reasoning bullets, keyed by which rule fired in
 * `pickDefaultTier`. Surfaces the SAME text to the wizard regardless of
 * which tier card is being rendered — the wizard prepends the
 * tier-semantics bullet via `tierSemanticsBullet`.
 *
 * Bullets are deterministic strings (no template substitution that would
 * vary between calls for the same input). Keep them short — the wizard
 * lays them out as `<li>` elements.
 */
type BranchRule =
  | "no-ward-path"
  | "token-contract"
  | "eoa-zero-nonce"
  | "eoa-active"
  | "registered-in-registry"
  | "queue-evidence"
  | "fallback-unknown";

function branchBullets(rule: BranchRule, report: DiscoveryReport): string[] {
  switch (rule) {
    case "no-ward-path":
      return [
        "No WardOracle / WardQueue interaction found in the last 5000 blocks. Alerts will be observation-only, so the safest default is VETO_REQUIRED.",
      ];
    case "token-contract": {
      const which = report.kind === "erc20" ? "ERC-20" : "ERC-721";
      return [
        `Address fingerprints as an ${which} token contract; tokens should not be wrapped as agents. Confirm before publishing.`,
      ];
    }
    case "eoa-zero-nonce":
      return [
        "Address is an EOA that has never originated an on-chain transaction.",
        "Start conservative until the agent demonstrates behaviour.",
      ];
    case "eoa-active":
      return [
        `Active EOA agent with on-chain history (nonce = ${report.nonce}); DELAYED with a 5-minute window is a balanced starting point.`,
      ];
    case "registered-in-registry":
      return [
        "Already registered in WardAgentRegistry; balanced delay matches typical Ward-aware agent UX.",
      ];
    case "queue-evidence":
      return [
        "Has routed intents through WardQueue. Ward-aware, balanced default applies.",
      ];
    case "fallback-unknown":
      return [
        "No specific signal matched; conservative default applies.",
      ];
  }
}

interface DefaultPick {
  tier: TierName;
  rule: BranchRule;
}

/**
 * Top-down evaluation of the rule table from the file header. First match
 * wins. Pure function of the report; no time, no I/O.
 */
function pickDefaultTier(report: DiscoveryReport): DefaultPick {
  // Rule 1 — no Ward path → observation-only conservative.
  if (!report.wardAware.wardAware) {
    return { tier: "conservative", rule: "no-ward-path" };
  }

  // Rule 2 — token fingerprint trumps everything else; wrapping a token as
  // an agent is almost certainly a misconfiguration.
  if (report.kind === "erc20" || report.kind === "erc721") {
    return { tier: "conservative", rule: "token-contract" };
  }

  // Rule 3 — fresh EOA, never originated anything.
  if (report.kind === "eoa" && report.nonce === 0) {
    return { tier: "conservative", rule: "eoa-zero-nonce" };
  }

  // Rule 4 — active EOA with history.
  if (report.kind === "eoa" && report.nonce > 0) {
    return { tier: "balanced", rule: "eoa-active" };
  }

  // Rules 5 & 6 — unknown contract that's already Ward-aware. Tighten the
  // check on `kind` here (matches the spec's "unknown-contract && ...")
  // so a future `kind: 'contract'` bucket doesn't silently fall through to
  // balanced without re-running the rule table.
  if (
    report.kind === "unknown-contract" &&
    report.wardAware.wardAware === true
  ) {
    const ev = report.wardAware.evidence;
    if (ev.kind === "registry") {
      return { tier: "balanced", rule: "registered-in-registry" };
    }
    if (ev.kind === "queue") {
      return { tier: "balanced", rule: "queue-evidence" };
    }
  }

  // Rule 7 — safe default.
  return { tier: "conservative", rule: "fallback-unknown" };
}

/**
 * Apply a tier's per-selector knobs to an existing `TargetRule[]` that
 * already has real (target, selector) pairs. Used when:
 *   (a) discovery resolved `evidence.resolvedTargets` from the registry,
 *       so the recommender can attach a publish-ready `policy` field.
 *   (b) the wizard's Step 3 picker hands us a fresh targets list and asks
 *       the recommender to assemble the PolicyInput (public API
 *       `buildPolicyInputFromRecommendation` below).
 *
 * Validation:
 *   - throws if any input selector is `0x00000000` (would revert on-chain
 *     in PolicyNormalizer.copy).
 *   - throws if targets[] is empty (would be a kill-policy — not what the
 *     caller asked for).
 *   - throws if any target is the zero address.
 *
 * These throws are programmer errors, not runtime fallbacks; the wizard's
 * picker enforces the same invariants before calling.
 */
function stampTierOntoTargets(
  targets: readonly TargetRule[],
  params: TierParameters,
): TargetRule[] {
  if (targets.length === 0) {
    throw new Error(
      "buildPolicyInputFromRecommendation: targets[] must be non-empty (empty targets is a kill-policy)",
    );
  }
  return targets.map((tr) => {
    if (
      !tr.target ||
      tr.target === "0x0000000000000000000000000000000000000000"
    ) {
      throw new Error(
        "buildPolicyInputFromRecommendation: ZeroTarget. Every TargetRule must have a non-zero address",
      );
    }
    if (tr.selectors.length === 0) {
      throw new Error(
        `buildPolicyInputFromRecommendation: target ${tr.target} has no selectors. Empty selectors[] would silently accept nothing`,
      );
    }
    const stamped: SelectorRule[] = tr.selectors.map((s) => {
      // 0x00000000 reverts on-chain (ZeroSelector). The recommender refuses
      // to emit it for the same reason the SDK refuses (sdk/src/policy-compiler.ts).
      if (!s.selector || s.selector === "0x00000000") {
        throw new Error(
          `buildPolicyInputFromRecommendation: ZeroSelector for target ${tr.target}. Selector 0x00000000 would revert in PolicyNormalizer.copy`,
        );
      }
      return {
        selector: s.selector,
        valueCapPerCall: params.valueCapPerCall,
        tier: params.tier,
        // delaySeconds is only meaningful for TIER_DELAYED; for
        // IMMEDIATE / VETO_REQUIRED the contract reverts InvalidDelay if
        // we set it non-zero (PolicyNormalizer.sol:60).
        delaySeconds: params.tier === TIER_DELAYED ? params.delaySeconds : 0,
      };
    });
    return { target: tr.target, selectors: stamped };
  });
}

/**
 * Public helper for the wizard's Step 4. Given a recommendation and a
 * fresh `TargetRule[]` from the Step 3 picker, returns the PolicyInput
 * the wizard hands to `simulateAndWritePublish`.
 *
 * Kept here (not in writes.ts) so the validation rules live next to the
 * tier-parameter table — change them together or not at all.
 */
export function buildPolicyInputFromRecommendation(
  rec: TierRecommendation,
  targets: readonly TargetRule[],
): PolicyInput {
  const stamped = stampTierOntoTargets(targets, rec.parameters);
  return {
    targets: stamped,
    dailySpendWeiCap: rec.parameters.dailySpendWeiCap,
    maxSlippageBps: rec.parameters.maxSlippageBps,
    expiresAt: rec.parameters.expiresAt,
    paused: rec.parameters.paused,
  };
}

/**
 * If discovery resolved a real `targets[]` from the registry-bound policy,
 * return a publish-ready PolicyInput stamped with this tier's parameters.
 * Otherwise return undefined — the wizard's Step 3 picker has to gather
 * real targets first.
 *
 * Pulled into its own function so the three tier-emit lines stay
 * symmetrical and the "is a stub policy ever ok?" answer (no) lives in
 * exactly one place.
 */
function maybeBuildPolicyFromResolvedTargets(
  report: DiscoveryReport,
  params: TierParameters,
): PolicyInput | undefined {
  if (!report.wardAware.wardAware) return undefined;
  if (report.wardAware.evidence.kind !== "registry") return undefined;
  const resolved = report.wardAware.evidence.resolvedTargets;
  if (!resolved || resolved.length === 0) return undefined;
  // stampTierOntoTargets throws on zero-selector / zero-target / empty;
  // wrap in a try/catch so a bad resolved set degrades to "operator must
  // supply targets" rather than crashing the wizard.
  try {
    const stamped = stampTierOntoTargets(resolved, params);
    return {
      targets: stamped,
      dailySpendWeiCap: params.dailySpendWeiCap,
      maxSlippageBps: params.maxSlippageBps,
      expiresAt: params.expiresAt,
      paused: params.paused,
    };
  } catch {
    return undefined;
  }
}

export function recommendPolicies(
  report: DiscoveryReport,
  opts: RecommendOpts,
): RecommendationResult {
  // Programmer-error checks — these are NOT runtime fallbacks.
  if (!opts || typeof opts.nowSec !== "bigint") {
    throw new Error(
      "recommendPolicies: opts.nowSec is required (BigInt unix seconds). Capture it once at the call site (e.g. WizardState.startedAtMs). The recommender never reads the clock itself.",
    );
  }
  if (opts.nowSec <= 0n) {
    throw new Error(
      "recommendPolicies: opts.nowSec must be a positive bigint",
    );
  }

  const { nowSec } = opts;
  const pick = pickDefaultTier(report);
  const branchBulletList = branchBullets(pick.rule, report);

  // Use the same nowSec capture for all tiers so absolute expiresAt values line up.
  const tiers: TierName[] = ["conservative", "balanced", "aggressive"];
  const built: Record<TierName, TierRecommendation> = {} as Record<
    TierName,
    TierRecommendation
  >;

  for (const name of tiers) {
    const parameters = tierParametersFor(name, nowSec);
    // Each tier shows: tier-semantics + branch-specific reasoning. The
    // branch reasoning is identical across the three cards because it
    // explains WHY the wizard suggested a particular DEFAULT — the
    // tier-semantics line is what changes per card.
    const reasoningBullets = [
      tierSemanticsBullet(name),
      ...branchBulletList,
    ];
    const reasoning = reasoningBullets.join(" ");
    const policy = maybeBuildPolicyFromResolvedTargets(report, parameters);
    built[name] = {
      name,
      parameters,
      reasoningBullets,
      reasoning,
      policy,
    };
  }

  const defaultTierReason = branchBulletList.join(" ");
  // observationOnly intentionally derives from wardAware ONLY, not from
  // whether `policy` was populatable. A registered-but-stale agent without
  // resolvedTargets is still Ward-aware (the registry row proves it).
  const observationOnly = !report.wardAware.wardAware;

  return {
    conservative: built.conservative,
    balanced: built.balanced,
    aggressive: built.aggressive,
    defaultTier: pick.tier,
    observationOnly,
    defaultTierReason,
  };
}

// Re-export the address type for callers that import only from here.
export type { Address, Hex };
