/**
 * Per-field error surfacing helpers for the policy-edit modal.
 *
 * Background: when the edit form's schema parse fails, the diff view used to
 * collapse the entire preview behind a generic "Resolve form errors above to
 * see diff" message. That copy was useless to the operator — it didn't say
 * WHICH field was invalid or WHY, just that the form was unhappy somewhere
 * upstream. These helpers convert raw zod issue paths into human-readable
 * field labels and split a draft into "the parts we CAN diff" vs "the parts
 * we have to keep at the on-chain value."
 *
 * Both helpers are pure — no React, no DOM — so they're trivially testable
 * and the modal can run them inside a `useMemo` without leaks.
 */
import type { PolicyInput } from "@ward/sdk";
import { formatSelector, FIELD_HUMAN_LABELS } from "./selector-display";
import type { PolicyDraft } from "./policy-draft";

/**
 * One schema error, ready for inline rendering. Carries both the dotted path
 * (so it lines up with the form's per-field error map) and a human-readable
 * label for the diff fallback.
 */
export interface HumanizedFieldError {
  /** Dotted path as emitted by the zod issue (e.g. `targets.0.selectors.1.valueCapPerCall`). */
  path: string;
  /** Raw error message from the schema or compile step. */
  message: string;
  /** Friendly label, e.g. `Contract 1 → bump(uint256) → per-call cap`. */
  label: string;
}

/**
 * Top-level field label map. Mirrors `FIELD_HUMAN_LABELS` for the on-chain
 * struct names plus draft-only paths (label, name, description, expiresAtISO)
 * that aren't part of the PolicyInput struct.
 */
const TOP_LEVEL_LABELS: Record<string, string> = {
  name: "Policy name",
  label: "Short id",
  description: "Notes",
  dailySpendWeiCap: FIELD_HUMAN_LABELS.dailySpendWeiCap ?? "Daily native (AVAX) spend cap",
  expiresAtISO: FIELD_HUMAN_LABELS.expiresAt ?? "Valid until",
  paused: FIELD_HUMAN_LABELS.paused ?? "Paused",
  targets: "Targets",
};

/**
 * Per-selector field label map. The form column headers read "function",
 * "approval mode", "max per call", "wait (sec)" — match that wording rather
 * than the on-chain struct field names so the operator's eye jumps straight
 * from the diff message to the offending column.
 */
const SELECTOR_FIELD_LABELS: Record<string, string> = {
  selector: "function signature",
  valueCapPerCall: "per-call native cap",
  tier: "approval mode",
  delaySeconds: "wait (sec)",
};

/**
 * Turn a dotted error path into a friendly label using the draft for context.
 * Uses the actual selector text the operator typed (or a known signature
 * lookup if hex) so the message reads "Contract 1 → bump(uint256) → per-call
 * cap" rather than "targets.0.selectors.1.valueCapPerCall". Falls back to the
 * raw path segment whenever the draft doesn't have a matching slot — that
 * way an out-of-bounds path emitted by a future schema rule still produces a
 * readable line instead of throwing.
 */
export function humanizeErrorPath(path: string, draft: PolicyDraft): string {
  if (!path || path === "(root)") return "Policy";

  const segs = path.split(".");

  // Top-level scalar: name / label / dailySpendWeiCap / etc.
  if (segs.length === 1) {
    return TOP_LEVEL_LABELS[segs[0]] ?? segs[0];
  }

  // Targets root (e.g. `targets` with no index — fired when the array itself
  // fails its `.min(1)` check). Surfaces as "Targets" so it reads naturally
  // beside the empty-state legend.
  if (segs[0] !== "targets") {
    return path;
  }

  const targetIdx = Number(segs[1]);
  if (!Number.isFinite(targetIdx)) return path;
  const target = draft.targets[targetIdx];
  // 1-based for humans — the form labels them "contract" rows without
  // explicit numbering, but a count is more useful in an error than `[0]`.
  const targetLabel = `Contract ${targetIdx + 1}`;

  // `targets.<i>` or `targets.<i>.target` — refers to the contract itself.
  if (segs.length === 2 || (segs.length === 3 && segs[2] === "target")) {
    return targetLabel;
  }

  // `targets.<i>.selectors` (with no index) — the selectors array failed.
  if (segs.length === 3 && segs[2] === "selectors") {
    return `${targetLabel} → functions`;
  }

  if (segs[2] !== "selectors" || segs.length < 4) return path;
  const selectorIdx = Number(segs[3]);
  if (!Number.isFinite(selectorIdx)) return path;

  // Prefer the operator's typed signature; fall back to a hex display via
  // `formatSelector` if the draft slot holds a 4-byte hex string; final
  // fallback is the 1-based index so we never render an empty arrow.
  const selectorDraft = target?.selectors[selectorIdx];
  const selectorTyped = selectorDraft?.selector?.trim() ?? "";
  let selectorLabel: string;
  if (selectorTyped.length === 0) {
    selectorLabel = `function ${selectorIdx + 1}`;
  } else if (/^0x[0-9a-fA-F]{8}$/.test(selectorTyped)) {
    selectorLabel = formatSelector(selectorTyped as `0x${string}`);
  } else {
    selectorLabel = selectorTyped;
  }

  if (segs.length === 4) {
    return `${targetLabel} → ${selectorLabel}`;
  }

  const fieldLabel = SELECTOR_FIELD_LABELS[segs[4]] ?? segs[4];
  return `${targetLabel} → ${selectorLabel} → ${fieldLabel}`;
}

/**
 * Parse the `"<path>: <message>"` strings the EditPolicyModal compile pipeline
 * emits into structured errors with human-readable labels. First occurrence
 * per path wins (mirrors `parseSchemaErrors` in PolicyForm) so a field never
 * gets two competing labels under it.
 */
export function humanizeSchemaErrors(
  rawMessages: ReadonlyArray<string>,
  draft: PolicyDraft,
): HumanizedFieldError[] {
  const seen = new Set<string>();
  const out: HumanizedFieldError[] = [];
  for (const raw of rawMessages) {
    const colonIdx = raw.indexOf(":");
    if (colonIdx === -1) continue;
    const path = raw.slice(0, colonIdx).trim();
    const message = raw.slice(colonIdx + 1).trim();
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, message, label: humanizeErrorPath(path, draft) });
  }
  return out;
}

/**
 * Build the set of dotted paths that have at least one schema error. Used by
 * the modal's `shouldShowError` override so an inline error always renders
 * next to the offending field — without that override, the user wouldn't see
 * the per-field message until they explicitly blurred the input, which
 * defeats the point of inline error surfacing.
 */
export function errorPathSet(errors: ReadonlyArray<HumanizedFieldError>): Set<string> {
  const set = new Set<string>();
  for (const e of errors) set.add(e.path);
  return set;
}

/**
 * Patch a draft so each invalid field is swapped back to the equivalent
 * draft-string of the current on-chain value. The output is intended for a
 * second `compilePolicy` pass — if THAT compiles, the diff renders as a
 * "partial" preview where invalid fields collapse to "no change" rows and
 * the operator still sees what their other (valid) edits would do.
 *
 * Invariants:
 *   - Only fields covered by `errorPaths` are reverted. Untouched valid
 *     fields keep their draft value verbatim.
 *   - Reverts are by INDEX into the current input. A draft that added a
 *     brand-new selector with an empty cap reverts to the current selector
 *     at the same index, or to a safe default ("0", IMMEDIATE, 0s) when the
 *     index doesn't exist on-chain — the goal is a compilable shape, not
 *     semantic accuracy on the invalid line.
 *   - A draft that added a new TARGET with an invalid address falls back to
 *     the current target at the same index, or omits the target entirely
 *     when the current input doesn't have one at that index.
 */
export function patchDraftForPartialCompile(
  draft: PolicyDraft,
  current: PolicyInput,
  errorPaths: ReadonlySet<string>,
  helpers: {
    fmtWeiForDraft: (wei: bigint) => string;
    expiresToISO: (expiresAt: bigint) => string;
    selectorToDraftString: (selector: `0x${string}`) => string;
    tierName: (tier: number) => "IMMEDIATE" | "DELAYED" | "VETO_REQUIRED";
  },
): PolicyDraft {
  const patched: PolicyDraft = {
    name: errorPaths.has("name") ? "Edited policy" : draft.name,
    description: draft.description,
    label: errorPaths.has("label") ? "edit" : draft.label,
    dailySpendWeiCap: errorPaths.has("dailySpendWeiCap")
      ? helpers.fmtWeiForDraft(current.dailySpendWeiCap)
      : draft.dailySpendWeiCap,
    expiresAtISO: errorPaths.has("expiresAtISO")
      ? helpers.expiresToISO(current.expiresAt)
      : draft.expiresAtISO,
    paused: draft.paused,
    targets: draft.targets.map((t, i) => {
      const currentTarget = current.targets[i];
      const targetHasError =
        errorPaths.has(`targets.${i}.target`) ||
        errorPaths.has(`targets.${i}`);
      const nextTarget = targetHasError
        ? currentTarget?.target ?? "0x0000000000000000000000000000000000000000"
        : t.target;
      const selectors = t.selectors.map((s, j) => {
        const currentSel = currentTarget?.selectors[j];
        const sigErr = errorPaths.has(`targets.${i}.selectors.${j}.selector`);
        const capErr = errorPaths.has(
          `targets.${i}.selectors.${j}.valueCapPerCall`,
        );
        const tierErr = errorPaths.has(`targets.${i}.selectors.${j}.tier`);
        const delayErr = errorPaths.has(
          `targets.${i}.selectors.${j}.delaySeconds`,
        );
        return {
          selector: sigErr
            ? currentSel
              ? helpers.selectorToDraftString(currentSel.selector)
              // No current counterpart — substitute a known-good signature so
              // the schema/compile path still parses. The diff row for this
              // selector will read as "added" against current; the partial
              // banner above the diff tells the operator it's a stand-in.
              : "transfer(address,uint256)"
            : s.selector,
          tier: tierErr
            ? currentSel
              ? helpers.tierName(currentSel.tier)
              : "IMMEDIATE"
            : s.tier,
          valueCapPerCall: capErr
            ? currentSel
              ? helpers.fmtWeiForDraft(currentSel.valueCapPerCall)
              : "0"
            : s.valueCapPerCall,
          delaySeconds: delayErr
            ? currentSel
              ? currentSel.delaySeconds
              : 0
            : s.delaySeconds,
        };
      });
      return {
        target: nextTarget,
        selectors,
      };
    }),
  };
  return patched;
}
