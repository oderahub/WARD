import { useCallback, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X as XIcon } from "@phosphor-icons/react";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";
import type { Address, Hex } from "viem";
import type { PolicyInput } from "@ward/sdk";

import { useEventStore } from "../../hooks/useEventStore";
import { useFocusTrapAndEsc } from "../../hooks/useFocusTrapAndEsc";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import { ACTIVE_CHAIN_ID } from "../../lib/networks";
import { cachePublished, readPublished } from "../../lib/publishedCache";
import {
  ConcurrentEditError,
  readChainHealth,
  setPolicyPaused,
  type WriteContractAsync,
} from "../../lib/writes";
import { Alert, Button, ExplorerLink } from "../primitives";
import { Spinner } from "../write/Spinner";

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

/**
 * Toggle a policy's `paused` flag via a full `updatePolicy(...)` re-submission.
 *
 * The on-chain contract has no partial-update path — `updatePolicy` is a full
 * struct replacement — so the writes-layer helper spreads `currentInput` with
 * the new `paused` value. The caller must supply the original PolicyInput
 * from publishedCache; PolicyActions enforces this by disabling the button
 * when the body isn't cached.
 *
 * After the receipt mines, the publishedCache entry is rewritten so the next
 * open of the drawer sees the post-toggle body without a re-fetch.
 */
export function PauseConfirmModal({
  policyId,
  currentInput,
  oracleAddress,
  onClose,
  onSuccess,
}: Props) {
  const { address: account } = useAccount();
  const walletChainId = useChainId();
  const chainId = walletChainId || ACTIVE_CHAIN_ID;
  const { wrong: wrongNetwork, current: currentChainId, expected: expectedChainId } = useWrongNetwork();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { store, bumpSnapshot } = useEventStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrapAndEsc(dialogRef, onClose);

  // Capture lastUpdatedBlock at modal mount as the optimistic-concurrency
  // token. Pulled from the in-memory EventStore — same browser sees its own
  // writes via the live subscription, and the writes.ts probe re-confirms
  // against chain right before submit so cross-browser concurrent edits also
  // surface as ConcurrentEditError instead of silently overwriting.
  const expectedLastUpdatedBlockRef = useRef<bigint>(
    store?.getPolicy(policyId)?.lastUpdatedBlock ?? 0n,
  );

  const [state, setState] = useState<State>({ kind: "idle" });

  const isUnpause = currentInput.paused === true;
  const nextPaused = !isUnpause;
  const actionLabel = isUnpause ? "Unpause policy" : "Pause policy";
  const title = isUnpause ? "Unpause this policy?" : "Pause this policy?";
  const body = isUnpause
    ? "Unpause this policy? checkIntent will resume returning normally per the target/selector tiers."
    : "Pause this policy? Every checkIntent will return (false, PAUSED) until you unpause.";

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
      const { txHash } = await setPolicyPaused({
        publicClient,
        // wagmi's writeContractAsync has a stricter generic signature than the
        // structural `WriteContractAsync` writes.ts declares; the runtime
        // call shape is identical (it's the same wagmi mutation), so we cast
        // at the boundary rather than re-deriving the full generic.
        writeContractAsync: writeContractAsync as WriteContractAsync,
        oracleAddress,
        policyId,
        account,
        currentInput,
        paused: nextPaused,
        expectedLastUpdatedBlock: expectedLastUpdatedBlockRef.current,
        chainId: expectedChainId,
      });
      setState({ kind: "mining", txHash });
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Update publishedCache so the next drawer-open reflects the new
      // `paused` state without re-fetching the body off-chain (we can't, in
      // v1 — the body is only known to the publishing browser).
      //
      // Re-read live state from chain instead of trusting the local intent —
      // a concurrent extend/pause from another browser may have mined in
      // between, and writing `{ ...currentInput, paused: nextPaused }` would
      // roll the OTHER field back to its stale cached value. The writes-layer
      // merges chain state into the submit payload, so chain post-mine is
      // authoritative for both single-field axes.
      // Refresh publishedCache from chain, but isolate this from the outer
      // catch — the tx already mined, so an RPC blip on the read must not
      // surface as "Action failed". Fall back to the locally-spread struct.
      const cached = await readPublished(chainId, oracleAddress, policyId);
      if (cached) {
        try {
          const chain = await readChainHealth(publicClient, oracleAddress, policyId);
          const nextInput: PolicyInput = {
            ...currentInput,
            paused: chain.paused,
            expiresAt: chain.expiresAt,
          };
          const policyInputJSON = JSON.stringify(nextInput, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          );
          await cachePublished(chainId, oracleAddress, {
            ...cached,
            policyInputJSON,
          });
        } catch (refreshErr) {
          console.warn(
            `PauseConfirmModal: post-mine chain refresh failed for policy ${policyId}`,
            refreshErr,
          );
          const fallbackInput: PolicyInput = {
            ...currentInput,
            paused: nextPaused,
          };
          const policyInputJSON = JSON.stringify(fallbackInput, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
          );
          await cachePublished(chainId, oracleAddress, {
            ...cached,
            policyInputJSON,
          });
        }
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
    currentInput,
    nextPaused,
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
        : actionLabel;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
          <h3 className="text-sm font-semibold text-text">{title}</h3>
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

        <p className="text-xs text-text-muted">{body}</p>

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
