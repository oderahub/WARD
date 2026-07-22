import { useCallback, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X as XIcon } from "@phosphor-icons/react";
import {
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { type QueueRecordHeader } from "@sentry-somnia/sdk";

import { useFocusTrapAndEsc } from "../../hooks/useFocusTrapAndEsc";
import { humanizeWeb3Error } from "../../lib/humanizeError";
import { ACTIVE_CHAIN_ID, getActiveNetwork } from "../../lib/networks";
import {
  dispatchIntent,
  expireIfStaleIntent,
  vetoIntent,
} from "../../lib/writes";
import { AddressChip, Alert, Button, Row } from "../primitives";
import {
  ACTION_CONFIG,
  utf8ByteLength,
  type ModalKind,
} from "./actionConfig";
import { GasEstimate } from "./GasEstimate";
import { Spinner } from "./Spinner";
import { TxStatusPanel, type TxState } from "./TxStatusPanel";

const TIER_LABELS: Record<number, string> = {
  0: "TIER_IMMEDIATE",
  1: "TIER_DELAYED",
  2: "TIER_VETO_REQUIRED",
};

interface ModalProps {
  kind: ModalKind;
  execId: bigint;
  record: QueueRecordHeader;
  queueAddress: Address;
  publicClient: PublicClient | null;
  walletClient: WalletClient | null;
  onClose: () => void;
  /**
   * Fired once the tx reaches a terminal state (mined or error). Lets the
   * caller (WriteActions) raise a toast without changing the inline status
   * panel inside the modal.
   */
  onResult?: (result:
    | { kind: "mined"; ok: boolean; hash: `0x${string}` }
    | { kind: "error"; message: string }
  ) => void;
}

export function ActionModal({
  kind,
  execId,
  record,
  queueAddress,
  publicClient,
  walletClient,
  onClose,
  onResult,
}: ModalProps) {
  const cfg = ACTION_CONFIG[kind];
  const [reason, setReason] = useState("");
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrapAndEsc(dialogRef, onClose);

  const reasonBytes = useMemo(() => utf8ByteLength(reason), [reason]);
  const reasonValid = kind !== "veto" || (reason.length > 0 && reasonBytes <= 32);

  const submit = useCallback(async () => {
    if (!publicClient || !walletClient) {
      setTx({ kind: "error", message: "Wallet is not ready." });
      return;
    }
    setTx({ kind: "awaiting-signature" });
    try {
      if (walletClient.chain && walletClient.chain.id !== ACTIVE_CHAIN_ID) {
        throw new Error(
          `Wrong network. Connected to chainId ${walletClient.chain.id}, expected ${ACTIVE_CHAIN_ID} (${getActiveNetwork().name}).`,
        );
      }
      const result =
        kind === "veto"
          ? await vetoIntent({
              walletClient,
              publicClient,
              queueAddress,
              execId,
              reasonText: reason,
            })
          : kind === "dispatch"
            ? await dispatchIntent({
                walletClient,
                publicClient,
                queueAddress,
                execId,
              })
            : await expireIfStaleIntent({
                walletClient,
                publicClient,
                queueAddress,
                execId,
              });
      setTx({ kind: "broadcasting", hash: result.txHash });
      // Transition to "mining" once we hand off to the receipt watcher;
      // visually this is identical, but it keeps the state machine honest
      // (broadcasting = before any node has the tx, mining = node has it).
      setTx({ kind: "mining", hash: result.txHash });
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: result.txHash,
        });
        const ok = receipt.status === "success";
        setTx({
          kind: "mined",
          hash: result.txHash,
          ok,
        });
        onResult?.({ kind: "mined", ok, hash: result.txHash });
      } catch (err) {
        const humanized = humanizeWeb3Error(err);
        setTx({
          kind: "error",
          message: humanized.headline,
          raw: humanized.detail ?? (err instanceof Error ? err.message : String(err)),
        });
        onResult?.({ kind: "error", message: humanized.headline });
      }
    } catch (err) {
      const humanized = humanizeWeb3Error(err);
      setTx({
        kind: "error",
        message: humanized.headline,
        raw: humanized.detail ?? (err instanceof Error ? err.message : String(err)),
      });
      onResult?.({ kind: "error", message: humanized.headline });
    }
  }, [kind, publicClient, walletClient, queueAddress, execId, reason, onResult]);

  const inFlight = tx.kind === "awaiting-signature" || tx.kind === "broadcasting";
  const terminal = tx.kind === "mining" || tx.kind === "mined";
  const submitLabel =
    tx.kind === "awaiting-signature"
      ? "Confirm in wallet…"
      : tx.kind === "broadcasting"
        ? "Broadcasting transaction…"
        : cfg.primaryLabel;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={cfg.title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        ref={dialogRef}
        initial={{ scale: 0.97, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-md rounded-md border border-sentry-border bg-bg p-5 text-sm text-text shadow-2xl"
      >
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">{cfg.title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-text-muted hover:bg-surface-elev hover:text-text active:scale-[0.98] transition-transform"
          >
            <XIcon size={14} weight="bold" aria-hidden="true" />
          </button>
        </header>

        <IntentSummary execId={execId} record={record} />

        {kind === "veto" && (
          <div className="mt-4">
            <label className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wider text-text-subtle">
              <span>Reason</span>
              <span
                className={
                  reasonBytes > 32
                    ? "font-mono tabular-nums text-danger"
                    : "font-mono tabular-nums text-text-subtle"
                }
              >
                {reasonBytes}/32 bytes
              </span>
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. policy revoked"
              className="w-full rounded-md border border-sentry-border bg-surface px-2 py-1.5 font-mono text-xs text-text focus:border-warn focus:outline-none"
              autoFocus
            />
            <p className="mt-1 text-[11px] text-text-subtle">{cfg.helperBody}</p>
          </div>
        )}

        {kind === "expire" && (
          <Alert variant="warn" className="mt-3">
            {cfg.helperBody}
          </Alert>
        )}

        <GasEstimate
          kind={kind}
          execId={execId}
          reason={reason}
          reasonValid={reasonValid}
          publicClient={publicClient}
          walletClient={walletClient}
          queueAddress={queueAddress}
        />

        <TxStatusPanel tx={tx} miningVerb={cfg.miningVerb} />

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={onClose}>
            {terminal ? "Close" : "Cancel"}
          </Button>
          {!terminal && (
            <Button
              variant={cfg.variant}
              size="md"
              onClick={submit}
              disabled={
                inFlight ||
                !walletClient ||
                (kind === "veto" && !reasonValid)
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
          )}
        </div>
      </motion.div>
    </div>
  );
}

function IntentSummary({
  execId,
  record,
}: {
  execId: bigint;
  record: QueueRecordHeader;
}) {
  return (
    <dl className="space-y-1 rounded-md border border-sentry-border bg-surface p-3 text-xs">
      <Row label="Request">
        <span className="font-mono tabular-nums text-text">#{execId.toString()}</span>
      </Row>
      <Row label="Mode">
        <span className="font-mono text-accent">
          {TIER_LABELS[record.tier] ?? `tier(${record.tier})`}
        </span>
      </Row>
      <Row label="Agent">
        <AddressChip address={record.asker} />
      </Row>
      <Row label="Contract">
        <AddressChip address={record.target} />
      </Row>
      <Row label="Function">
        <span className="font-mono text-text">{record.selector}</span>
      </Row>
      <Row label="Value">
        <span className="font-mono tabular-nums text-text">
          {record.value.toString()} wei
        </span>
      </Row>
    </dl>
  );
}
