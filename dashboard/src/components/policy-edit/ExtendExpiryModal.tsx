import { useCallback, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X as XIcon } from "@phosphor-icons/react";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";
import type { Address, Hex } from "viem";
import type { PolicyInput } from "@ward/sdk";

import { useEventStore } from "../../hooks/useEventStore";
import { useFocusTrapAndEsc } from "../../hooks/useFocusTrapAndEsc";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import { SOMNIA_CHAIN_ID } from "../../lib/networks";
import { cachePublished, readPublished } from "../../lib/publishedCache";
import { formatExpiresAtForModal } from "../../lib/policy-render";
import {
  ConcurrentEditError,
  readChainHealth,
  setPolicyExpiry,
  type WriteContractAsync,
} from "../../lib/writes";
import { Alert, Button, ExplorerLink, Input } from "../primitives";
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

function toLocalDatetime(unixSec: bigint): string {
  if (unixSec === 0n) return "";
  const d = new Date(Number(unixSec) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDatetime(local: string): bigint | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return BigInt(Math.floor(d.getTime() / 1000));
}

// Current-expiry display delegates to `formatExpiresAtForModal` in
// `lib/policy-render.ts` so the legacy-0 sentinel wording stays in lockstep
// with the drawer / diff / reveal surfaces. See that module for the rationale
// on why a 0 expiry renders as expired rather than "never".
const fmtAbs = formatExpiresAtForModal;

/**
 * Format a signed second delta as a coarse, human-readable delta string.
 * Pulled out so the comparison line ("3 months earlier" / "1 year later")
 * stays predictable across modals if this gets re-used.
 */
function fmtDelta(deltaSec: bigint): string {
  if (deltaSec === 0n) return "no change";
  const abs = deltaSec < 0n ? -deltaSec : deltaSec;
  const sign = deltaSec > 0n ? "later" : "earlier";
  const secs = Number(abs);
  if (!Number.isFinite(secs)) return `${abs.toString()}s ${sign}`;
  const day = 86400;
  if (secs < 3600) return `${Math.round(secs / 60)}m ${sign}`;
  if (secs < day) return `${Math.round(secs / 3600)}h ${sign}`;
  if (secs < 30 * day) return `${Math.round(secs / day)}d ${sign}`;
  if (secs < 365 * day) return `${Math.round(secs / (30 * day))}mo ${sign}`;
  return `${(secs / (365 * day)).toFixed(1)}y ${sign}`;
}

/**
 * Update only the `expiresAt` field of a policy. Allows shortening or
 * extending — the user explicitly chose the new timestamp, so we don't enforce
 * monotonicity. The on-chain contract is the authority and the simulate path
 * (in `setPolicyExpiry`) surfaces any revert before the wallet pops up.
 */
export function ExtendExpiryModal({
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrapAndEsc(dialogRef, onClose);

  // See PauseConfirmModal: capture the snapshot's lastUpdatedBlock at mount
  // so the writes-layer probe can detect cross-browser concurrent edits in
  // the wallet-popup window.
  const expectedLastUpdatedBlockRef = useRef<bigint>(
    store?.getPolicy(policyId)?.lastUpdatedBlock ?? 0n,
  );

  const [local, setLocal] = useState<string>(() =>
    toLocalDatetime(currentInput.expiresAt),
  );
  const [state, setState] = useState<State>({ kind: "idle" });
  const [shortenAck, setShortenAck] = useState(false);

  const newExpiry = useMemo(() => fromLocalDatetime(local), [local]);
  const valid = newExpiry !== null;
  const delta = valid ? newExpiry - currentInput.expiresAt : 0n;
  const unchanged = valid && delta === 0n;

  // Schema rejects expiresAt <= now, so block submit early instead of
  // letting the user burn gas on a guaranteed-revert tx. Compute nowSec at
  // render time — the modal is short-lived so we don't bother ticking.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const currentExpirySec = currentInput.expiresAt;
  const isPastExpiry = valid && newExpiry !== null && newExpiry <= nowSec;
  const isShortening =
    valid &&
    newExpiry !== null &&
    currentExpirySec > nowSec &&
    newExpiry < currentExpirySec;

  const inFlight = state.kind === "submitting" || state.kind === "mining";
  const canSubmit =
    valid &&
    !unchanged &&
    !isPastExpiry &&
    (!isShortening || shortenAck) &&
    !inFlight &&
    !!publicClient &&
    !!account &&
    !!writeContractAsync &&
    !wrongNetwork;

  const submit = useCallback(async () => {
    if (!publicClient || !account || newExpiry === null) {
      setState({
        kind: "error",
        humanized: { headline: "Wallet is not ready." },
      });
      return;
    }
    // Submit-time re-derivation: the dialog may have been sitting open
    // across the expiry boundary the user originally picked. Re-derive
    // both `nowSec` and the parsed new expiry at click-time and re-check
    // they're still ordered correctly — the wallet popup must never fire
    // for an already-past expiry the contract would revert.
    const submitNewExpirySec = fromLocalDatetime(local);
    const submitNowSec = BigInt(Math.floor(Date.now() / 1000));
    if (submitNewExpirySec === null) {
      setState({
        kind: "error",
        humanized: { headline: "must be a parseable timestamp" },
      });
      return;
    }
    if (submitNewExpirySec <= submitNowSec) {
      setState({
        kind: "error",
        humanized: {
          headline:
            "Expiry slipped into the past while this dialog was open. Pick a new future date.",
        },
      });
      return;
    }
    setState({ kind: "submitting" });
    try {
      const { txHash } = await setPolicyExpiry({
        publicClient,
        // See PauseConfirmModal for the rationale on this cast.
        writeContractAsync: writeContractAsync as WriteContractAsync,
        oracleAddress,
        policyId,
        account,
        currentInput,
        expiresAt: submitNewExpirySec,
        expectedLastUpdatedBlock: expectedLastUpdatedBlockRef.current,
        chainId: expectedChainId,
      });
      setState({ kind: "mining", txHash });
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      // Re-read live state from chain instead of trusting the local intent —
      // see PauseConfirmModal for the rationale. A concurrent pause from
      // another browser may have mined in between, and writing
      // `{ ...currentInput, expiresAt: newExpiry }` would roll the `paused`
      // flag back to the stale cached value.
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
            `ExtendExpiryModal: post-mine chain refresh failed for policy ${policyId}`,
            refreshErr,
          );
          const fallbackInput: PolicyInput = {
            ...currentInput,
            expiresAt: submitNewExpirySec,
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
    newExpiry,
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
        : "Update expiry";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Extend policy expiry"
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
          <h3 className="text-sm font-semibold text-text">Extend policy expiry</h3>
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

          {(currentExpirySec === 0n || currentExpirySec <= nowSec) && (
            <Alert variant="warn" title="Re-activating a previously-expired policy">
              <p>
                The current expiry is{" "}
                <span className="font-mono">{fmtAbs(currentExpirySec)}</span>.
                this policy is already expired and blocking every call. Picking
                a new future date here brings it BACK live for the chosen
                window; any calls that were blocked while expired won't be
                retried automatically.
              </p>
            </Alert>
          )}

          <div className="rounded-md border border-ward-border bg-surface p-2 text-xs">
            <div className="flex justify-between gap-2">
              <span className="text-text-subtle">Current expiry</span>
              <span className="font-mono text-text">{fmtAbs(currentInput.expiresAt)}</span>
            </div>
            <div className="mt-1 flex justify-between gap-2">
              <span className="text-text-subtle">New expiry</span>
              <span className={`font-mono ${valid ? "text-text" : "text-text-subtle"}`}>
                {valid && newExpiry !== null ? fmtAbs(newExpiry) : "—"}
              </span>
            </div>
            {valid && !unchanged && (
              <div className="mt-1 flex justify-between gap-2">
                <span className="text-text-subtle">Change</span>
                <span className="font-mono text-warn">{fmtDelta(delta)}</span>
              </div>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-text-subtle">
              new expiry (local time)
            </span>
            <Input
              type="datetime-local"
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              aria-invalid={!valid || undefined}
            />
            {!valid && (
              <span className="text-[11px] text-danger" role="alert">
                must be a parseable timestamp
              </span>
            )}
            {valid && isPastExpiry && (
              <span className="text-[11px] text-danger" role="alert">
                Expiry must be in the future.
              </span>
            )}
          </label>

          {isShortening && (
            <label className="flex items-start gap-2 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={shortenAck}
                onChange={(e) => setShortenAck(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <span>
                I understand this shortens the policy expiry (current: {fmtAbs(currentExpirySec)}, new:{" "}
                {newExpiry !== null ? fmtAbs(newExpiry) : "—"}).
              </span>
            </label>
          )}
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

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={onClose} disabled={inFlight}>
            Cancel
          </Button>
          <Button
            variant="accent"
            size="md"
            onClick={submit}
            disabled={!canSubmit}
            title={unchanged ? "New expiry matches current. Change it to enable submit" : undefined}
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
