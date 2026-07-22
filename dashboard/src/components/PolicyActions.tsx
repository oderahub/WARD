import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { Address, Hex } from "viem";
import type { PolicyInput } from "@sentry-somnia/sdk";

import { useWallet } from "../hooks/useWallet";
import { AddressChip, Button } from "./primitives";
import { PauseConfirmModal } from "./policy-edit/PauseConfirmModal";
import { EditPolicyModal } from "./policy-edit/EditPolicyModal";
import { ExtendExpiryModal } from "./policy-edit/ExtendExpiryModal";
import { TransferOwnershipModal } from "./policy-edit/TransferOwnershipModal";
import { CancelTransferModal } from "./policy-edit/CancelTransferModal";
import { AcceptOwnershipModal } from "./policy-edit/AcceptOwnershipModal";

interface Props {
  policyId: Hex;
  policyOwner: Address;
  /** Pending nominee from `pendingPolicyOwner(policyId)`. Zero address → null. */
  pendingOwner: Address | null;
  /** Original PolicyInput body. Sourced from publishedCache when available
   *  and from on-chain calldata recovery when not. Null while still loading
   *  or when both paths failed — actions that build a full `updatePolicy`
   *  call (pause/unpause/edit/extend) stay disabled in that state. */
  cachedInput: PolicyInput | null;
  /** Communicates the drawer's chain-recovery progress so the help text under
   *  the disabled action group can tell the user *why* it's disabled —
   *  "recovering…" (in-flight) vs "recovery failed" (terminal) vs "idle"
   *  (everything-is-fine or wasn't tried). Optional so consumers without a
   *  recovery pipeline can omit it. */
  recoveryState?: "idle" | "recovering" | "failed";
  /** Live chain pause state from `policyHealth(policyId)`. Source of truth
   *  for the Pause/Unpause button LABEL — cachedInput.paused can drift or
   *  be missing entirely, but chain state is always authoritative. */
  chainPaused: boolean | undefined;
  oracleAddress: Address;
  /** Called after any successful action so the drawer can re-fetch chain
   *  state (pendingOwner, health). Modals also bump the event-store snapshot
   *  internally, so this is the explicit drawer-level refresh hook. */
  onActionComplete: () => void;
}

type ModalKind =
  | "pause"
  | "edit"
  | "extend"
  | "transfer"
  | "cancel-transfer"
  | "accept";

function sameAddress(a: Address | undefined | null, b: Address | undefined | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

const NEEDS_BODY_HINT =
  "Requires the original POLICY.md. Run `sentry push` in this browser to populate the cache, or wait for universal recovery to fetch it from the publish tx.";

/**
 * Management panel for the policy drawer. Surfaces every action available to
 * the connected wallet given its relationship to the policy:
 *   - owner: pause/unpause/edit/extend/transfer (+ cancel pending transfer if one is in-flight)
 *   - pending nominee: accept ownership
 *   - other: read-only context
 *
 * Pause/unpause/edit/extend all go through `updatePolicy`, which is a full
 * replace on-chain. They require the original PolicyInput body, which we read
 * from publishedCache (same-browser only in v1). When that's missing those
 * buttons are disabled with help text; transfer/accept/cancel work regardless.
 */
export default function PolicyActions({
  policyId,
  policyOwner,
  pendingOwner,
  cachedInput,
  recoveryState = "idle",
  chainPaused,
  oracleAddress,
  onActionComplete,
}: Props) {
  const { address: connected, isConnected } = useWallet();

  const [modal, setModal] = useState<ModalKind | null>(null);

  const isOwner = isConnected && sameAddress(connected, policyOwner);
  const isPendingNominee =
    isConnected && pendingOwner !== null && sameAddress(connected, pendingOwner);

  // Pause/unpause/edit/extend all rebuild the full PolicyInput, so they all
  // require cachedInput. Transfer doesn't.
  const hasBody = cachedInput !== null;
  // Label/variant come from chain state (always authoritative). The button
  // is still gated on hasBody because the `updatePolicy` call needs the full
  // body — but the label has to tell the truth about what would happen.
  // While chainPaused is loading (undefined) we default to "Pause policy".
  const isPaused = chainPaused === true;
  const pauseStateLoading = chainPaused === undefined;

  const handleSuccess = () => {
    setModal(null);
    onActionComplete();
  };

  return (
    <section className="border-t border-sentry-border pt-3 mt-3 text-xs text-text">
      <div className="mb-2 text-[11px] uppercase tracking-wider text-text-subtle">
        Owner actions
      </div>

      {isOwner && (
        <OwnerPanel
          hasBody={hasBody}
          isPaused={isPaused}
          pauseStateLoading={pauseStateLoading}
          pendingOwner={pendingOwner}
          recoveryState={recoveryState}
          onOpenModal={setModal}
        />
      )}

      {!isOwner && isPendingNominee && (
        <NomineePanel currentOwner={policyOwner} onOpenModal={setModal} />
      )}

      {!isOwner && !isPendingNominee && (
        <ReadOnlyPanel connected={connected} isConnected={isConnected} />
      )}

      <AnimatePresence>
        {modal === "pause" && cachedInput && (
          <PauseConfirmModal
            key="pause"
            policyId={policyId}
            currentInput={cachedInput}
            oracleAddress={oracleAddress}
            onClose={() => setModal(null)}
            onSuccess={handleSuccess}
          />
        )}
        {modal === "edit" && cachedInput && (
          <EditPolicyModal
            key="edit"
            policyId={policyId}
            currentInput={cachedInput}
            oracleAddress={oracleAddress}
            onClose={() => setModal(null)}
            onSuccess={handleSuccess}
          />
        )}
        {modal === "extend" && cachedInput && (
          <ExtendExpiryModal
            key="extend"
            policyId={policyId}
            currentInput={cachedInput}
            oracleAddress={oracleAddress}
            onClose={() => setModal(null)}
            onSuccess={handleSuccess}
          />
        )}
        {modal === "transfer" && (
          <TransferOwnershipModal
            key="transfer"
            policyId={policyId}
            oracleAddress={oracleAddress}
            onClose={() => setModal(null)}
            onSuccess={handleSuccess}
          />
        )}
        {modal === "cancel-transfer" && pendingOwner && (
          <CancelTransferModal
            key="cancel-transfer"
            policyId={policyId}
            pendingOwner={pendingOwner}
            oracleAddress={oracleAddress}
            onClose={() => setModal(null)}
            onSuccess={handleSuccess}
          />
        )}
        {modal === "accept" && (
          <AcceptOwnershipModal
            key="accept"
            policyId={policyId}
            currentOwner={policyOwner}
            oracleAddress={oracleAddress}
            onClose={() => setModal(null)}
            onSuccess={handleSuccess}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

function OwnerPanel({
  hasBody,
  isPaused,
  pauseStateLoading,
  pendingOwner,
  recoveryState,
  onOpenModal,
}: {
  hasBody: boolean;
  isPaused: boolean;
  pauseStateLoading: boolean;
  pendingOwner: Address | null;
  recoveryState: "idle" | "recovering" | "failed";
  onOpenModal: (k: ModalKind) => void;
}) {
  // Pause/Edit/Extend all rebuild the full PolicyInput → require cachedInput.
  // The disabled-state tooltip + the panel-level help text are scoped to this
  // group only. Transfer (below) is always enabled and doesn't show the help.
  const bodyHint = hasBody ? undefined : NEEDS_BODY_HINT;
  const pauseTitle = pauseStateLoading
    ? "Loading chain state…"
    : bodyHint;
  // Help text only renders while the body is missing. The recovery pipeline
  // narrows the message:
  //   - `recovering` → tell the user we're trying to rebuild it from chain.
  //   - `failed`     → tell them the chain probe didn't find a publish/update
  //                    tx and offer the `sentry push` escape hatch.
  //   - `idle`       → cache-miss with no recovery in flight (e.g. parent
  //                    doesn't run recovery yet). Fall back to the original
  //                    "needs POLICY.md" copy so we don't pretend recovery
  //                    is happening when it isn't.
  let bodyHelpText: string | null = null;
  if (!hasBody) {
    if (recoveryState === "recovering") {
      bodyHelpText = "Recovering policy from chain…";
    } else if (recoveryState === "failed") {
      bodyHelpText =
        "Could not recover policy from chain. Try again later or run `sentry push` in this browser. Transfer ownership still works.";
    } else {
      bodyHelpText =
        "Pause / Edit / Extend need the policy body. Run `sentry push` in this browser to populate the cache. Transfer ownership works without it.";
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant={isPaused ? "success" : "warn"}
          size="sm"
          disabled={!hasBody || pauseStateLoading}
          title={pauseTitle}
          onClick={() => onOpenModal("pause")}
        >
          {isPaused ? "Unpause policy" : "Pause policy"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasBody}
          title={bodyHint}
          onClick={() => onOpenModal("edit")}
        >
          Edit policy
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasBody}
          title={bodyHint}
          onClick={() => onOpenModal("extend")}
        >
          Extend expiry
        </Button>
      </div>

      {bodyHelpText && (
        <p className="text-[11px] text-text-subtle">{bodyHelpText}</p>
      )}

      <div className="flex flex-wrap gap-2 border-t border-sentry-border pt-2">
        <Button variant="ghost" size="sm" onClick={() => onOpenModal("transfer")}>
          Transfer ownership
        </Button>
      </div>

      {pendingOwner && (
        <div className="rounded-md border border-sentry-border bg-surface p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-[11px] text-text-subtle">
              <span className="uppercase tracking-wider">Pending transfer →</span>
              <AddressChip address={pendingOwner} />
            </span>
            <Button
              variant="danger"
              size="xs"
              onClick={() => onOpenModal("cancel-transfer")}
            >
              Cancel pending transfer
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NomineePanel({
  currentOwner,
  onOpenModal,
}: {
  currentOwner: Address;
  onOpenModal: (k: ModalKind) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-text">
        You've been nominated as the new owner. Click Accept to take ownership.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="success" size="sm" onClick={() => onOpenModal("accept")}>
          Accept ownership
        </Button>
        <span className="inline-flex items-center gap-2 text-[11px] text-text-subtle">
          <span>current owner:</span>
          <AddressChip address={currentOwner} />
        </span>
      </div>
    </div>
  );
}

function ReadOnlyPanel({
  connected,
  isConnected,
}: {
  connected: Address | undefined;
  isConnected: boolean;
}) {
  if (!isConnected || !connected) {
    return (
      <p className="text-[11px] text-text-subtle">
        Connect a wallet to see owner actions.
      </p>
    );
  }
  const shortConnected = `${connected.slice(0, 6)}…${connected.slice(-4)}`;
  return (
    <p className="text-[11px] text-text-subtle">
      Connected as <span className="font-mono">{shortConnected}</span> (not the
      policy owner). Read-only view.
    </p>
  );
}
