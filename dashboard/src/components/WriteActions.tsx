import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  ClockCounterClockwise,
  Play,
  Prohibit,
  X as XIcon,
} from "@phosphor-icons/react";
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import {
  SENTRY_ORACLE_ABI,
  TIER_DELAYED,
  TIER_VETO_REQUIRED,
  type QueueRecordHeader,
} from "@sentry-somnia/sdk";

import { useEventStore } from "../hooks/useEventStore";
import { useUrlState } from "../hooks/useUrlState";
import { useWallet } from "../hooks/useWallet";
import { Button } from "./primitives";
import { ActionModal } from "./write/ActionModal";
import { type ModalKind } from "./write/actionConfig";

interface Props {
  execId: bigint;
  record: QueueRecordHeader;
}

function sameAddress(a: Address | undefined, b: Address | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Polls `Date.now()` every second when `active` so the dispatch/expire
 * buttons flip the moment a deadline crosses. ExecDrawer already runs its
 * own clock for countdowns — keeping a second one here avoids cross-component
 * coupling and the cost is one setInterval per open drawer.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Async owner lookup with cache. We try the event-store first (free) and
 * fall back to a direct `policyOwner` read for policies whose publish event
 * happened before our backfill window. The fallback is shared via React state
 * so multiple buttons don't double-fetch.
 */
function usePolicyOwner(policyId: Hex): Address | undefined {
  const { store, snapshotKey } = useEventStore();
  const { oracle: oracleAddress } = useUrlState();
  const publicClient = usePublicClient();

  const cached = store?.getPolicy(policyId)?.owner;
  const [fallback, setFallback] = useState<Address | undefined>(undefined);

  useEffect(() => {
    if (cached || !publicClient) {
      setFallback(undefined);
      return;
    }
    let cancelled = false;
    publicClient
      .readContract({
        address: oracleAddress,
        abi: SENTRY_ORACLE_ABI,
        functionName: "policyOwner",
        args: [policyId],
      })
      .then((owner) => {
        if (cancelled) return;
        const o = owner as Address;
        if (o && o !== "0x0000000000000000000000000000000000000000") {
          setFallback(o);
        }
      })
      .catch(() => {
        // Owner stays undefined; the gating logic will hide owner-only buttons.
      });
    return () => {
      cancelled = true;
    };
    // snapshotKey: if the store later learns the policy via a live event,
    // `cached` becomes defined and the next render short-circuits above.
  }, [cached, publicClient, oracleAddress, policyId, snapshotKey]);

  return cached ?? fallback;
}

export default function WriteActions({ execId, record }: Props) {
  const { address: connected, isConnected, connect } = useWallet();
  const { queue: queueAddress } = useUrlState();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const owner = usePolicyOwner(record.policyId);
  const now = useNow(record.state === "Pending");

  const isPending = record.state === "Pending";
  const isOwner = sameAddress(connected, owner);
  const isAsker = sameAddress(connected, record.asker);
  const earliestReached = BigInt(now) >= record.earliestCommitAt;
  const withinDeadline = BigInt(now) <= record.deadline;
  const pastDeadline = BigInt(now) > record.deadline;

  const canVeto = isConnected && isPending && isOwner;
  const canDispatchVetoRequired =
    isConnected &&
    isPending &&
    isOwner &&
    record.tier === TIER_VETO_REQUIRED &&
    earliestReached &&
    withinDeadline;
  const canDispatchDelayed =
    isConnected &&
    isPending &&
    isAsker &&
    record.tier === TIER_DELAYED &&
    earliestReached &&
    withinDeadline;
  const canExpire = isConnected && isPending && pastDeadline;

  const anyActionVisible =
    canVeto || canDispatchVetoRequired || canDispatchDelayed || canExpire;

  const [modal, setModal] = useState<ModalKind | null>(null);

  if (!isPending) {
    return (
      <div className="text-xs text-text-subtle">
        Terminal state — no actions available.
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-subtle">
          Connect a wallet to approve, reject, or expire this request.
        </span>
        <Button variant="ghost" size="sm" onClick={connect}>
          Connect
        </Button>
      </div>
    );
  }

  if (!anyActionVisible) {
    // Connected wallet has no write rights right now. Surface every reason as
    // a checklist line so operators can see exactly which gate is closed.
    const reasons: string[] = [];
    if (!isOwner && !isAsker) {
      reasons.push("Only the policy owner or the requester can act on this.");
    }
    if ((isOwner || isAsker) && !earliestReached) {
      reasons.push("The mandatory delay window hasn't elapsed yet.");
    }
    return (
      <div className="space-y-1 text-xs text-text-subtle">
        <div>Connected wallet has no actions on this entry.</div>
        {reasons.map((line) => (
          <div key={line} className="flex items-start gap-1.5">
            <XIcon
              size={12}
              weight="bold"
              className="mt-0.5 flex-none text-text-muted"
              aria-hidden="true"
            />
            <span>{line}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {canVeto && (
        <Button
          variant="danger"
          size="sm"
          onClick={() => setModal("veto")}
          title="Reject this request. Only the policy owner can do this"
          className="inline-flex items-center gap-1.5"
        >
          <Prohibit size={12} weight="regular" aria-hidden />
          Reject…
        </Button>
      )}
      {(canDispatchVetoRequired || canDispatchDelayed) && (
        <Button
          variant="success"
          size="sm"
          onClick={() => setModal("dispatch")}
          title={
            canDispatchVetoRequired
              ? "Approve and execute this request (you are the policy owner)"
              : "Execute this request (delay window has passed)"
          }
          className="inline-flex items-center gap-1.5"
        >
          <Play size={12} weight="regular" aria-hidden />
          Execute…
        </Button>
      )}
      {canExpire && (
        <Button
          variant="warn"
          size="sm"
          onClick={() => setModal("expire")}
          title="Clear an expired request. Anyone can do this after the deadline"
          className="inline-flex items-center gap-1.5"
        >
          <ClockCounterClockwise size={12} weight="regular" aria-hidden />
          Clear…
        </Button>
      )}

      <AnimatePresence>
        {modal && (
          <ActionModal
            key={modal}
            kind={modal}
            execId={execId}
            record={record}
            queueAddress={queueAddress}
            publicClient={(publicClient ?? null) as PublicClient | null}
            walletClient={(walletClient ?? null) as WalletClient | null}
            onClose={() => setModal(null)}
            onResult={(result) => {
              const verb =
                modal === "veto" ? "Reject" : modal === "dispatch" ? "Execute" : "Clear";
              if (result.kind === "mined" && result.ok) {
                toast.success(`${verb} succeeded. exec #${execId.toString()}`);
              } else if (result.kind === "mined") {
                toast.error(`${verb} reverted. exec #${execId.toString()}`);
              } else {
                toast.error(`${verb} failed. ${result.message}`);
              }
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
