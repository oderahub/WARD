import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X as XIcon } from "@phosphor-icons/react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Address, Hex } from "viem";

import { useEventStore } from "../../hooks/useEventStore";
import { useFocusTrapAndEsc } from "../../hooks/useFocusTrapAndEsc";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import {
  cancelPolicyOwnershipTransfer,
  readPendingPolicyOwner,
  type WriteContractAsync,
} from "../../lib/writes";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
import { AddressChip, Alert, Button, ExplorerLink } from "../primitives";
import { Spinner } from "../write/Spinner";

interface Props {
  policyId: Hex;
  /** Current pending nominee (display only). */
  pendingOwner: Address;
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
 * Revoke an in-flight 2-step ownership transfer for a policy. After this
 * mines, the previously nominated address can no longer call
 * `acceptPolicyOwnership`; the policy stays under the current owner with no
 * pending transfer.
 */
export function CancelTransferModal({
  policyId,
  pendingOwner,
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
  // The prop is the seed value captured by the drawer when
  // it loaded; the drawer's own live read may still be in flight when this
  // modal opens, so the seed can be stale. Re-read once on mount and
  // ALWAYS overwrite (even on zero, so the user sees the
  // already-gone state immediately instead of waiting until submit). On
  // failure fall back to the prop (don't block opening); the pre-submit
  // re-read in `submit` is the actual safety net for false mismatches.
  const [seedPendingOwner, setSeedPendingOwner] =
    useState<Address>(pendingOwner);
  const [refreshingSeed, setRefreshingSeed] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  useEffect(() => {
    if (!publicClient) {
      setRefreshingSeed(false);
      return;
    }
    let cancelled = false;
    readPendingPolicyOwner(publicClient, oracleAddress, policyId)
      .then((fresh) => {
        if (cancelled) return;
        // Always overwrite, including the zero-address
        // case. The `alreadyGone` derivation below turns zero into a visible
        // warn Alert and blocks submit.
        if (fresh) setSeedPendingOwner(fresh as Address);
      })
      .catch(() => {
        // Best-effort: keep the prop value as the seed.
      })
      .finally(() => {
        if (!cancelled) setRefreshingSeed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const alreadyGone = seedPendingOwner.toLowerCase() === ZERO_ADDRESS;

  const inFlight = state.kind === "submitting" || state.kind === "mining";
  const canSubmit =
    !inFlight &&
    !refreshingSeed &&
    !alreadyGone &&
    !!publicClient &&
    !!account &&
    !!writeContractAsync &&
    !wrongNetwork;

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
      // Last-second pending-owner read. The drawer captured `pendingOwner`
      // when it loaded; in the seconds since, the nominee may have already
      // accepted (transfer completed), someone may have cancelled, or the
      // owner may have re-issued the transfer to a DIFFERENT nominee. Re-read
      // chain immediately before submit so the user sees a humanized message
      // instead of a gas-burning revert — or silently cancelling a transfer
      // they didn't mean to. `seedPendingOwner` is the freshly-read value
      // captured on mount — falling back to the prop only
      // when the mount-time read failed.
      const chainPending = await readPendingPolicyOwner(publicClient, oracleAddress, policyId);
      if (chainPending.toLowerCase() === ZERO_ADDRESS) {
        setState({
          kind: "error",
          humanized: {
            headline: "Transfer already cancelled or accepted.",
            detail: "Chain reports no pending transfer for this policy. Close the modal to see the current ownership state.",
          },
        });
        return;
      }
      if (chainPending.toLowerCase() !== seedPendingOwner.toLowerCase()) {
        setState({
          kind: "error",
          humanized: {
            headline: "Pending nominee changed since this modal opened.",
            detail: `Was ${seedPendingOwner}, now ${chainPending}. Close and reopen to confirm which transfer you're cancelling.`,
          },
        });
        return;
      }

      const { txHash } = await cancelPolicyOwnershipTransfer({
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
    seedPendingOwner,
    expectedChainId,
    bumpSnapshot,
    onSuccess,
  ]);

  const submitLabel =
    state.kind === "submitting"
      ? "Confirm in wallet…"
      : state.kind === "mining"
        ? "Mining…"
        : "Cancel transfer";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Cancel pending ownership transfer"
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
        className="w-full max-w-md rounded-lg border border-ward-border bg-surface-elev p-5 text-sm text-text shadow-2xl"
      >
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">
            Cancel pending ownership transfer
          </h3>
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

        {wrongNetwork && (
          <Alert variant="warn" title="Wrong network" className="mb-3">
            {`Connected to chain ${currentChainId ?? "?"}. Switch to Avalanche Fuji (${expectedChainId}) before submitting.`}
          </Alert>
        )}

        {alreadyGone && !refreshingSeed && (
          <Alert variant="warn" title="No pending transfer" className="mb-3">
            Transfer already cancelled or accepted — close this dialog.
          </Alert>
        )}

        <div className="space-y-2 text-xs text-text-muted">
          <p className="flex flex-wrap items-center gap-1">
            The nominee at{" "}
            {refreshingSeed ? (
              <span className="inline-flex items-center gap-1 text-text-muted">
                <Spinner /> Loading…
              </span>
            ) : alreadyGone ? (
              <span className="font-mono text-text-muted">none</span>
            ) : (
              <AddressChip address={seedPendingOwner} />
            )}{" "}
            will no longer be able to accept this transfer.
          </p>
          <p>
            The policy stays under the current owner with no pending transfer.
          </p>
          <p>
            You can start a new transfer at any time from the ownership
            section.
          </p>
        </div>

        {state.kind === "mining" && (
          <div className="mt-3 rounded-md border border-ward-border bg-surface p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">
                Mining cancelPolicyOwnershipTransfer…
              </span>
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
