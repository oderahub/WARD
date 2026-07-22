import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X as XIcon } from "@phosphor-icons/react";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";
import { formatEther, type Address, type Hex } from "viem";
import { compilePolicy, WARD_ORACLE_ABI, type PolicyInput } from "@ward/sdk";

import { useEventStore } from "../../hooks/useEventStore";
import { useFocusTrapAndEsc } from "../../hooks/useFocusTrapAndEsc";
import { useUrlState } from "../../hooks/useUrlState";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import { SOMNIA_CHAIN_ID } from "../../lib/networks";
import {
  computeDestructive,
  policyLifetimeState,
} from "../../lib/policy-edit-warnings";
import {
  errorPathSet,
  humanizeSchemaErrors,
  patchDraftForPartialCompile,
  type HumanizedFieldError,
} from "../../lib/policy-edit-errors";
import { cachePublished, readPublished } from "../../lib/publishedCache";
import {
  PolicyDraftSchemaSemantic,
  renderPolicyMarkdown,
  type PolicyDraft,
  type SelectorDraft,
  type TargetDraft,
  type Tier,
} from "../../lib/policy-draft";
import { selectorToDraftString } from "../../lib/selector-display";
import {
  ConcurrentEditError,
  readChainHealth,
  updatePolicyBody,
  type WriteContractAsync,
} from "../../lib/writes";
import { PolicyForm } from "../publish/PolicyForm";
import { Alert, Button, ExplorerLink } from "../primitives";
import { Spinner } from "../write/Spinner";
import type { CompileResult } from "../../hooks/usePolicyDraft";
import PolicyDiff from "./PolicyDiff";

interface Props {
  policyId: Hex;
  currentInput: PolicyInput;
  oracleAddress: Address;
  onClose: () => void;
  onSuccess: (txHash: Hex) => void;
}

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "mining"; txHash: Hex }
  | { kind: "error"; humanized: { headline: string; detail?: string } };

function tierName(tier: number): Tier {
  if (tier === 1) return "DELAYED";
  if (tier === 2) return "VETO_REQUIRED";
  return "IMMEDIATE";
}

/**
 * Format a wei bigint as an "N ether" string when it divides cleanly (so the
 * round-trip through the YAML/compiler doesn't widen the value), or as a bare
 * wei integer otherwise. Both forms are accepted by the SDK compiler's
 * `parseEtherFlexible`.
 */
function fmtWeiForDraft(wei: bigint): string {
  if (wei === 0n) return "0";
  try {
    const asEther = formatEther(wei);
    // Re-parse to bigint and confirm round-trip; only use the ether shorthand
    // when there's no precision loss.
    if (!asEther.includes(".") || /\.\d{1,18}$/.test(asEther)) {
      return `${asEther} ether`;
    }
  } catch {
    // formatEther shouldn't throw on a valid bigint, but be defensive.
  }
  return wei.toString();
}

function expiresToISO(expiresAt: bigint): string {
  // 0 sentinel means no expiry; pre-fill 1y out so the operator has a sane
  // default to accept-or-adjust (the top-of-modal warning Alert explains why).
  if (expiresAt === 0n) {
    return new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(Number(expiresAt) * 1000).toISOString();
}

/**
 * Seed a PolicyDraft from an existing PolicyInput. The on-chain struct only
 * stores 4-byte selectors — for display we re-hydrate known bytes4 back to
 * their human-readable signatures via `selectorToDraftString`, so the form
 * shows `transfer(address,uint256)` rather than `0xa9059cbb`. Signatures
 * round-trip cleanly through the SDK compiler back to the same bytes4. Unknown
 * selectors stay as their hex form (the semantic schema accepts both, and
 * SelectorRow renders an inline "raw bytes4" warning so the operator can
 * replace it with a signature if they know it).
 *
 * `name`/`label` aren't read by `updatePolicy` (which is keyed by policyId)
 * so they're seeded with sentinel values. Editing them doesn't change the
 * on-chain effect.
 */
function policyInputToDraft(input: PolicyInput): PolicyDraft {
  return {
    name: "Edited policy",
    description: "",
    label: "edit",
    dailySpendWeiCap: fmtWeiForDraft(input.dailySpendWeiCap),
    expiresAtISO: expiresToISO(input.expiresAt),
    paused: input.paused,
    targets: input.targets.map<TargetDraft>((t) => ({
      target: t.target,
      selectors: t.selectors.map<SelectorDraft>((s) => ({
        selector: selectorToDraftString(s.selector),
        tier: tierName(s.tier),
        valueCapPerCall: fmtWeiForDraft(s.valueCapPerCall),
        delaySeconds: s.delaySeconds,
      })),
    })),
  };
}

/**
 * Edit a policy's full body and submit via `updatePolicy(...)`. The form
 * components from PublishPage are reused; this modal owns its own draft state
 * and a custom compile pipeline that skips the schema-zod stage (so hex
 * selectors seeded from the on-chain struct don't trigger a `must be a
 * function signature` error — the SDK accepts both).
 */
export function EditPolicyModal({
  policyId,
  currentInput,
  oracleAddress,
  onClose,
  onSuccess,
}: Props) {
  const { address: account } = useAccount();
  const walletChainId = useChainId();
  const chainId = walletChainId || SOMNIA_CHAIN_ID;
  const { wrong: wrongNetwork, current: currentChainId, expected: expectedChainId } = useWrongNetwork();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { store, bumpSnapshot } = useEventStore();
  // Queue address feeds the compiler's self-target check (the oracle is
  // already passed as a prop) so both reserved addresses are covered on the
  // edit flow as well as the publish flow.
  const { queue: queueAddress } = useUrlState();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrapAndEsc(dialogRef, onClose);

  // See PauseConfirmModal: capture lastUpdatedBlock at modal mount as the
  // optimistic-concurrency token. The writes-layer probe re-confirms against
  // chain right before submit so cross-browser concurrent edits surface as
  // ConcurrentEditError instead of silently overwriting body changes.
  const expectedLastUpdatedBlockRef = useRef<bigint>(
    store?.getPolicy(policyId)?.lastUpdatedBlock ?? 0n,
  );

  // Legacy policies stored expiresAt=0; treat as expired. The modal warns
  // upfront and the form is pre-filled with a 1-year-out expiry.
  const legacyZeroExpiry = currentInput.expiresAt === 0n;

  const [draft, setDraft] = useState<PolicyDraft>(() => policyInputToDraft(currentInput));
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  // Chain-vs-cache reconciliation. `updatePolicy` is a FULL replacement, so a
  // submit built from a stale `currentInput` (cached body) can overwrite a
  // concurrent change made from another browser. We re-read the lightweight
  // health view on mount and surface a hard warning if either single-field
  // axis (paused/expiresAt) has diverged — those are the most likely concurrent
  // edit paths (pause/extend buttons). Body-only divergence isn't detectable
  // from chain today (the full struct isn't a view), so the warning text
  // tells the operator other fields could also have drifted silently.
  const [chainCheck, setChainCheck] = useState<
    | { kind: "checking" }
    | { kind: "match" }
    | { kind: "mismatch"; chain: { paused: boolean; expiresAt: bigint } }
    | { kind: "error" }
  >({ kind: "checking" });
  const [overrideAcked, setOverrideAcked] = useState(false);
  // Operator must explicitly confirm any edit that REMOVES capabilities
  // (targets, selectors) or LOWERS a cap. Recomputed below against the
  // freshly-compiled `editedInput`.
  const [destructiveAck, setDestructiveAck] = useState(false);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const [paused, expiresAt] = (await publicClient.readContract({
          address: oracleAddress,
          abi: WARD_ORACLE_ABI,
          functionName: "policyHealth",
          args: [policyId],
        })) as readonly [boolean, bigint];
        if (cancelled) return;
        if (paused !== currentInput.paused || expiresAt !== currentInput.expiresAt) {
          setChainCheck({ kind: "mismatch", chain: { paused, expiresAt } });
        } else {
          setChainCheck({ kind: "match" });
        }
      } catch {
        if (cancelled) return;
        // If the chain read fails (RPC blip), fail CLOSED to "error" — submit
        // is blocked until the operator explicitly acknowledges the override.
        // Failing open here would let a transient RPC blip silently overwrite
        // the chain with a possibly-stale cached body.
        setChainCheck({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, oracleAddress, policyId, currentInput.paused, currentInput.expiresAt]);

  const touch = useCallback((path: string) => {
    setTouched((s) => (s.has(path) ? s : new Set(s).add(path)));
  }, []);

  const yamlText = useMemo(() => renderPolicyMarkdown(draft), [draft]);

  // Custom compile pipeline: runs the SEMANTIC schema (expiry in the future,
  // label control bytes, reserved targets, EIP-55 checksum, DELAYED-tier
  // delay window) without the display-only rules. The display
  // rules (signature-format selectors, ASCII-slug labels) would reject
  // hex-seeded selectors and historical labels like "trading v1" that the
  // chain happily round-trips, so the publish-only PolicyDraftSchema cannot
  // be used here. Once the semantic schema passes, the SDK compiler runs as
  // the final source of truth (it accepts hex selectors directly via
  // `policy-compiler.ts:isHexSelector`).
  const compileResult: CompileResult = useMemo(() => {
    const parsed = PolicyDraftSchemaSemantic.safeParse(draft);
    if (!parsed.success) {
      return {
        ok: false,
        stage: "schema",
        messages: parsed.error.issues.map(
          (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
        ),
      };
    }
    try {
      const input = compilePolicy(yamlText, {
        oracleAddress,
        queueAddress,
        label: draft.label,
      });
      return { ok: true, input };
    } catch (e) {
      return {
        ok: false,
        stage: "compile",
        messages: [(e as Error).message],
      };
    }
  }, [draft, yamlText, oracleAddress, queueAddress]);

  // The form/draft pipeline doesn't surface `maxSlippageBps`, so the SDK
  // compiler always emits 0 for it. Preserve the on-chain value so an edit
  // that touches other fields doesn't silently wipe a non-zero slippage cap.
  // (If/when the dashboard grows a slippage editor, drop this preservation.)
  const editedInput: PolicyInput | null = useMemo(() => {
    if (!compileResult.ok) return null;
    return {
      ...compileResult.input,
      maxSlippageBps: currentInput.maxSlippageBps,
    };
  }, [compileResult, currentInput]);

  // Humanize the raw `<path>: <message>` strings the compile pipeline emits
  // into something a non-author can scan in two seconds: friendly per-field
  // labels keyed by the same dotted paths the form inputs already use. This
  // powers both (a) the inline error map (so SelectorRow / TargetRow render
  // a red message under the offending input) and (b) the diff-area fallback
  // copy below.
  const humanizedErrors: HumanizedFieldError[] = useMemo(() => {
    if (compileResult.ok) return [];
    return humanizeSchemaErrors(compileResult.messages, draft);
  }, [compileResult, draft]);

  const failingPaths = useMemo(
    () => errorPathSet(humanizedErrors),
    [humanizedErrors],
  );

  // Best-effort PARTIAL compile: build a draft where every invalid field is
  // patched back to the on-chain value, then re-run the compile. If that
  // succeeds, the diff renders against the partial input and the operator
  // still sees what their OTHER valid edits would do (instead of staring at
  // an empty box that says "fix errors above"). The partial input is never
  // submittable — it just unblocks the visualization.
  const partialEditedInput: PolicyInput | null = useMemo(() => {
    if (compileResult.ok) return null;
    if (failingPaths.size === 0) return null;
    const patched = patchDraftForPartialCompile(draft, currentInput, failingPaths, {
      fmtWeiForDraft,
      expiresToISO,
      selectorToDraftString,
      tierName,
    });
    // Re-render the patched draft and run it through the SAME pipeline. If
    // EITHER stage fails on the patched draft, give up on the partial view —
    // we don't want to ship a half-broken preview that misleads the operator.
    const reparsed = PolicyDraftSchemaSemantic.safeParse(patched);
    if (!reparsed.success) return null;
    try {
      const compiled = compilePolicy(renderPolicyMarkdown(patched), {
        oracleAddress,
        queueAddress,
        label: patched.label,
      });
      return { ...compiled, maxSlippageBps: currentInput.maxSlippageBps };
    } catch {
      return null;
    }
  }, [compileResult, failingPaths, draft, currentInput, oracleAddress, queueAddress]);

  // `shouldShowError` is intentionally MORE aggressive in the edit modal
  // than in the publish form: the publish form gates errors on blur / submit
  // so a user mid-typing isn't yelled at, but the edit modal pre-seeds every
  // field from the on-chain value, so any error that exists came from the
  // operator's edit — they need to see it now, not after another blur. The
  // touch + hasAttemptedSubmit gates still apply for non-erroring paths
  // (preserves "don't yell at me about untouched fields" intent) but if a
  // path IS in the failing-paths set, we always show.
  const shouldShowError = useCallback(
    (path: string) =>
      hasAttemptedSubmit || touched.has(path) || failingPaths.has(path),
    [hasAttemptedSubmit, touched, failingPaths],
  );

  // Deep-equality check between PolicyInputs (bigints/numbers/booleans only).
  // Used to disable submit when the edited body is identical to the current
  // body — saves the user an avoidable on-chain tx.
  const hasChanges = useMemo(() => {
    if (!editedInput) return false;
    return !policyInputsEqual(currentInput, editedInput);
  }, [editedInput, currentInput]);

  // Surface a top-of-modal warning when the policy being edited is paused
  // or expired. The legacy-0 case has its own dedicated Alert, so we suppress
  // this generic one to avoid double-warning. `nowSec` is captured once per
  // render; the modal is short-lived enough that we don't tick.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const lifetime = policyLifetimeState(currentInput, nowSec);
  const showPausedExpiredWarning =
    !legacyZeroExpiry && (lifetime.isPaused || lifetime.isExpired);

  // Recompute destructive flag per editedInput. Reset the ack whenever the
  // edit stops being destructive so the checkbox state stays honest if the
  // user adjusts back up before submitting.
  const isDestructive = useMemo(() => {
    if (!editedInput) return false;
    return computeDestructive(currentInput, editedInput);
  }, [currentInput, editedInput]);
  useEffect(() => {
    if (!isDestructive && destructiveAck) setDestructiveAck(false);
  }, [isDestructive, destructiveAck]);

  // Explicit DANGER inline alert when the daily cap is being lowered to
  // exactly zero (0 means "block all native spend", not "unlimited"). This is
  // a stronger version of the generic destructiveAck — surfaced inline so the
  // operator sees it next to the cap field, not just in the footer.
  const dailyCapZeroedOut =
    !!editedInput &&
    currentInput.dailySpendWeiCap > 0n &&
    editedInput.dailySpendWeiCap === 0n;

  const inFlight = state.kind === "submitting" || state.kind === "mining";
  // Block submit while the chain reconciliation is still running (avoids a
  // submit-before-check race) or until the operator explicitly acks the
  // override when a mismatch was detected. A read `error` is treated the same
  // as a mismatch — failing CLOSED on a transient RPC blip is safer than
  // silently overwriting the chain with a possibly-stale cached body. `match`
  // is the only pass-through state.
  const chainBlocks =
    chainCheck.kind === "checking" ||
    ((chainCheck.kind === "mismatch" || chainCheck.kind === "error") && !overrideAcked);
  const canSubmit =
    compileResult.ok &&
    hasChanges &&
    !inFlight &&
    !chainBlocks &&
    (!isDestructive || destructiveAck) &&
    !!publicClient &&
    !!account &&
    !!writeContractAsync &&
    !wrongNetwork;

  const submit = useCallback(async () => {
    setHasAttemptedSubmit(true);
    if (!publicClient || !account || !compileResult.ok || !editedInput) {
      setState({
        kind: "error",
        humanized: { headline: "Wallet is not ready, or the form has compile errors." },
      });
      return;
    }
    // Submit-time re-validation (mirrors PublishButton click-time pattern).
    // `compileResult` / `editedInput` were derived on the last draft mutation.
    // If this modal has stayed open across the expiry boundary
    // — or any other check that depends on `Date.now()` — the memo is stale
    // and could push an already-expired draft straight through to
    // `updatePolicy`, which the contract would accept. Re-run BOTH the
    // semantic schema AND the SDK compile against the current draft/yaml,
    // and use the freshly-compiled input downstream.
    const reparsed = PolicyDraftSchemaSemantic.safeParse(draft);
    if (!reparsed.success) {
      setState({
        kind: "error",
        humanized: {
          headline:
            "Your edit drifted out of validity. Please review (clock advanced past the expiry, etc.).",
          detail: reparsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        },
      });
      return;
    }
    let freshCompiled;
    try {
      freshCompiled = compilePolicy(yamlText, {
        oracleAddress,
        queueAddress,
        label: draft.label,
      });
    } catch (compileErr) {
      setState({
        kind: "error",
        humanized: {
          headline:
            "Your edit drifted out of validity. Please review (clock advanced past the expiry, etc.).",
          detail: (compileErr as Error).message,
        },
      });
      return;
    }
    // Preserve `maxSlippageBps` the same way `editedInput` does
    // (the form pipeline doesn't surface it).
    const nextInput: PolicyInput = {
      ...freshCompiled,
      maxSlippageBps: currentInput.maxSlippageBps,
    };
    setState({ kind: "submitting" });
    try {
      const { txHash } = await updatePolicyBody({
        publicClient,
        // See PauseConfirmModal for the rationale on this cast.
        writeContractAsync: writeContractAsync as WriteContractAsync,
        oracleAddress,
        policyId,
        account,
        nextInput,
        expectedLastUpdatedBlock: expectedLastUpdatedBlockRef.current,
        chainId: expectedChainId,
      });
      setState({ kind: "mining", txHash });
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Refresh publishedCache so the next drawer-open reflects the new body
      // without needing a re-import. We preserve the original yamlText only if
      // the draft didn't change — otherwise we write the freshly-rendered one
      // so a re-edit starts from the current body.
      //
      // `nextInput` IS the new chain state by construction (this is a full
      // replacement we just wrote). But re-read policyHealth post-mine and
      // verify `paused` + `expiresAt` match — a mismatch means someone else's
      // tx mined between our submit and our receipt. In that case, log a
      // warning and reconcile the cache against chain so the next drawer-open
      // doesn't show a stale single-field axis.
      //
      // Known limit — body-divergence detection:
      // We only verify `paused` and `expiresAt` post-mine — body fields
      // (targets/selectors/caps) could have raced with another browser's
      // update in the same window and we'd silently cache the submitted
      // `nextInput` as if it were the canonical chain state. True
      // body-divergence detection requires per-(target, selector)
      // `tierAndDelay` probes across the whole struct, or a single
      // `getPolicyDetails`-style view that returns the full body in one
      // call. Until then, the user is warned upfront (see the warn Alert
      // above) that concurrent body edits from other browsers cannot be
      // detected here.
      const cached = await readPublished(chainId, oracleAddress, policyId);
      if (cached) {
        let cacheInput = nextInput;
        try {
          const chain = await readChainHealth(publicClient, oracleAddress, policyId);
          if (chain.paused !== nextInput.paused || chain.expiresAt !== nextInput.expiresAt) {
            console.warn(
              "[EditPolicyModal] post-mine chain state diverges from submitted body. Another tx likely mined concurrently",
              {
                submitted: { paused: nextInput.paused, expiresAt: nextInput.expiresAt.toString() },
                chain: { paused: chain.paused, expiresAt: chain.expiresAt.toString() },
              },
            );
            cacheInput = { ...nextInput, paused: chain.paused, expiresAt: chain.expiresAt };
          }
        } catch (e) {
          // Chain read failure is non-fatal — fall back to caching the
          // submitted body. Worst case the user sees stale paused/expiresAt
          // in the drawer until the next refresh.
          console.warn("[EditPolicyModal] post-mine policyHealth read failed; caching submitted body", e);
        }
        const policyInputJSON = JSON.stringify(cacheInput, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        );
        await cachePublished(chainId, oracleAddress, {
          ...cached,
          yamlText,
          policyInputJSON,
        });
      }

      bumpSnapshot();
      onSuccess(txHash);
    } catch (err) {
      if (err instanceof ConcurrentEditError) {
        setState({
          kind: "error",
          humanized: {
            headline: "Another browser updated this policy",
            detail: `Chain reports lastUpdatedBlock=${err.actual.toString()} (you opened this modal at block ${err.expected.toString()}). Close and reopen to see the latest state, then re-apply your change.`,
          },
        });
        return;
      }
      setState({ kind: "error", humanized: humanizeWeb3Error(err) });
    }
  }, [
    publicClient,
    account,
    writeContractAsync,
    oracleAddress,
    policyId,
    compileResult,
    editedInput,
    draft,
    yamlText,
    queueAddress,
    currentInput,
    chainId,
    expectedChainId,
    bumpSnapshot,
    onSuccess,
  ]);

  const submitLabel =
    state.kind === "submitting"
      ? "Confirm in wallet…"
      : state.kind === "mining"
        ? "Mining…"
        : "Submit replacement";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Edit policy"
      onClick={(e) => {
        if (e.target === e.currentTarget && !inFlight) onClose();
      }}
    >
      <motion.div
        ref={dialogRef}
        initial={{ scale: 0.97, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg border border-ward-border bg-surface-elev p-5 text-sm text-text shadow-2xl"
      >
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">Edit policy body</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            disabled={inFlight}
            className="rounded-md p-1 text-text-muted hover:bg-surface hover:text-text active:scale-[0.98] transition-transform disabled:opacity-40"
          >
            <XIcon size={14} weight="bold" aria-hidden="true" />
          </button>
        </header>

        {/* Single compact heads-up. The summary itself carries the three
         * must-know facts (full-replacement, comment regeneration,
         * concurrent-edit race) so a user who never expands the <details>
         * still sees them. Longer prose stays inside for context. */}
        <details className="mb-3 rounded-md border border-ward-border bg-surface px-3 py-2 text-xs">
          <summary className="cursor-pointer list-none text-text-muted hover:text-text">
            <span className="text-warn">⚠</span>{" "}
            Replacing the on-chain policy in full — comments outside the policy block are regenerated, and concurrent edits can race.{" "}
            <span className="text-text-subtle">Details</span>
          </summary>
          <div className="mt-2 space-y-1.5 text-text-muted">
            <p>
              Comments outside the{" "}
              <code className="font-mono">```policy```</code> block are
              regenerated — paste them back into Notes if you need them.
            </p>
            <p>
              Concurrent edits from another browser can race; if your submit
              fails, refresh and re-apply.
            </p>
          </div>
        </details>

        <div className="flex-1 space-y-4 overflow-y-auto">
          {wrongNetwork && (
            <Alert variant="warn" title="Wrong network">
              {`Connected to chain ${currentChainId ?? "?"}. Switch to Somnia Shannon (${expectedChainId}) before submitting.`}
            </Alert>
          )}

          {legacyZeroExpiry && (
            <Alert variant="warn" title="Set an expiry before saving">
                <p>
                This policy has no expiry (treated as already-expired).
                "Valid until" has been pre-filled with one year from now.
                adjust if you want a different date.
              </p>
            </Alert>
          )}

          {showPausedExpiredWarning && (
            <Alert variant="warn" title={`Policy is ${lifetime.isPaused && lifetime.isExpired ? "paused and expired" : lifetime.isPaused ? "paused" : "expired"}`}>
              <p>
                Saving updates the body but doesn't reactivate it.
                {lifetime.isPaused ? " Unpause" : ""}
                {lifetime.isPaused && lifetime.isExpired ? " and" : ""}
                {lifetime.isExpired ? " extend the expiry" : ""}{" "}
                separately to take it live.
              </p>
            </Alert>
          )}

          {chainCheck.kind === "mismatch" && (
            <Alert variant="danger" title="On-chain policy has changed">
              <div className="space-y-2">
                <p>
                  The chain shows{" "}
                  <code className="font-mono">paused={String(chainCheck.chain.paused)}</code>,{" "}
                  <code className="font-mono">expiresAt={chainCheck.chain.expiresAt.toString()}</code>{" "}
                  . Different from this dashboard's cache. Submitting will overwrite
                  any other changes (targets, caps) made from another browser.
                </p>
                <label className="mt-1 flex items-center gap-2 text-text">
                  <input
                    type="checkbox"
                    checked={overrideAcked}
                    onChange={(e) => setOverrideAcked(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  <span>I understand. Overwrite anyway.</span>
                </label>
              </div>
            </Alert>
          )}

          {chainCheck.kind === "error" && (
            <Alert variant="danger" title="Couldn't verify on-chain state">
              <div className="space-y-2">
                <p>
                  If the cache is stale, your edit may overwrite recent changes.
                  Confirm to proceed anyway.
                </p>
                <label className="mt-1 flex items-center gap-2 text-text">
                  <input
                    type="checkbox"
                    checked={overrideAcked}
                    onChange={(e) => setOverrideAcked(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  <span>I understand. Overwrite anyway.</span>
                </label>
              </div>
            </Alert>
          )}

          {dailyCapZeroedOut && (
            <Alert variant="danger" title="Daily cap set to 0. Blocks ALL native spend">
              <p>
                Lowering daily cap to <code className="font-mono">0</code>{" "}
                blocks ALL native spend (not unlimited). Existing scheduled
                payable calls are invalidated by the policy update. If you
                meant "no per-day limit", leave the cap at its current value
                or raise it instead.
              </p>
            </Alert>
          )}

          <Alert variant="info" title="Policy updates invalidate queued calls">
            <p>
              Saving a policy body update invalidates existing pending queue
              entries for this policy. Re-enqueue any delayed or veto-required
              calls that should run under the new rules.
            </p>
          </Alert>

          <PolicyForm
            draft={draft}
            setDraft={setDraft}
            compileResult={compileResult}
            shouldShowError={shouldShowError}
            touch={touch}
          />

          <section className="space-y-2 border-t border-ward-border pt-3">
            <div className="text-[11px] uppercase tracking-wider text-text-subtle">
              diff vs current on-chain body
            </div>
            {compileResult.ok && editedInput ? (
              <PolicyDiff before={currentInput} after={editedInput} />
            ) : (
              <PolicyDiff
                before={currentInput}
                after={partialEditedInput ?? currentInput}
                errors={humanizedErrors}
                partial={partialEditedInput !== null}
              />
            )}
            {isDestructive && (
              <label className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-[11px] text-text">
                <input
                  type="checkbox"
                  checked={destructiveAck}
                  onChange={(e) => setDestructiveAck(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5"
                />
                <span>
                  I understand — this removes or restricts permissions. Calls
                  that worked before may now fail.
                </span>
              </label>
            )}
          </section>
        </div>

        {state.kind === "mining" && (
          <div className="mt-3 rounded-md border border-ward-border bg-surface p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Mining updatePolicy…</span>
              <ExplorerLink txHash={state.txHash} />
            </div>
            <div className="mt-1 break-all font-mono text-text">{state.txHash}</div>
          </div>
        )}

        {state.kind === "error" && (
          <Alert variant="danger" title={state.humanized.headline} className="mt-3">
            {state.humanized.detail && (
              <details>
                <summary className="cursor-pointer text-text-muted hover:text-text">
                  Show raw error
                </summary>
                <div className="mt-1 break-all font-mono text-[11px] text-text-muted">
                  {state.humanized.detail}
                </div>
              </details>
            )}
          </Alert>
        )}

        <div className="mt-4 flex justify-end gap-2 border-t border-ward-border pt-3">
          <Button variant="ghost" size="md" onClick={onClose} disabled={inFlight}>
            Cancel
          </Button>
          <Button
            variant="accent"
            size="md"
            onClick={submit}
            disabled={!canSubmit}
            title={
              !compileResult.ok
                ? "Resolve form errors before submitting"
                : !hasChanges
                  ? "No changes vs current on-chain body"
                  : chainCheck.kind === "checking"
                    ? "Checking on-chain state…"
                    : chainCheck.kind === "mismatch" && !overrideAcked
                      ? "Cached body is out of date. Acknowledge the warning to proceed"
                      : chainCheck.kind === "error" && !overrideAcked
                        ? "Chain state could not be verified. Acknowledge the warning to proceed"
                        : isDestructive && !destructiveAck
                          ? "Destructive change. Acknowledge the warning to proceed"
                          : undefined
            }
          >
            {inFlight ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner /> {submitLabel}
              </span>
            ) : (
              submitLabel
            )}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

function policyInputsEqual(a: PolicyInput, b: PolicyInput): boolean {
  if (a.dailySpendWeiCap !== b.dailySpendWeiCap) return false;
  if (a.maxSlippageBps !== b.maxSlippageBps) return false;
  if (a.expiresAt !== b.expiresAt) return false;
  if (a.paused !== b.paused) return false;
  if (a.targets.length !== b.targets.length) return false;
  // Order-insensitive comparison: callers may edit the target/selector order
  // in the form without changing on-chain meaning. Build maps keyed by lower-
  // cased address / selector for the comparison.
  const aMap = new Map(a.targets.map((t) => [t.target.toLowerCase(), t]));
  for (const bt of b.targets) {
    const at = aMap.get(bt.target.toLowerCase());
    if (!at) return false;
    if (at.selectors.length !== bt.selectors.length) return false;
    const aSel = new Map(at.selectors.map((s) => [s.selector.toLowerCase(), s]));
    for (const bs of bt.selectors) {
      const as = aSel.get(bs.selector.toLowerCase());
      if (!as) return false;
      if (
        as.tier !== bs.tier ||
        as.valueCapPerCall !== bs.valueCapPerCall ||
        as.delaySeconds !== bs.delaySeconds
      ) {
        return false;
      }
    }
  }
  return true;
}
