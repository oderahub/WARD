import { useId } from "react";
import { X as XIcon } from "@phosphor-icons/react";
import { TIER_VALUES, type SelectorDraft, type Tier } from "../../lib/policy-draft";
import { humanizeTier } from "../../lib/selector-display";
import { Input } from "../primitives";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import type { FieldErrors } from "./PolicyForm";

/**
 * Plain-language summaries for each policy tier. Rendered as an INLINE
 * subtitle under the tier <select> (always visible, no hover required) so the
 * decision is keyboard- and screen-reader accessible. Wording mirrors the
 * dispatch authorization enforced in WardQueue.dispatch — DELAYED is
 * asker-dispatchable after the timer, VETO_REQUIRED requires the policy owner
 * to actively dispatch (passive timeout is NOT enough; an unattended queue
 * never auto-executes).
 */
export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  IMMEDIATE: "Passes through immediately. No queue, no delay.",
  DELAYED:
    "Queued for delaySeconds. Asker dispatches once the timer elapses; policy owner can veto earlier; expires 7 days after the timer if no dispatch.",
  VETO_REQUIRED:
    "Queued for policy-owner approval. Only the policy owner can dispatch (no auto-execute); expires 7 days after the earliest-commit timestamp if no dispatch.",
};

/**
 * Raw 4-byte selector form (`0x` + 8 hex chars). The display schema accepts
 * both this form and a human-readable function signature (e.g. `approve(address,uint256)`),
 * but the hex form bypasses the ABI sanity-check entirely — there is no way
 * for the form layer to verify the operator typed the bytes that actually
 * correspond to the function they intended. We render an INFO-level warning
 * when this pattern matches so the choice is explicit, not silently accepted.
 */
const RAW_BYTES4_RE = /^0x[0-9a-fA-F]{8}$/;

interface Props {
  selector: SelectorDraft;
  onChange: (next: SelectorDraft) => void;
  onRemove: () => void;
  canRemove: boolean;
  errors?: FieldErrors;
  /** INFO-level notes keyed identically to `errors`. */
  warnings?: FieldErrors;
  /** Dotted prefix, e.g. `targets.0.selectors.2`. */
  pathPrefix?: string;
  shouldShowError: (path: string) => boolean;
  touch: (path: string) => void;
}

export function SelectorRow({
  selector,
  onChange,
  onRemove,
  canRemove,
  errors,
  warnings,
  pathPrefix,
  shouldShowError,
  touch,
}: Props) {
  const sigPath = pathPrefix ? `${pathPrefix}.selector` : undefined;
  const valPath = pathPrefix ? `${pathPrefix}.valueCapPerCall` : undefined;
  const delPath = pathPrefix ? `${pathPrefix}.delaySeconds` : undefined;

  const errSig =
    errors && sigPath && shouldShowError(sigPath) ? errors.get(sigPath) : undefined;
  const errVal =
    errors && valPath && shouldShowError(valPath) ? errors.get(valPath) : undefined;
  const errDel =
    errors && delPath && shouldShowError(delPath) ? errors.get(delPath) : undefined;
  // Warnings are not gated on `touched` — they reflect a SUCCESSFUL compile
  // outcome (per-call cap exceeds the daily cap), not a typing-in-progress
  // problem, so suppressing them until blur would just hide useful info.
  const warnVal =
    warnings && valPath ? warnings.get(valPath) : undefined;

  const sigErrId = useId();
  const valErrId = useId();
  const delErrId = useId();
  const tierDescId = useId();

  const anyError = Boolean(errSig || errVal || errDel);

  // Raw-bytes4 advanced-flag: we only warn once the field has
  // been touched OR there's no error on it, so the warning doesn't pile on top
  // of a legitimate schema error mid-typing. The selector schema already
  // accepts both forms; this is purely an INFO cue that the ABI sanity-check
  // doesn't apply to hex selectors.
  const isRawBytes4 = !errSig && RAW_BYTES4_RE.test(selector.selector.trim());

  return (
    <div
      className={`flex flex-wrap items-start gap-2 py-1.5 text-sm ${
        anyError ? "bg-danger/10" : ""
      }`}
    >
      <div className="flex min-w-0 flex-[2_1_14rem] flex-col gap-1">
        <Input
          aria-label="function signature"
          aria-invalid={errSig ? true : undefined}
          aria-describedby={errSig ? sigErrId : undefined}
          className="w-full min-w-0 font-mono"
          placeholder="bump(uint256)"
          value={selector.selector}
          onChange={(e) => onChange({ ...selector, selector: e.target.value })}
          onBlur={() => sigPath && touch(sigPath)}
        />
        {errSig && (
          <p id={sigErrId} role="alert" className="text-[11px] text-danger">
            {errSig}
          </p>
        )}
        {isRawBytes4 && (
          <p className="text-[11px] text-warn">
            Using raw bytes4. No ABI parse — verify this is the correct selector for the function you intend.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <select
            aria-label="tier"
            aria-describedby={tierDescId}
            className="h-8 rounded-md border border-ward-border bg-surface px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            value={selector.tier}
            onChange={(e) => {
              const nextTier = e.target.value as Tier;
              // Reset delaySeconds when leaving DELAYED — schema rejects non-zero
              // delay on IMMEDIATE/VETO_REQUIRED and the input is disabled in
              // those tiers, so the user could otherwise get stuck in an invalid
              // state they can't edit out of.
              onChange({
                ...selector,
                tier: nextTier,
                delaySeconds: nextTier === "DELAYED" ? selector.delaySeconds : 0,
              });
            }}
          >
            {/* Keep the enum string as the OPTION VALUE — the draft, the
             * schema, and the SDK compiler all key on the canonical name —
             * but render the human label so operators don't have to decode
             * "VETO_REQUIRED" to know it means "needs owner approval". */}
            {TIER_VALUES.map((t) => (
              <option key={t} value={t}>
                {humanizeTier(t)}
              </option>
            ))}
          </select>
          {/* Tier description as an opt-in tooltip — the previous always-on
           * subtitle stacked under every row was visual noise once the form
           * has more than one selector. The `title` attribute keeps the
           * explanation one hover away without consuming vertical space.
           *
           * A11y: the same text is rendered in an `sr-only` span linked via
           * the select's `aria-describedby`, so screen-reader + keyboard
           * users always get the tier semantics without depending on the
           * hover/title surface. The visible `(?)` is also a focusable
           * <button> so sighted keyboard users can reach the tooltip. */}
          <span id={tierDescId} className="sr-only">
            {TIER_DESCRIPTIONS[selector.tier]}
          </span>
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border border-ward-border bg-transparent text-[10px] text-text-muted hover:border-accent hover:text-accent focus:border-accent focus:text-accent focus:outline-none focus:ring-1 focus:ring-accent"
                  aria-label={`Tier semantics: ${TIER_DESCRIPTIONS[selector.tier]}`}
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px]">
                {TIER_DESCRIPTIONS[selector.tier]}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Input
          aria-label="native value cap per call (STT)"
          aria-invalid={errVal ? true : undefined}
          aria-describedby={errVal ? valErrId : undefined}
          className="w-32 font-mono"
          placeholder="0 or 1 ether"
          value={selector.valueCapPerCall}
          onChange={(e) => onChange({ ...selector, valueCapPerCall: e.target.value })}
          onBlur={() => valPath && touch(valPath)}
          title="Caps native STT msg.value for this call. ERC20 token amounts inside calldata are NOT parsed or capped. To restrict token spend, allowlist the token contract as a target and use tier=VETO_REQUIRED on `transfer(address,uint256)` / `approve(address,uint256)`."
        />
        {errVal && (
          <p id={valErrId} role="alert" className="text-[11px] text-danger">
            {errVal}
          </p>
        )}
        {!errVal && warnVal && (
          <p className="text-[11px] text-warn">{warnVal}</p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Input
          aria-label="delay seconds"
          aria-invalid={errDel ? true : undefined}
          aria-describedby={errDel ? delErrId : undefined}
          type="number"
          min={0}
          className="w-20 disabled:opacity-40"
          value={selector.delaySeconds}
          disabled={selector.tier !== "DELAYED"}
          onChange={(e) => onChange({ ...selector, delaySeconds: Number(e.target.value) || 0 })}
          onBlur={() => delPath && touch(delPath)}
          title={selector.tier === "DELAYED" ? "delay in seconds" : "delaySeconds must be 0 for non-DELAYED tiers"}
        />
        {errDel && (
          <p id={delErrId} role="alert" className="text-[11px] text-danger">
            {errDel}
          </p>
        )}
      </div>

      <button
        type="button"
        aria-label={canRemove ? "Remove function" : "Remove function (at least one required)"}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-ward-border text-text-muted hover:border-danger hover:text-danger disabled:cursor-not-allowed disabled:opacity-30 active:scale-[0.98] transition-transform"
        onClick={onRemove}
        disabled={!canRemove}
        title={canRemove ? "Remove function" : "At least one function required"}
      >
        <XIcon size={14} weight="regular" aria-hidden="true" />
      </button>
    </div>
  );
}
