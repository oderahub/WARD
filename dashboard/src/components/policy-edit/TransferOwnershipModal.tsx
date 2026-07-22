import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X as XIcon } from "@phosphor-icons/react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { getAddress, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { WARD_ORACLE_ABI } from "@ward/sdk";

import { useEventStore } from "../../hooks/useEventStore";
import { useFocusTrapAndEsc } from "../../hooks/useFocusTrapAndEsc";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import { transferPolicyOwnership, type WriteContractAsync } from "../../lib/writes";
import { AddressChip, Alert, Button, ExplorerLink, Input } from "../primitives";
import { Spinner } from "../write/Spinner";

interface Props {
  policyId: Hex;
  /** Not needed for transfer — kept optional so callers can pass the shared
   *  base-props shape without branching. */
  currentInput?: never;
  oracleAddress: Address;
  onClose: () => void;
  onSuccess: (txHash: Hex) => void;
}

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "mining"; txHash: Hex }
  | { kind: "error"; humanized: { headline: string; detail?: string } };

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const BYTECODE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Race `getBytecode` against a hard timeout so a hanging RPC
 * doesn't wedge the debounced probe (canSubmit blocked on `checking`) or the
 * submit-time fallback probe (no UI feedback at all). Used by BOTH callers so
 * timeout semantics stay aligned.
 */
async function probeWithTimeout(
  client: PublicClient,
  addr: Address,
): Promise<string | undefined | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), BYTECODE_PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      client.getBytecode({ address: addr }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Initiate a 2-step ownership transfer for a policy. The new owner must call
 * `acceptPolicyOwnership` from their wallet to complete the handover; the
 * current owner can `cancelPolicyOwnershipTransfer` at any time before then.
 *
 * Pre-warms the pending-transfer state via `pendingPolicyOwner(policyId)` so
 * the warning banner appears immediately when there's already a nominee in
 * flight (initiating again silently overwrites it on-chain).
 */
export function TransferOwnershipModal({
  policyId,
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

  const [newOwner, setNewOwner] = useState("");
  const [pendingOwner, setPendingOwner] = useState<Address | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  // Bytecode probe state for the typed `newOwner`. `idle` while
  // the input is empty / not a valid address; `checking` during the debounce
  // window; `eoa`/`contract` once resolved; `error` if the RPC failed (we
  // surface an INFO note in that case and do NOT block submit, to avoid
  // wedging the modal on a transient RPC blip).
  const [bytecodeCheck, setBytecodeCheck] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "eoa" }
    | { kind: "contract" }
    | { kind: "error"; reason: "timeout" | "rpc"; message?: string }
  >({ kind: "idle" });
  const [contractOwnerAck, setContractOwnerAck] = useState(false);

  // One-shot read of the on-chain pending owner so we can show the
  // "replacing existing pending transfer" warning before the user types.
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    publicClient
      .readContract({
        address: oracleAddress,
        abi: WARD_ORACLE_ABI,
        functionName: "pendingPolicyOwner",
        args: [policyId],
      })
      .then((result) => {
        if (cancelled) return;
        const addr = result as Address;
        setPendingOwner(addr && addr !== ZERO_ADDRESS ? addr : null);
      })
      .catch(() => {
        // Best-effort: a failed read just suppresses the warning. The on-chain
        // simulate path in transferPolicyOwnership will still catch any actual
        // problem before the wallet popup.
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient, oracleAddress, policyId]);

  const trimmed = newOwner.trim();
  // viem's `isAddress` returns true for both lowercased and checksummed input
  // when `strict` defaults to true; we capture the checksummed form for the
  // simulate call so the user's mixed-case input doesn't fail an EIP-55 check.
  const isValid = isAddress(trimmed);
  const checksummed = useMemo<Address | null>(() => {
    if (!isValid) return null;
    try {
      return getAddress(trimmed) as Address;
    } catch {
      return null;
    }
  }, [trimmed, isValid]);

  const isSelf =
    !!checksummed && !!account && checksummed.toLowerCase() === account.toLowerCase();
  const isZero =
    !!checksummed && checksummed.toLowerCase() === ZERO_ADDRESS.toLowerCase();

  // Debounced bytecode probe. Fires whenever the user types a
  // syntactically-valid address that isn't self/zero. 300ms debounce is long
  // enough to swallow paste-then-typo edits without making the UI feel
  // sluggish; `cancelled` guards prevent late responses from clobbering a
  // newer input. The ack + probe reset on input edit happens synchronously
  // in the input's onChange handler — doing it here in a passive effect
  // would leave an intermediate render where canSubmit sees stale
  // ack=true + contract applied to the newly-typed address.
  useEffect(() => {
    if (!publicClient || !checksummed || isSelf || isZero) {
      return;
    }
    setBytecodeCheck({ kind: "checking" });
    let cancelled = false;
    const timer = setTimeout(() => {
      // Uses the shared `probeWithTimeout` helper so the
      // 5s timeout semantics match the submit-time fallback path. Timeout
      // resolves to the `error` branch (pass-through for canSubmit) with a
      // humanized note.
      probeWithTimeout(publicClient, checksummed)
        .then((code) => {
          if (cancelled) return;
          if (code === "timeout") {
            setBytecodeCheck({
              kind: "error",
              reason: "timeout",
              message: "Address check timed out. Try again before submitting.",
            });
            return;
          }
          // viem returns `undefined` (or "0x") for EOAs. Anything longer is
          // contract code.
          const isContract = !!code && code !== "0x" && code.length > 2;
          setBytecodeCheck({ kind: isContract ? "contract" : "eoa" });
        })
        .catch(() => {
          if (cancelled) return;
          setBytecodeCheck({ kind: "error", reason: "rpc" });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [publicClient, checksummed, isSelf, isZero]);

  const replacesPending =
    pendingOwner !== null &&
    (!checksummed ||
      pendingOwner.toLowerCase() !== checksummed.toLowerCase());

  const inFlight = state.kind === "submitting" || state.kind === "mining";
  // Block submit until the bytecode probe resolves AND the operator acks the
  // contract case. RPC-blip `error` and `eoa` are pass-through (we don't wedge
  // on a transient RPC hiccup); the unacknowledged-contract case blocks, and
  // so does `checking` — otherwise a paste-then-click within the 300ms
  // debounce window could bypass the ack entirely.
  // A timed-out probe is NOT a pass-through. Timeout
  // means we have zero signal about whether this address is a contract, so
  // we force the user to wait/retry rather than silently letting an unverified
  // address through to the wallet popup. RPC errors stay permissive because a
  // user who genuinely needs to ship past a flaky node can; timeout is the
  // sub-case where "couldn't tell" is the answer, not "RPC blip".
  const needsContractAck =
    bytecodeCheck.kind === "contract" && !contractOwnerAck;
  const probeInFlight = bytecodeCheck.kind === "checking";
  const probeTimedOut =
    bytecodeCheck.kind === "error" && bytecodeCheck.reason === "timeout";
  const canSubmit =
    isValid &&
    !isZero &&
    !isSelf &&
    !inFlight &&
    !needsContractAck &&
    !probeInFlight &&
    !probeTimedOut &&
    !!publicClient &&
    !!account &&
    !!writeContractAsync &&
    checksummed !== null &&
    !wrongNetwork;

  const submit = useCallback(async () => {
    if (!publicClient || !account || !checksummed) {
      setState({
        kind: "error",
        humanized: { headline: "Wallet is not ready." },
      });
      return;
    }
    // Belt-and-braces: if the debounced probe hasn't resolved
    // yet (paste-then-click within the 300ms window), resolve it synchronously
    // here so we never submit a contract address without the ack. `canSubmit`
    // also blocks the `checking` state, but the button can be activated via
    // keyboard before that disabled-state re-renders. We also re-probe when
    // the prior probe resolved to `contract` but the ack hasn't been given,
    // which closes a residual stale-state race where the user edits the
    // input to a different address: the synchronous setNewOwner + reset in
    // onChange clears ack, but a fast keyboard submit could otherwise skip
    // the probe entirely on the new address.
    // `error` is also part of the re-probe trigger
    // set. canSubmit blocks the timeout case, but a keyboard-activation race
    // (the button became enabled when the probe went idle→checking, then we
    // need to handle the rare case where state transitioned to error between
    // canSubmit eval and the click); re-probing here gives us one more shot
    // at a fresh answer before falling through to the wallet.
    if (
      bytecodeCheck.kind === "idle" ||
      bytecodeCheck.kind === "checking" ||
      bytecodeCheck.kind === "error" ||
      (bytecodeCheck.kind === "contract" && !contractOwnerAck)
    ) {
      // Submit-time probe uses the same timeout-bounded
      // helper as the debounced effect. On timeout we ABORT (do not
      // "proceed carefully"): submit-time is too late to fall through to an
      // unverified contract address — the wallet popup is next.
      const code = await probeWithTimeout(publicClient, checksummed).catch(
        () => undefined,
      );
      if (code === "timeout") {
        setBytecodeCheck({
          kind: "error",
          reason: "timeout",
          message: "Address check timed out. Try again before submitting.",
        });
        setState({
          kind: "error",
          humanized: {
            headline: "Address check timed out before submit. Try again.",
          },
        });
        return;
      }
      const isContract = !!code && code !== "0x" && code.length > 2;
      setBytecodeCheck({ kind: isContract ? "contract" : "eoa" });
      if (isContract && !contractOwnerAck) {
        // The contract-warning Alert (and its ack checkbox) will render on the
        // next paint thanks to the setBytecodeCheck above.
        return;
      }
    }
    setState({ kind: "submitting" });
    try {
      const { txHash } = await transferPolicyOwnership({
        publicClient,
        // See PauseConfirmModal for the rationale on this cast.
        writeContractAsync: writeContractAsync as WriteContractAsync,
        oracleAddress,
        policyId,
        account,
        newOwner: checksummed,
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
    checksummed,
    expectedChainId,
    bumpSnapshot,
    onSuccess,
    bytecodeCheck.kind,
    contractOwnerAck,
  ]);

  const submitLabel =
    state.kind === "submitting"
      ? "Confirm in wallet…"
      : state.kind === "mining"
        ? "Mining…"
        : "Initiate transfer";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Transfer policy ownership"
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
          <h3 className="text-sm font-semibold text-text">Transfer policy ownership</h3>
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
              {`Connected to chain ${currentChainId ?? "?"}. Switch to Avalanche Fuji (${expectedChainId}) before submitting.`}
            </Alert>
          )}

          <p className="text-xs text-text-muted">
            After you initiate, the new owner must call{" "}
            <code className="font-mono text-text">acceptPolicyOwnership</code>{" "}
            from their wallet. You can cancel the pending transfer at any time
            before they accept.
          </p>

          {replacesPending && pendingOwner && (
            <Alert variant="warn">
              <div className="flex flex-wrap items-center gap-1">
                There is already a pending transfer to{" "}
                <AddressChip address={pendingOwner} />. This will replace it.
              </div>
            </Alert>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-text-subtle">
              new owner address
            </span>
            <Input
              className="font-mono"
              placeholder="0x…"
              value={newOwner}
              onChange={(e) => {
                const next = e.target.value;
                setNewOwner(next);
                // Reset ack + probe state synchronously with the input change so
                // canSubmit cannot evaluate to true with a
                // stale ack applied to the new address in any intermediate
                // render between the input edit and the passive effect.
                setBytecodeCheck({ kind: "idle" });
                setContractOwnerAck(false);
              }}
              aria-invalid={trimmed.length > 0 && !isValid ? true : undefined}
              autoFocus
            />
            {trimmed.length > 0 && !isValid && (
              <span className="text-[11px] text-danger" role="alert">
                not a valid 0x-prefixed 40-hex address
              </span>
            )}
            {isValid && isZero && (
              <span className="text-[11px] text-danger" role="alert">
                cannot transfer to the zero address
              </span>
            )}
            {isValid && isSelf && (
              <span className="text-[11px] text-danger" role="alert">
                you already own this policy
              </span>
            )}
          </label>

          {bytecodeCheck.kind === "checking" && (
            <p className="text-[11px] text-text-muted" role="status">
              Checking address type…
            </p>
          )}

          {bytecodeCheck.kind === "contract" && (
            <Alert variant="warn" title="Address has contract code">
              <div className="space-y-2">
                <p>
                  This is a CONTRACT address. If it can't call{" "}
                  <code className="font-mono">acceptPolicyOwnership</code>{" "}
                  (and later <code className="font-mono">acceptOwnership</code>
                  ), the policy will be permanently unmanageable.
                </p>
                <label className="flex items-center gap-2 text-text">
                  <input
                    type="checkbox"
                    checked={contractOwnerAck}
                    onChange={(e) => setContractOwnerAck(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  <span>I understand. Transfer to this contract anyway.</span>
                </label>
              </div>
            </Alert>
          )}

          {bytecodeCheck.kind === "error" && bytecodeCheck.reason === "timeout" && (
            <p className="text-[11px] text-danger" role="alert">
              {bytecodeCheck.message ??
                "Address check timed out. Try again before submitting."}
            </p>
          )}

          {bytecodeCheck.kind === "error" && bytecodeCheck.reason === "rpc" && (
            <p className="text-[11px] text-text-muted" role="status">
              {bytecodeCheck.message ??
                "Couldn't verify whether this address is a contract (RPC error). Proceeding without the EOA/contract check."}
            </p>
          )}
        </div>

        {state.kind === "mining" && (
          <div className="mt-3 rounded-md border border-ward-border bg-surface p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Mining transferPolicyOwnership…</span>
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
