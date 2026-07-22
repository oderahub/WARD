/**
 * Post-publish binding surface for late-bindable WardAgentBase agents.
 * Probes a deployed agent, then signs `setPolicyId(newPolicyId)` when valid.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeEventLog,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { CheckCircle, ShieldCheck } from "@phosphor-icons/react";
import { toast } from "sonner";

import { WARD_AGENT_BASE_ABI } from "../../lib/agent-base-abi";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import { ACTIVE_CHAIN_ID } from "../../lib/networks";
import { fujiSafeGas } from "../../lib/fujiGas";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { probeAgent, type ProbeState } from "../../lib/agent-probe";

import { Alert, AddressChip, Input } from "../primitives";
import { TxStatusPanel, type TxState } from "../write/TxStatusPanel";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface BindStepProps {
  /** Freshly-published (or URL-restored) policyId. The agent's POLICY_ID slot
   *  will be flipped to THIS value. */
  publishedPolicyId: Hex;
  /** Short label for the policy — surfaced inside the Confirm dialog so the
   *  dev sees the human name alongside the bytes32 they're binding to. */
  publishedLabel: string;
  /**
   * Optional callbacks — used by the PostPublishChecklist orchestrator to
   * advance to Step 2 (Register) when Step 1 resolves. All default to no-op
   * so embedding BindStep without an orchestrator remains valid.
   *
   * onAgentResolved fires after the probe completes (ward-agent or
   * no-set-policy-id) so Step 2 can prefill its `agent` prop the moment we
   * know the address — without waiting for the bind tx. onAgentCleared is
   * the inverse (input wiped / invalidated).
   *
   * onBound fires when the setPolicyId tx is mined with status: "success".
   * onAlreadyBound fires when the probe finds POLICY_ID() already matches
   * publishedPolicyId — no tx submitted, but Step 2 should still reveal.
   * onSkip fires when the user dismisses Step 1 without binding; the
   * orchestrator gates on having a resolved agent before honoring it.
   */
  onAgentResolved?: (agent: Address) => void;
  onAgentCleared?: () => void;
  onBound?: (agent: Address, txHash: Hex) => void;
  onAlreadyBound?: (agent: Address) => void;
  onSkip?: () => void;
  /**
   * Pre-filled agent address from the agent-first Publish entry point. When
   * set, BindStep seeds its address input from this value (and re-seeds when
   * the prop changes — but only if the operator hasn't manually overridden
   * the field). Undefined keeps the original "operator pastes here" UX.
   */
  prefilledAgentAddress?: Address;
}

// `ProbeState` + `probeAgent` were extracted to lib/agent-probe.ts so the
// agent-first Publish entry point and this Bind step share one source of
// truth. POLICY_ID_VIEW_ABI remains here for the post-mine readback (we
// re-read POLICY_ID after the tx settles to verify the bind actually
// succeeded on-chain).
const POLICY_ID_VIEW_ABI = [
  {
    type: "function",
    name: "POLICY_ID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

type BindResult =
  | { kind: "already-bound" } // idempotency shortcut — no tx submitted
  | { kind: "tx"; tx: TxState }; // the on-chain path

/**
 * Should the "Skip — register instead" affordance render given the current
 * probe + idempotency state?
 *
 * The original gate ONLY allowed `probe.kind === "ward-agent"` which left a
 * dead-end for `no-set-policy-id`: BindStep already calls onAgentResolved for
 * that branch (the orchestrator can prefill Step 2), but the operator had no
 * way to advance Step 1. Same dead-end for an `eoa` / `probe-error` / owner
 * mismatch where the bind itself can't proceed — Skip is the only forward.
 *
 * Returns true for any terminal probe state where binding can't happen here
 * but the orchestrator can still benefit from Step 2.
 */
export function canShowSkip(
  probe: ProbeState,
  alreadyBoundToThisPolicy: boolean,
  ownerMismatch: boolean,
): boolean {
  if (probe.kind === "ward-agent") {
    // Original case — operator can always choose to skip even when bind would
    // be valid; or owner mismatch makes binding impossible from this wallet.
    return !alreadyBoundToThisPolicy || ownerMismatch;
  }
  // Terminal probe branches where bind can't proceed but agent address is
  // known: no-set-policy-id (has code, not a WardAgentBase) and probe-error
  // (RPC failure but the address itself validated). For "eoa" the agent
  // address is technically known but Step 2 of registering an EOA is
  // nonsensical — keep Skip hidden so the user wipes the input instead.
  return probe.kind === "no-set-policy-id" || probe.kind === "probe-error";
}

/**
 * Classify the on-chain confirmation strength after a successful receipt.
 * The bind tx mined OK; we now want to know whether POLICY_ID() actually
 * returns the expected value (the strongest signal) or if we can only fall
 * back to the PolicyBound event (or, worst-case, nothing).
 *
 * The three branches mirror the new toast copy in BindStep:
 *   - "verified"  → readback succeeded AND matches expected
 *   - "mismatch"  → readback succeeded but returned a different policyId
 *   - "fallback"  → readback unavailable (read reverted / undefined); event
 *                   decision is the only signal we have
 */
export type BindVerification =
  | { kind: "verified"; readback: Hex }
  | { kind: "mismatch"; readback: Hex; expected: Hex; sawPolicyBoundEvent: boolean }
  | { kind: "fallback"; sawPolicyBoundEvent: boolean };

export function classifyBindVerification(opts: {
  readback: Hex | null;
  expected: Hex;
  sawPolicyBoundEvent: boolean;
}): BindVerification {
  const { readback, expected, sawPolicyBoundEvent } = opts;
  if (readback === null) {
    return { kind: "fallback", sawPolicyBoundEvent };
  }
  if (readback.toLowerCase() === expected.toLowerCase()) {
    return { kind: "verified", readback };
  }
  return { kind: "mismatch", readback, expected, sawPolicyBoundEvent };
}

function shortHex(value: Hex): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function validateAddressInput(raw: string): { ok: true; address: Address } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: "" }; // silent — pre-input
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { ok: false, error: "Enter a 0x-prefixed 40-hex address." };
  }
  try {
    return { ok: true, address: getAddress(trimmed) };
  } catch {
    return {
      ok: false,
      error:
        "Address checksum invalid. Paste the exact checksummed form, or paste it in all-lowercase.",
    };
  }
}

export function BindStep({
  publishedPolicyId,
  publishedLabel,
  onAgentResolved,
  onAgentCleared,
  onBound,
  onAlreadyBound,
  onSkip,
  prefilledAgentAddress,
}: BindStepProps) {
  const publicClient = usePublicClient();
  const { address: connectedAddress, isConnected } = useAccount();
  const {
    wrong: rawWrong,
    current: currentChainId,
    expected: expectedChainId,
  } = useWrongNetwork();
  const wrongNetwork = isConnected && rawWrong;
  const { writeContractAsync } = useWriteContract();

  // Lazy initializer pulls the prefilled address through on first render so
  // the probe effect fires once without an extra round-trip.
  const [addressInput, setAddressInput] = useState<string>(
    () => prefilledAgentAddress ?? "",
  );
  const [validation, setValidation] = useState<
    { ok: true; address: Address } | { ok: false; error: string } | null
  >(null);
  // Tracks the LAST prefilled value we honored, so a parent-pushed change
  // can replace its own previous prefill but won't clobber a manual edit.
  const lastPrefilledRef = useRef<string | undefined>(prefilledAgentAddress);

  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const probeTokenRef = useRef(0);

  const [bindResult, setBindResult] = useState<BindResult | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);

  // Drop probe + bindResult whenever the input changes — the probe is keyed on
  // the validated address, and a half-typed address must NOT keep the previous
  // address's probe / bound state on screen.
  const onChangeAddress = useCallback((next: string) => {
    setAddressInput(next);
    setValidation(null);
    setProbe({ kind: "idle" });
    setBindResult(null);
    // Bump the probe token so any in-flight debounce timer drops its result.
    probeTokenRef.current += 1;
  }, []);

  // Validate on blur OR enter, the same pattern as Step1Body in WatchWizardPage.
  const onBlurAddress = useCallback(() => {
    if (addressInput.trim().length === 0) return;
    setValidation(validateAddressInput(addressInput));
  }, [addressInput]);

  // Re-seed the input when the parent pushes a new prefilledAgentAddress.
  // Skip when the operator has typed their own value — we only overwrite an
  // empty field, or the exact string we set ourselves on the prior prefill.
  // This is the rule that lets the agent-first entry "Apply" feed BindStep
  // without nuking a manual override.
  useEffect(() => {
    if (prefilledAgentAddress === undefined) return;
    if (prefilledAgentAddress === lastPrefilledRef.current) return;
    const currentTrim = addressInput.trim();
    const lastTrim = (lastPrefilledRef.current ?? "").trim();
    const canOverwrite = currentTrim === "" || currentTrim === lastTrim;
    if (!canOverwrite) {
      lastPrefilledRef.current = prefilledAgentAddress;
      return;
    }
    onChangeAddress(prefilledAgentAddress);
    lastPrefilledRef.current = prefilledAgentAddress;
  }, [prefilledAgentAddress, addressInput, onChangeAddress]);

  useEffect(() => {
    // Hard-gate the probe on Avalanche chainId. A probe
    // against the wrong chain's RPC would report kind:"eoa" for a contract
    // that's only deployed on Avalanche, which is misleading. Keep probe idle so
    // the wrong-network Alert renders instead.
    if (wrongNetwork) {
      setProbe({ kind: "idle" });
      return;
    }
    const v = validateAddressInput(addressInput);
    if (!v.ok) {
      // Don't override "" with the no-input error; the input UX shows the
      // address-error span on blur, not on every keystroke.
      if (addressInput.trim().length === 0) setValidation(null);
      else setValidation(v);
      setProbe({ kind: "idle" });
      return;
    }
    setValidation(v);
    if (!publicClient) {
      setProbe({
        kind: "probe-error",
        message: "Public RPC client is not ready. Refresh the page.",
      });
      return;
    }

    const myToken = ++probeTokenRef.current;
    setProbe({ kind: "probing" });
    const id = window.setTimeout(async () => {
      try {
        const result = await probeAgent(publicClient, v.address);
        // Drop the result if the input changed (or the user re-typed,
        // bumping the token) while the RPC was in flight.
        if (probeTokenRef.current !== myToken) return;
        setProbe(result);
      } catch (e) {
        if (probeTokenRef.current !== myToken) return;
        setProbe({
          kind: "probe-error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }, 250);

    return () => {
      window.clearTimeout(id);
    };
  }, [addressInput, publicClient, wrongNetwork]);

  // Decouple orchestrator notifications from the probe effect.
  useEffect(() => {
    if (!validation || !validation.ok) {
      onAgentCleared?.();
      return;
    }
    // Valid address but probe hasn't resolved yet — don't claim "resolved"
    // until we know it has code (or definitively doesn't).
    if (probe.kind === "idle" || probe.kind === "probing") return;
    if (probe.kind === "eoa") {
      onAgentCleared?.();
      return;
    }
    if (probe.kind === "probe-error") {
      // RPC failures don't clear — keep the prior resolved address so the
      // orchestrator can still let the user proceed past a flaky probe.
      return;
    }
    // ward-agent OR no-set-policy-id: address has code; surface it.
    onAgentResolved?.(validation.address);
  }, [validation, probe, onAgentResolved, onAgentCleared]);

  // Idempotency shortcut: never submit a no-op bind transaction.
  const alreadyBoundToThisPolicy = useMemo(() => {
    if (probe.kind !== "ward-agent") return false;
    if (!probe.currentPolicyId) return false;
    return (
      probe.currentPolicyId.toLowerCase() === publishedPolicyId.toLowerCase()
    );
  }, [probe, publishedPolicyId]);

  // Forward the idempotency shortcut to the orchestrator the moment the
  // probe surfaces it. The component renders a "Already bound" branch
  // already; the parent uses this signal to reveal Step 2 without making
  // the operator click anything.
  useEffect(() => {
    if (!validation?.ok) return;
    if (!alreadyBoundToThisPolicy) return;
    onAlreadyBound?.(validation.address);
  }, [validation, alreadyBoundToThisPolicy, onAlreadyBound]);

  const willRebindFromDifferentPolicy = useMemo(() => {
    if (probe.kind !== "ward-agent") return null;
    if (!probe.currentPolicyId) return null;
    if (probe.currentPolicyId === ZERO_BYTES32) return null; // no policy bound -> first bind
    if (probe.currentPolicyId.toLowerCase() === publishedPolicyId.toLowerCase()) return null;
    return probe.currentPolicyId;
  }, [probe, publishedPolicyId]);

  const ownerMismatch = useMemo(() => {
    if (probe.kind !== "ward-agent") return false;
    if (!probe.owner) return false; // owner read failed — let simulate decide
    if (!connectedAddress) return false; // wallet not connected — gate elsewhere
    return probe.owner.toLowerCase() !== connectedAddress.toLowerCase();
  }, [probe, connectedAddress]);

  // Treat validated-but-not-yet-probed as disabled so the wallet can't open early.
  const validationOk = validation && validation.ok;
  const probeScheduledOrRunning =
    !!validationOk &&
    (probe.kind === "idle" || probe.kind === "probing");
  const txInFlight =
    bindResult?.kind === "tx" &&
    (bindResult.tx.kind === "awaiting-signature" ||
      bindResult.tx.kind === "broadcasting" ||
      bindResult.tx.kind === "mining");

  const disablingReason: string | null = (() => {
    if (!isConnected) return "Connect your wallet to bind.";
    if (wrongNetwork) {
      return `Switch your wallet to Avalanche Fuji (chain ${expectedChainId}). Currently on chain ${currentChainId ?? "?"}.`;
    }
    if (!validation) return null; // pre-input; button is hidden anyway
    if (!validation.ok) return validation.error;
    if (probeScheduledOrRunning) return "Checking…";
    if (probe.kind === "eoa") return "That's a wallet address, not a contract.";
    if (probe.kind === "no-set-policy-id") {
      return "This contract does not expose the standard setPolicyId function.";
    }
    if (probe.kind === "probe-error") return probe.message;
    if (alreadyBoundToThisPolicy) return "Already bound to this policy.";
    if (ownerMismatch) return "Connected wallet doesn't own this agent.";
    if (txInFlight) return "Transaction in flight…";
    if (bindResult?.kind === "tx" && bindResult.tx.kind === "mined" && bindResult.tx.ok) {
      return "Bound. See tx below.";
    }
    return null;
  })();

  const bindDisabled = disablingReason !== null;

  // Re-check probe state before submitting in case it changed behind the dialog.
  const onConfirmBind = useCallback(async () => {
    setDialogOpen(false);
    if (!publicClient || !connectedAddress) return;
    if (!validation?.ok) return;
    // Re-read probe defensively — the dialog is on top of the underlying
    // state, but the user could have re-typed or switched chains in the gap.
    if (probe.kind !== "ward-agent") return;
    if (alreadyBoundToThisPolicy) {
      setBindResult({ kind: "already-bound" });
      toast.success("Already bound. No tx needed.", {
        description: `POLICY_ID() already returns ${shortHex(publishedPolicyId)}`,
      });
      return;
    }
    if (ownerMismatch) {
      setBindResult({
        kind: "tx",
        tx: {
          kind: "error",
          message: "Connected wallet doesn't own this agent.",
        },
      });
      return;
    }

    const agent = validation.address;
    setBindResult({ kind: "tx", tx: { kind: "awaiting-signature" } });
    try {
      // Simulate first — the helper pattern other writes use (see
      // simulateAndWritePublish in lib/writes.ts). The simulate surfaces
      // NotOwner / setPolicyId-missing reverts before the wallet popup opens.
      await publicClient.simulateContract({
        address: agent,
        abi: WARD_AGENT_BASE_ABI,
        functionName: "setPolicyId",
        args: [publishedPolicyId],
        account: connectedAddress,
      });

      const gas = await fujiSafeGas(publicClient, {
        address: agent,
        abi: WARD_AGENT_BASE_ABI,
        functionName: "setPolicyId",
        args: [publishedPolicyId],
        account: connectedAddress,
      });

      const txHash = await writeContractAsync({
        address: agent,
        abi: WARD_AGENT_BASE_ABI,
        functionName: "setPolicyId",
        args: [publishedPolicyId],
        gas,
        chainId: ACTIVE_CHAIN_ID,
      });

      setBindResult({ kind: "tx", tx: { kind: "mining", hash: txHash } });

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      // Some agents override setPolicyId without calling super; POLICY_ID readback is stronger than the event.
      let bound: { newPolicyId: Hex; oldPolicyId: Hex; by: Address } | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== agent.toLowerCase()) continue;
        try {
          const parsed = decodeEventLog({
            abi: WARD_AGENT_BASE_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (parsed.eventName === "PolicyBound") {
            bound = parsed.args as {
              newPolicyId: Hex;
              oldPolicyId: Hex;
              by: Address;
            };
            break;
          }
        } catch {
          // not a PolicyBound log; skip
        }
      }

      const ok = receipt.status === "success";
      setBindResult({
        kind: "tx",
        tx: { kind: "mined", hash: txHash, ok },
      });

      if (ok) {
        // Notify the orchestrator BEFORE the toast so it can advance to
        // Step 2 on the same tick the receipt arrives. Fired only on
        // status:success — a reverted mining result keeps the orchestrator
        // in "pending" so the user can retry.
        onBound?.(agent, txHash);

        // Optimistically refresh the in-component probe so the displayed
        // POLICY_ID flips from empty to the published policyId.
        // Without this the post-bind panel keeps saying "unset" until the
        // operator manually re-paste-discovers — a real UX bug surfaced
        // mid-walkthrough. Owner is unchanged by setPolicyId, so we reuse
        // whatever the prior probe had for it.
        setProbe((prev) =>
          prev.kind === "ward-agent"
            ? { ...prev, currentPolicyId: publishedPolicyId }
            : prev,
        );

        // Confirm the bind by reading POLICY_ID() back from the agent. The
        // event log is decoded above but events can be missing (overridden
        // setPolicyId that doesn't call super) — the on-chain view is the
        // ground truth. If the read reverts we fall back to the event.
        let readback: Hex | null = null;
        try {
          readback = (await publicClient.readContract({
            address: agent,
            abi: POLICY_ID_VIEW_ABI,
            functionName: "POLICY_ID",
          })) as Hex;
        } catch {
          readback = null;
        }

        const verification = classifyBindVerification({
          readback,
          expected: publishedPolicyId,
          sawPolicyBoundEvent: bound !== null,
        });

        if (verification.kind === "verified") {
          toast.success("Agent bound. POLICY_ID verified.", {
            description: bound
              ? `${shortHex(bound.oldPolicyId)} → ${shortHex(bound.newPolicyId)}`
              : `POLICY_ID() now returns ${shortHex(verification.readback)}`,
          });
        } else if (verification.kind === "mismatch") {
          toast.error("Bind mined but POLICY_ID mismatch", {
            description: `POLICY_ID() returned ${shortHex(
              verification.readback,
            )}, expected ${shortHex(verification.expected)}. ${
              verification.sawPolicyBoundEvent ? "PolicyBound was emitted. " : "No PolicyBound event. "
            }check the explorer.`,
          });
        } else {
          // fallback: readback unavailable; lean on the event.
          if (verification.sawPolicyBoundEvent && bound) {
            toast.success("Agent bound to policy", {
              description: `${shortHex(bound.oldPolicyId)} → ${shortHex(bound.newPolicyId)}`,
            });
          } else {
            toast.success("Bind tx mined", {
              description:
                "No PolicyBound event detected and POLICY_ID() read failed. Verify on the explorer.",
            });
          }
        }
      } else {
        toast.error("Bind reverted", {
          description: "Transaction mined but reverted on-chain.",
        });
      }
    } catch (e) {
      const humanized = humanizeWeb3Error(e, { functionName: "setPolicyId" });
      setBindResult({
        kind: "tx",
        tx: {
          kind: "error",
          message: humanized.headline,
          raw: humanized.detail,
        },
      });
      toast.error("Bind failed", { description: humanized.headline });
    }
  }, [
    publicClient,
    connectedAddress,
    validation,
    probe,
    alreadyBoundToThisPolicy,
    ownerMismatch,
    publishedPolicyId,
    writeContractAsync,
    onBound,
  ]);

  // Hard-replace the body when on the wrong chain. The probe is gated above
  // (we deliberately don't probe when wrongNetwork) — this branch makes that
  // explicit so the operator sees WHY the input is gone.
  if (wrongNetwork) {
    return (
      <section className="rounded-lg border border-accent/40 bg-accent/[0.06] p-4">
        <div className="text-[10px] font-medium uppercase tracking-wider text-accent">
          Bind to a deployed agent
        </div>
        <div className="mt-3">
          <Alert variant="warn" title="Wrong network">
            Switch your wallet to Avalanche Fuji (chain {expectedChainId}).
            Currently on chain {currentChainId ?? "?"}.
          </Alert>
        </div>
      </section>
    );
  }

  const showError = validation && !validation.ok && validation.error.length > 0;

  return (
    <section className="rounded-lg border border-accent/40 bg-accent/[0.06] p-4">
      <div className="text-[10px] font-medium uppercase tracking-wider text-accent">
        Bind to a deployed agent
      </div>
      <p className="mt-1 text-sm text-text">
        Paste the address of your deployed agent contract. If it extends{" "}
        <code className="font-mono text-xs">WardAgentBase</code> (Ward's
        base contract for late-binding), this updates its policy binding
        (the <code className="font-mono text-xs">POLICY_ID</code> slot) to
        the policy you just published. No redeploy needed.
      </p>

      <div className="mt-3 space-y-3 rounded-md border border-ward-border bg-surface p-3">
        <div>
          <label
            htmlFor="bind-agent-address"
            className="block text-[10px] font-medium uppercase tracking-wider text-text-muted"
          >
            Agent address
          </label>
          <Input
            id="bind-agent-address"
            value={addressInput}
            onChange={(e) => onChangeAddress(e.target.value)}
            onBlur={onBlurAddress}
            placeholder="0x… (deployed WardAgentBase address)"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={showError ? true : undefined}
            aria-describedby={showError ? "bind-agent-address-error" : undefined}
            className="mt-1 w-full font-mono"
          />
          {validation && !validation.ok && validation.error.length > 0 && (
            <p id="bind-agent-address-error" className="mt-1 text-[12px] text-danger">
              {validation.error}
            </p>
          )}
        </div>

        {validation?.ok && (
          <ProbeReport
            probe={probe}
            alreadyBoundToThisPolicy={alreadyBoundToThisPolicy}
            willRebindFromDifferentPolicy={willRebindFromDifferentPolicy}
            ownerMismatch={ownerMismatch}
            connectedAddress={connectedAddress}
          />
        )}

        {validation?.ok && (
          <div className="flex items-baseline justify-between gap-3 border-t border-rule pt-3">
            <span className="text-[11px] text-text-muted">
              {disablingReason ?? "Ready to bind."}
            </span>
            <div className="flex items-center gap-3">
            {/* Skip renders for every terminal probe branch where Step 2 has
                a usable agent address but Step 1 can't (or shouldn't) bind
                here — see canShowSkip. Without it, no-set-policy-id /
                probe-error / owner-mismatch were dead-ends with no way to
                advance the orchestrator's Step 1. */}
            {onSkip && canShowSkip(probe, alreadyBoundToThisPolicy, ownerMismatch) && (
              <button
                type="button"
                onClick={onSkip}
                className="text-xs text-text-muted hover:text-text hover:underline"
              >
                Skip — register instead
              </button>
            )}
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <button
                  type="button"
                  disabled={bindDisabled}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
                >
                  <ShieldCheck size={14} weight="regular" aria-hidden />
                  {probeScheduledOrRunning
                    ? "Checking…"
                    : txInFlight
                      ? "Binding…"
                      : alreadyBoundToThisPolicy
                        ? "Already bound"
                        : bindResult?.kind === "tx" &&
                            bindResult.tx.kind === "mined" &&
                            bindResult.tx.ok
                          ? "Bound"
                          : "Bind agent"}
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Bind agent to policy</DialogTitle>
                  <DialogDescription>
                    Sends a <code className="font-mono text-[11px]">setPolicyId</code>{" "}
                    transaction to your agent contract. This writes the new
                    policy id into its{" "}
                    <code className="font-mono text-[11px]">POLICY_ID</code>{" "}
                    slot. Your wallet will pop up to confirm.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2 text-[12px] text-text-muted">
                  {validation?.ok && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-text-subtle">
                        Agent
                      </div>
                      <div className="mt-0.5 break-all font-mono text-[11px] text-text">
                        {validation.address}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-text-subtle">
                      New POLICY_ID ({publishedLabel})
                    </div>
                    <div className="mt-0.5 break-all font-mono text-[11px] text-text">
                      {publishedPolicyId}
                    </div>
                  </div>
                  {willRebindFromDifferentPolicy && (
                    <Alert variant="warn" title="This will REBIND">
                      Agent is currently bound to{" "}
                      <span className="font-mono">
                        {shortHex(willRebindFromDifferentPolicy)}
                      </span>
                      . Confirming will replace it with the new policyId above.
                    </Alert>
                  )}
                </div>
                <DialogFooter>
                  <DialogClose asChild>
                    <button
                      type="button"
                      className="text-sm text-text-muted hover:underline"
                    >
                      Cancel
                    </button>
                  </DialogClose>
                  <button
                    type="button"
                    onClick={onConfirmBind}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                  >
                    <ShieldCheck size={14} weight="regular" aria-hidden />
                    Confirm bind
                  </button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            </div>
          </div>
        )}

        {bindResult?.kind === "already-bound" && (
          <div className="flex items-center gap-2 border-t border-rule pt-3 text-[12px] text-success">
            <CheckCircle size={14} weight="fill" aria-hidden />
            Already bound — no tx needed.
          </div>
        )}
        {bindResult?.kind === "tx" && (
          <TxStatusPanel tx={bindResult.tx} miningVerb="setPolicyId" />
        )}
      </div>
    </section>
  );
}

interface ProbeReportProps {
  probe: ProbeState;
  alreadyBoundToThisPolicy: boolean;
  willRebindFromDifferentPolicy: Hex | null;
  ownerMismatch: boolean;
  connectedAddress: Address | undefined;
}

function ProbeReport({
  probe,
  alreadyBoundToThisPolicy,
  willRebindFromDifferentPolicy,
  ownerMismatch,
  connectedAddress,
}: ProbeReportProps) {
  if (probe.kind === "idle") return null;

  if (probe.kind === "probing") {
    return (
      <div className="text-[11px] text-text-muted" role="status">
        Checking address…
      </div>
    );
  }

  if (probe.kind === "eoa") {
    return (
      <Alert variant="danger" title="That's a wallet, not a contract">
        Avalanche has no contract code at this address — it looks like a plain
        wallet (EOA). Paste the address of a deployed agent contract instead.
      </Alert>
    );
  }

  if (probe.kind === "no-set-policy-id") {
    return (
      <Alert variant="danger" title="This contract can't be re-bound from the dashboard">
        We couldn't find the standard{" "}
        <code className="font-mono text-[11px]">setPolicyId(bytes32)</code>{" "}
        function on this contract (selector 0x30658feb). If your agent uses a
        custom variant such as{" "}
        <code className="font-mono text-[11px]">setPolicyId(bytes32, address)</code>,
        the dashboard can't call it for you. Either bind it manually with{" "}
        <code className="font-mono text-[11px]">cast send</code>, or extend{" "}
        <code className="font-mono text-[11px]">WardAgentBase</code> so the
        standard signature is available.
      </Alert>
    );
  }

  if (probe.kind === "probe-error") {
    return (
      <Alert variant="warn" title="Couldn't probe agent">
        {probe.message}
      </Alert>
    );
  }

  // probe.kind === "ward-agent"
  return (
    <div className="space-y-2 text-[12px] text-text-muted">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] uppercase tracking-wider text-text-subtle">
          Policy binding · POLICY_ID slot
        </span>
        {probe.currentPolicyId === null ? (
          <span className="text-text-muted">couldn't read</span>
        ) : probe.currentPolicyId === ZERO_BYTES32 ? (
          <span className="text-warn">
            no policy bound yet · this agent currently accepts every call
          </span>
        ) : alreadyBoundToThisPolicy ? (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircle size={12} weight="fill" aria-hidden /> already bound to
            this policy
          </span>
        ) : (
          <span className="font-mono text-text">
            {shortHex(probe.currentPolicyId)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] uppercase tracking-wider text-text-subtle">
          Owner
        </span>
        {probe.owner === null ? (
          <span className="text-text-muted">
            couldn't read · your wallet's pre-flight will catch any ownership
            problem before charging gas
          </span>
        ) : (
          <>
            <AddressChip address={probe.owner} />
            {ownerMismatch && connectedAddress && (
              <span className="text-danger">
                ≠ connected wallet ({connectedAddress.slice(0, 6)}…
                {connectedAddress.slice(-4)})
              </span>
            )}
          </>
        )}
      </div>
      {willRebindFromDifferentPolicy && (
        <div className="border-t border-rule pt-2 text-warn">
          This will REBIND the agent from{" "}
          <span className="font-mono">
            {shortHex(willRebindFromDifferentPolicy)}
          </span>{" "}
          to the just-published policy.
        </div>
      )}
    </div>
  );
}
