import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, type Address, type Hex } from "viem";
import {
  SENTRY_ORACLE_ABI,
  buildQueueHandoffRecommendation,
  type QueueRecordHeader,
  type QueueState,
} from "@sentry-somnia/sdk";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useEventStore } from "../hooks/useEventStore";
import { useUrlState } from "../hooks/useUrlState";
import { somniaTestnet } from "../main";
import { DrawerHeader } from "./primitives/DrawerHeader";
import { Row, AddressChip, SkeletonLines } from "./primitives";
import WriteActions from "./WriteActions";

interface Props {
  execId: bigint;
  onClose?: () => void;
}

const TIER_LABELS: Record<number, string> = {
  0: "TIER_IMMEDIATE",
  1: "TIER_DELAYED",
  2: "TIER_VETO_REQUIRED",
};

const STATE_CHIP: Record<QueueState, string> = {
  None: "text-text-muted",
  Pending: "text-warn",
  Committed: "text-success",
  Vetoed: "text-danger",
  Expired: "text-text-muted",
};

function formatUnixSeconds(s: bigint): string {
  const ms = Number(s) * 1000;
  if (!Number.isFinite(ms)) return s.toString();
  try {
    return new Date(ms).toISOString().replace("T", " ").replace(".000Z", "Z");
  } catch {
    return s.toString();
  }
}

function diffToText(deltaSec: number): string {
  const abs = Math.abs(deltaSec);
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function Countdown({ targetSec, label }: { targetSec: bigint; label: string }) {
  const target = Number(targetSec);
  const now = useNow(true);
  const delta = target - now;
  const reached = delta <= 0;
  const color = reached ? "text-success" : "text-warn";
  const verb = reached ? `${label} reached` : label;
  return (
    <span className={`font-mono tabular-nums text-xs ${color}`}>
      {verb} ({reached ? "+" : "-"}
      {diffToText(delta)})
    </span>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; record: QueueRecordHeader }
  | { kind: "missing"; message: string }
  | { kind: "error"; message: string };

export default function ExecDrawer({ execId, onClose }: Props) {
  const { store, snapshotKey } = useEventStore();
  const { setDrawer, rpc, oracle, queue } = useUrlState();

  const [fallback, setFallback] = useState<LoadState>({ kind: "loading" });
  const [retryTick, setRetryTick] = useState(0);

  // Prefer the cached record; fall back to a direct RPC read for jump-to-id.
  const cached = store?.getQueueRecord(execId);

  useEffect(() => {
    if (!store || cached) return;
    let cancelled = false;
    setFallback({ kind: "loading" });
    store.queueClient
      .getRecordHeader(execId)
      .then((header) => {
        if (cancelled) return;
        if (header.state === "None") {
          setFallback({
            kind: "missing",
            message: "No request with that id exists on chain.",
          });
          return;
        }
        setFallback({ kind: "ready", record: header });
      })
      .catch((err) => {
        if (cancelled) return;
        setFallback({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
    // snapshotKey: if the store later learns about this execId via a live event,
    // `cached` becomes defined on the next render and we short-circuit above.
  }, [store, execId, snapshotKey, cached, retryTick]);

  const close = useCallback(() => {
    if (onClose) onClose();
    else setDrawer(null);
  }, [onClose, setDrawer]);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be denied; silently swallow — surfacing here would be noise.
    }
  }, []);

  const openPolicy = useCallback(
    (policyId: Hex) => setDrawer({ kind: "policy", policyId }),
    [setDrawer],
  );

  const record: QueueRecordHeader | undefined =
    cached ?? (fallback.kind === "ready" ? fallback.record : undefined);

  return (
    <Sheet open onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent
        side="right"
        aria-label={`Execution #${execId.toString()}`}
        className="flex h-full flex-col p-0 [&>button.absolute]:hidden"
      >
        <SheetTitle className="sr-only">{`Execution #${execId.toString()}`}</SheetTitle>
      <DrawerHeader
        eyebrow="REQUEST"
        title={<span className="font-mono tabular-nums">#{execId.toString()}</span>}
        onClose={close}
      />

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {!record && fallback.kind === "loading" && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="shimmer w-16 h-4" />
              <div className="shimmer w-16 h-4" />
            </div>
            <SkeletonLines count={6} />
          </div>
        )}
        {!record && fallback.kind === "missing" && (
          <div role="alert" className="border-l-2 border-danger pl-3">
            <div className="text-sm text-danger">{fallback.message}</div>
          </div>
        )}
        {!record && fallback.kind === "error" && (
          <div role="alert" className="border-l-2 border-danger pl-3">
            <div className="text-sm text-text">Could not load execution record.</div>
            <div className="mt-1 font-mono text-xs text-text-muted">{fallback.message}</div>
            <button
              type="button"
              onClick={() => setRetryTick((n) => n + 1)}
              className="mt-2 text-xs text-accent hover:underline"
            >
              retry
            </button>
          </div>
        )}
        {record && (
          <RecordBody
            execId={execId}
            record={record}
            rpc={rpc}
            oracleAddress={oracle}
            queueAddress={queue}
            onCopy={copy}
            onOpenPolicy={openPolicy}
          />
        )}
      </div>

      {record && (
        <div className="border-t border-rule bg-surface px-6 py-4">
          <WriteActions execId={execId} record={record} />
        </div>
      )}
      </SheetContent>
    </Sheet>
  );
}

interface BodyProps {
  execId: bigint;
  record: QueueRecordHeader;
  rpc: string;
  oracleAddress: Address;
  queueAddress: Address;
  onCopy: (text: string) => void;
  onOpenPolicy: (policyId: Hex) => void;
}

function RecordBody({ execId, record, rpc, oracleAddress, queueAddress, onCopy, onOpenPolicy }: BodyProps) {
  const tierLabel = TIER_LABELS[record.tier] ?? `tier(${record.tier})`;
  const stateChip = STATE_CHIP[record.state] ?? STATE_CHIP.None;
  const isActive = record.state === "Pending";

  return (
    <div className="text-sm">
      <div className="flex items-baseline gap-4">
        <span className={`font-mono text-[10px] uppercase tracking-[0.14em] ${stateChip}`}>
          {record.state}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent">
          {tierLabel}
        </span>
      </div>

      <div className="my-4 border-t border-rule" />

      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">identity</div>
        <Row label="Policy">
          <button
            type="button"
            onClick={() => onOpenPolicy(record.policyId)}
            className="break-all text-left font-mono tabular-nums text-xs text-accent hover:underline active:scale-[0.98] transition-transform"
            title="Open policy drawer"
          >
            {record.policyId}
          </button>
        </Row>

        <Row label="Requester">
          <AddressChip address={record.asker} />
        </Row>
      </div>

      <div className="my-4 border-t border-rule" />

      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">call</div>
        <Row label="Contract">
          <AddressChip address={record.target} />
        </Row>

        <Row label="Function">
          <span className="font-mono tabular-nums text-xs text-text">{record.selector}</span>
        </Row>

        <Row label="Value (wei)">
          <span className="font-mono tabular-nums text-xs text-text">{record.value.toString()}</span>
        </Row>

        <Row label="Request #">
          <span className="font-mono tabular-nums text-xs text-text">{record.requestId.toString()}</span>
        </Row>
      </div>

      <div className="my-4 border-t border-rule" />

      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">timing</div>
        <Row label="Enqueued at">
          <span className="font-mono tabular-nums text-xs text-text">
            {formatUnixSeconds(record.enqueuedAt)}
          </span>
        </Row>

        <Row label="Executable after">
          <div className="space-y-0.5">
            <div className="font-mono tabular-nums text-xs text-text">
              {formatUnixSeconds(record.earliestCommitAt)}
            </div>
            {isActive && (
              <Countdown targetSec={record.earliestCommitAt} label="commits in" />
            )}
          </div>
        </Row>

        <Row label="Deadline">
          <div className="space-y-0.5">
            <div className="font-mono tabular-nums text-xs text-text">
              {formatUnixSeconds(record.deadline)}
            </div>
            {isActive && <Countdown targetSec={record.deadline} label="expires in" />}
          </div>
        </Row>
      </div>

      <QueueHandoffPanel
        execId={execId}
        record={record}
        rpc={rpc}
        oracleAddress={oracleAddress}
        queueAddress={queueAddress}
        onCopy={onCopy}
      />

      <div className="flex flex-wrap gap-x-5 gap-y-1 pt-4 mt-4 border-t border-rule">
        <CopyButton label="Copy request id" onClick={() => onCopy(execId.toString())} />
        <CopyButton label="Copy policy id" onClick={() => onCopy(record.policyId)} />
      </div>
    </div>
  );
}

function QueueHandoffPanel({
  execId,
  record,
  rpc,
  oracleAddress,
  queueAddress,
  onCopy,
}: {
  execId: bigint;
  record: QueueRecordHeader;
  rpc: string;
  oracleAddress: Address;
  queueAddress: Address;
  onCopy: (text: string) => void;
}) {
  const [policyOwner, setPolicyOwner] = useState<Address | undefined>();
  const [ownerError, setOwnerError] = useState<string | null>(null);

  useEffect(() => {
    if (record.tier !== 2) {
      setPolicyOwner(undefined);
      setOwnerError(null);
      return;
    }
    let cancelled = false;
    setPolicyOwner(undefined);
    setOwnerError(null);
    const client = createPublicClient({
      chain: somniaTestnet,
      transport: http(rpc),
    });
    client
      .readContract({
        address: oracleAddress,
        abi: SENTRY_ORACLE_ABI,
        functionName: "policyOwner",
        args: [record.policyId],
      })
      .then((owner) => {
        if (!cancelled) setPolicyOwner(owner as Address);
      })
      .catch((err) => {
        if (!cancelled) setOwnerError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [record.policyId, record.tier, oracleAddress, rpc]);

  const loadingOwner = record.tier === 2 && !policyOwner && !ownerError;
  const recommendation = buildQueueHandoffRecommendation({
    execId,
    queueAddress,
    tier: record.tier,
    asker: record.asker,
    target: record.target,
    policyOwner,
  });

  return (
    <div className="mt-4 border-t border-rule pt-4">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">handoff</div>
      <div className="space-y-2 text-xs">
        {recommendation.warning && (
          <div className="border-l-2 border-warn pl-3 text-warn">{recommendation.warning}</div>
        )}
        <div className="font-medium text-text">{recommendation.summary}</div>
        <div className="text-text-muted">{recommendation.detail}</div>
        {loadingOwner && <div className="font-mono text-[11px] text-text-muted">Loading policy owner...</div>}
        {ownerError && (
          <div className="break-words font-mono text-[11px] text-danger">
            policy owner read failed: {ownerError}
          </div>
        )}
        {policyOwner && (
          <Row label="Owner">
            <AddressChip address={policyOwner} />
          </Row>
        )}
        {recommendation.command && (
          <div className="rounded border border-rule bg-bg px-3 py-2">
            <div className="break-all font-mono text-[11px] leading-5 text-text">{recommendation.command}</div>
            <button
              type="button"
              onClick={() => onCopy(recommendation.command!)}
              className="mt-2 text-xs text-accent hover:underline"
            >
              copy command
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function CopyButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-accent hover:underline"
    >
      {label}
    </button>
  );
}
