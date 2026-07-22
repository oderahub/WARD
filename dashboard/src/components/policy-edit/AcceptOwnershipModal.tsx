import { useCallback, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X as XIcon } from "@phosphor-icons/react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Address, Hex } from "viem";

import { useEventStore } from "../../hooks/useEventStore";
import { useFocusTrapAndEsc } from "../../hooks/useFocusTrapAndEsc";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import {
  acceptPolicyOwnership,
  readPendingPolicyOwner,
  type WriteContractAsync,
} from "../../lib/writes";
import { AddressChip, Alert, Button, ExplorerLink } from "../primitives";
import { Spinner } from "../write/Spinner";

interface Props {
  policyId: Hex;
  /** Current owner — display only. The connected wallet becomes the new owner
   *  once the accept transaction mines. */
  currentOwner: Address;
  oracleAddress: Address;
  onClose: () => void;
  onSuccess: (txHash: Hex) => void;
}

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "mining"; txHash: Hex }
  | { kind: "error"; humanized: { headline: string; detail?: string } };

/**
 * Complete a 2-step ownership transfer by accepting the pending nomination.
 * The connected wallet must match the pending owner recorded on-chain by a
 * prior `transferPolicyOwnership`; the simulate path in writes.ts surfaces a
 * humanized error if it doesn't.
 */
export function AcceptOwnershipModal({
  policyId,
  currentOwner,
  oracleAddress,
  onClose,
  onSuccess,
}: Props) {
  const { address: account } = useAccount();
  const { wrong: wrongNetwork, current: currentChainId, expected: expectedChainId } = useWrongNetwork();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { bumpSnapshot } = useEventStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrapAndEsc(dialogRef, onClose);

  const [state, setState] = useState<State>({ kind: "idle" });

  const inFlight = state.kind === "submitting" || state.kind === "mining";
  const canSubmit =
    !inFlight && !!publicClient && !!account && !!writeContractAsync && !wrongNetwork;

  const submit = useCallback(async () => {
    if (!publicClient || !account) {
      setState({
        kind: "error",
        humanized: { headline: "Wallet is not ready." },
      });
      return;
    }
    setState({ kind: "submitting" });
    try {
      // Re-read chain immediately before submit; another browser may have
      // cancelled this transfer or accepted+re-nominated someone else since
      // the modal opened. Surface a humanized "pending changed" message
      // instead of a gas-burning contract revert.
      const chainPending = await readPendingPolicyOwner(publicClient, oracleAddress, policyId);
      if (chainPending.toLowerCase() !== account.toLowerCase()) {
        setState({
          kind: "error",
          humanized: {
            headline: "Pending ownership changed. Reload.",
            detail: `Chain reports pendingPolicyOwner=${chainPending} (not your wallet ${account}). Close and reopen to see the current transfer state.`,
          },
        });
        return;
      }

      const { txHash } = await acceptPolicyOwnership({
        publicClient,
        // See PauseConfirmModal for the rationale on this cast.
        writeContractAsync: writeContractAsync as WriteContractAsync,
        oracleAddress,
        policyId,
        account,
        chainId: expectedChainId,
      });
      setState({ kind: "mining", txHash });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      bumpSnapshot();
      onSuccess(txHash);
    } catch (err) {
      setState({ kind: "error", humanized: humanizeWeb3Error(err) });
    }
  }, [
    publicClient,
    account,
    writeContractAsync,
    oracleAddress,
    policyId,
    expectedChainId,
    bumpSnapshot,
    onSuccess,
  ]);

  const submitLabel =
    state.kind === "submitting"
      ? "Confirm in wallet…"
      : state.kind === "mining"
        ? "Mining…"
        : "Accept ownership";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Accept policy ownership"
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
        className="w-full max-w-md rounded-lg border border-sentry-border bg-surface-elev p-5 text-sm text-text shadow-2xl"
      >
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">Accept policy ownership</h3>
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

        <div className="space-y-3">
          {wrongNetwork && (
            <Alert variant="warn" title="Wrong network">
              {`Connected to chain ${currentChainId ?? "?"}. Switch to Somnia Shannon (${expectedChainId}) before submitting.`}
            </Alert>
          )}

          <p className="text-xs text-text-muted">
            Accepting transfers ownership of this policy to your wallet. The
            current owner has already nominated you on-chain; this call
            completes the handover.
          </p>
          <div className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
            Current owner: <AddressChip address={currentOwner} />
          </div>
          <Alert variant="warn">
            Once you accept, the current owner loses the ability to update or
            pause this policy. Verify you trust the current owner's last
            published state before accepting.
          </Alert>
        </div>

        {state.kind === "mining" && (
          <div className="mt-3 rounded-md border border-sentry-border bg-surface p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Mining acceptPolicyOwnership…</span>
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

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={onClose} disabled={inFlight}>
            Cancel
          </Button>
          <Button
            variant="accent"
            size="md"
            onClick={submit}
            disabled={!canSubmit}
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
