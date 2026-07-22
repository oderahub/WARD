import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import type { QueueRecordHeader } from "@ward/sdk";

import { useEventStore } from "../hooks/useEventStore";
import { useUrlState } from "../hooks/useUrlState";
import { useWallet } from "../hooks/useWallet";
import { ACTIVE_CHAIN_ID, getNetwork } from "../lib/networks";
import { AddressChip, SkeletonLines } from "./primitives";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * QueueTab — Lane B "Document Grade" Queue page.
 *
 *   Front matter: QUEUE · v0.10.0 + page title + dl meta
 *   Pending requests — hairline-separated row list
 *   Recent events — link-style toolbar (type + mine-only toggles)
 *   Loading state — single muted line, only while backfilling
 *
 * Watched-mode violations remain on the separate WatchedPage. The "mine only"
 * toggle replaces the old Inbox tab when the connected wallet owns ≥1 policy.
 *
 * Behavior (polling, filter logic, fresh-row pulse, drawer navigation, keyboard
 * shortcuts) is intentionally unchanged from the prior version — only chrome,
 * typography, and section structure were restyled per Lane B.
 */

const DASHBOARD_VERSION = "v0.10.0";

const ALL_EVENT_TYPES = [
  "Enqueued",
  "Dispatched",
  "Vetoed",
  "Expired",
  "PolicyPublished",
  "PolicyUpdated",
  // "Ownership" is a synthetic toggle that matches all three on-chain
  // ownership-lifecycle events. We surface them together because users think
  // of "the transfer flow" as one thing, not three separate events.
  "Ownership",
] as const;
type EventTypeFilter = (typeof ALL_EVENT_TYPES)[number];

const TIER_DELAYED = 1;
const TIER_VETO_REQUIRED = 2;

function truncateAddr(addr: string | undefined): string {
  if (!addr) return "—";
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function truncateHex(hex: string | undefined, head = 10, tail = 6): string {
  if (!hex) return "—";
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function tierLabel(tier: number): string {
  if (tier === TIER_VETO_REQUIRED) return "VETO_REQUIRED";
  if (tier === TIER_DELAYED) return "DELAYED";
  return `tier:${tier}`;
}

function tierTone(tier: number): string {
  if (tier === TIER_VETO_REQUIRED) return "text-warn";
  if (tier === TIER_DELAYED) return "text-accent";
  return "text-text-muted";
}

function formatCountdown(deadline: bigint, nowSec: bigint): string {
  const remaining = deadline - nowSec;
  if (remaining <= 0n) return "expired";
  const r = Number(remaining);
  if (r < 60) return `${r}s`;
  if (r < 3600) return `${Math.floor(r / 60)}m`;
  if (r < 86400) return `${Math.floor(r / 3600)}h`;
  return `${Math.floor(r / 86400)}d`;
}

/**
 * Format SDK backfill progress with the ABSOLUTE block range, not a relative
 * counter. The progress.current/total fields are blocks-scanned-since-the-
 * start-of-this-phase, NOT block numbers — without context this reads as
 * "starts at 0". Showing fromBlock → headBlock removes the ambiguity.
 */
function formatBackfillProgress(p: {
  current: bigint;
  total: bigint;
  phase: string;
  fromBlock?: bigint;
  headBlock?: bigint;
}): string {
  if (p.total === 0n) {
    return p.phase === "policy-events" ? "connecting…" : `${p.phase}…`;
  }
  const pct = Number((p.current * 100n) / p.total);
  const compact = (n: bigint): string => {
    const x = Number(n);
    if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(2)}M`;
    if (x >= 1_000) return `${(x / 1_000).toFixed(0)}K`;
    return x.toString();
  };
  if (p.fromBlock !== undefined && p.headBlock !== undefined) {
    const currentBlock = p.fromBlock + p.current;
    return `${pct}% · block ${compact(currentBlock)} of ${compact(p.fromBlock)} → ${compact(p.headBlock)}`;
  }
  return `${pct}% (${compact(p.current)} / ${compact(p.total)} blocks)`;
}

function countdownClass(deadline: bigint, nowSec: bigint): string {
  const remaining = deadline - nowSec;
  if (remaining <= 0n) return "text-text-subtle";
  if (remaining < 600n) return "text-warn";
  return "text-text";
}

type StoreEvent = ReturnType<
  NonNullable<ReturnType<typeof useEventStore>["store"]>["recentEvents"]
>[number];
type EventType = StoreEvent["type"];

const OWNERSHIP_EVENT_TYPES = new Set<EventType>([
  "OwnershipTransferStarted",
  "OwnershipTransferred",
  "OwnershipTransferCancelled",
]);

const TYPE_COLOR: Record<EventType, string> = {
  Enqueued: "text-accent",
  Dispatched: "text-success",
  Vetoed: "text-warn",
  Expired: "text-text-muted",
  PolicyPublished: "text-text",
  PolicyUpdated: "text-text",
  OwnershipTransferStarted: "text-text",
  OwnershipTransferred: "text-text",
  OwnershipTransferCancelled: "text-text-muted",
};

function eventKeyArg(e: StoreEvent): string {
  switch (e.type) {
    case "Enqueued":
      return `asker ${truncateAddr(e.asker)}`;
    case "Dispatched":
      return `by ${truncateAddr(e.dispatcher)}`;
    case "Vetoed":
      return `reason ${truncateHex(e.reason, 10, 4)}`;
    case "Expired":
      return "—";
    case "PolicyPublished":
      return `owner ${truncateAddr(e.owner)}`;
    case "PolicyUpdated":
      return `owner ${truncateAddr(e.owner)}`;
    default:
      return "";
  }
}

interface PendingRowProps {
  record: QueueRecordHeader;
  execId: bigint;
  nowSec: bigint;
  onOpen: (execId: bigint) => void;
  isFresh?: boolean;
}

function PendingRow({ record, execId, nowSec, onOpen, isFresh }: PendingRowProps) {
  const countdownLabel = formatCountdown(record.deadline, nowSec);
  return (
    <TableRow
      onClick={() => onOpen(execId)}
      tabIndex={0}
      role="button"
      aria-label={`Open exec #${execId}, target ${record.target}, expires in ${countdownLabel}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(execId);
        }
      }}
      className={`cursor-pointer hover:text-accent focus-visible:outline-none focus-visible:underline ${isFresh ? "row-pulse" : ""}`}
    >
      <TableCell className="font-mono tabular-nums text-text text-xs">
        #{execId.toString()}
      </TableCell>
      <TableCell className={`font-mono text-[10px] uppercase tracking-[0.12em] ${tierTone(record.tier)}`}>
        {tierLabel(record.tier)}
      </TableCell>
      <TableCell>
        <AddressChip address={record.asker} />
      </TableCell>
      <TableCell>
        <AddressChip address={record.target} />
      </TableCell>
      <TableCell className="font-mono text-xs text-text-muted" title={record.selector}>
        {record.selector}
      </TableCell>
      <TableCell className={`text-right font-mono tabular-nums text-xs ${countdownClass(record.deadline, nowSec)}`}>
        expires in {countdownLabel}
      </TableCell>
    </TableRow>
  );
}

export default function QueueTab() {
  const { store, ready, progress, snapshotKey } = useEventStore();
  const { setDrawer } = useUrlState();
  const { address, isConnected } = useWallet();

  // Drive countdown re-renders once per second.
  const [nowSec, setNowSec] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const id = setInterval(() => {
      setNowSec(BigInt(Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Event-type filter. `null` = All.
  const [typeFilter, setTypeFilter] = useState<EventTypeFilter | null>(null);
  // "Mine only" toggle — only meaningful when the wallet owns ≥1 policy.
  const [mineOnly, setMineOnly] = useState(false);

  const ownedPolicyIds = useMemo<Set<Hex>>(() => {
    if (!store || !isConnected || !address) return new Set();
    const wallet = address.toLowerCase() as Address;
    const owned = new Set<Hex>();
    for (const p of store.listPolicies()) {
      if ((p.owner as string).toLowerCase() === wallet) owned.add(p.policyId);
    }
    return owned;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, address, isConnected, snapshotKey]);

  const canFilterMine = ownedPolicyIds.size > 0;
  useEffect(() => {
    if (!canFilterMine && mineOnly) setMineOnly(false);
  }, [canFilterMine, mineOnly]);

  const pending = useMemo<Array<{ execId: bigint; record: QueueRecordHeader }>>(() => {
    if (!store) return [];

    const pendingHeaders = store.listPending();
    if (pendingHeaders.length === 0) return [];

    const execIdByHeader = new Map<QueueRecordHeader, bigint>();
    for (const ev of store.recentEvents(2000)) {
      if ("execId" in ev) {
        const rec = store.getQueueRecord(ev.execId);
        if (rec && !execIdByHeader.has(rec)) {
          execIdByHeader.set(rec, ev.execId);
        }
      }
    }

    const rows: Array<{ execId: bigint; record: QueueRecordHeader }> = [];
    for (const h of pendingHeaders) {
      const execId = execIdByHeader.get(h);
      if (execId === undefined) continue;
      if (mineOnly && !ownedPolicyIds.has(h.policyId)) continue;
      rows.push({ execId, record: h });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, mineOnly, ownedPolicyIds, snapshotKey]);

  const filteredEvents = useMemo(() => {
    if (!store) return [];
    const events = store.recentEvents(100);
    const filtered = events.filter((e) => {
      if (typeFilter === "Ownership") {
        if (!OWNERSHIP_EVENT_TYPES.has(e.type)) return false;
      } else if (typeFilter && e.type !== typeFilter) {
        return false;
      }
      if (mineOnly) {
        if (!("policyId" in e) || !ownedPolicyIds.has(e.policyId)) return false;
      }
      return true;
    });
    return [...filtered].reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, typeFilter, mineOnly, ownedPolicyIds, snapshotKey]);

  const openExec = (execId: bigint) => setDrawer({ kind: "exec", execId });
  const openPolicy = (policyId: Hex) => setDrawer({ kind: "policy", policyId });

  const backfilling =
    !ready && progress && (progress.phase === "policy-events" || progress.phase === "queue-events");

  // Head block for the front-matter line — tracks live cursor like StatusBar.
  const [head, setHead] = useState<string>("—");
  useEffect(() => {
    if (!store) {
      setHead("—");
      return;
    }
    try {
      setHead(store.cursor().toString());
    } catch {
      setHead("—");
    }
  }, [store, snapshotKey]);

  /*
   * Fresh-row detection. We pulse rows that appeared since the user's last
   * view (DESIGN.md "Motion": state cue, never decoration). The ref starts
   * null and is populated on first effect tick; the first render therefore
   * marks nothing fresh, which avoids a wave of pulses on initial load.
   */
  const seenKeysRef = useRef<Set<string> | null>(null);
  const isFirstRender = seenKeysRef.current === null;

  const allKeys = useMemo(() => {
    const ks = new Set<string>();
    for (const p of pending) ks.add(`pending:${p.execId.toString()}`);
    for (const e of filteredEvents) ks.add(`event:${e.blockNumber.toString()}:${e.logIndex}`);
    return ks;
  }, [pending, filteredEvents]);

  const freshKeys = useMemo<Set<string>>(() => {
    if (isFirstRender) return new Set();
    const seen = seenKeysRef.current!;
    const fresh = new Set<string>();
    for (const k of allKeys) if (!seen.has(k)) fresh.add(k);
    return fresh;
  }, [allKeys, isFirstRender]);

  useEffect(() => {
    if (seenKeysRef.current === null) seenKeysRef.current = new Set();
    for (const k of allKeys) seenKeysRef.current.add(k);
  }, [allKeys]);

  return (
    <TooltipProvider delayDuration={150}>
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg text-text">
      <DocumentFrontMatter head={head} pendingCount={pending.length} />

      {backfilling && (
        <>
          <SectionDivider />
          <Section number="" title="Indexing">
            <p className="text-sm text-text-muted">
              Loading the last 7 days of events · {formatBackfillProgress(progress!)}
            </p>
          </Section>
        </>
      )}

      <SectionDivider />
      <Section number="" title="Pending requests">
        {pending.length === 0 ? (
          backfilling ? (
            <div className="py-2">
              <SkeletonLines count={3} />
            </div>
          ) : (
            <p className="text-sm text-text-muted">
              Nothing waiting. Agents using{" "}
              <span className="font-mono text-text">TIER_IMMEDIATE</span> dispatch
              atomically and never appear here.
            </p>
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Request</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Contract</TableHead>
                <TableHead>Function</TableHead>
                <TableHead className="text-right">Deadline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.map(({ execId, record }) => (
                <PendingRow
                  key={execId.toString()}
                  execId={execId}
                  record={record}
                  nowSec={nowSec}
                  onOpen={openExec}
                  isFresh={freshKeys.has(`pending:${execId.toString()}`)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <SectionDivider />
      <Section number="" title="Recent events">
        <RecentEventsToolbar
          typeFilter={typeFilter}
          setTypeFilter={setTypeFilter}
          mineOnly={mineOnly}
          setMineOnly={setMineOnly}
          canFilterMine={canFilterMine}
          ownedCount={ownedPolicyIds.size}
        />

        {filteredEvents.length === 0 ? (
          <p className="mt-4 text-sm text-text-muted">
            {backfilling ? (
              <>Loading the last 7 days of events · {formatBackfillProgress(progress!)}</>
            ) : typeFilter || mineOnly ? (
              <>
                No events match the current filter.{" "}
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => {
                    setTypeFilter(null);
                    setMineOnly(false);
                  }}
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                No oracle events yet. Events appear as policies are published,
                intents enqueued, and dispatches confirmed on-chain.
              </>
            )}
          </p>
        ) : (
          <ol className="mt-4">
            {filteredEvents.map((e, i) => (
              <EventRow
                key={`${e.blockNumber.toString()}-${e.logIndex}-${i}`}
                event={e}
                onOpenExec={openExec}
                onOpenPolicy={openPolicy}
                isFresh={freshKeys.has(`event:${e.blockNumber.toString()}:${e.logIndex}`)}
              />
            ))}
          </ol>
        )}
      </Section>
    </div>
    </TooltipProvider>
  );
}

/** Hairline rule between document sections. */
function SectionDivider() {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-10 md:px-16">
      <Separator className="mt-2" />
    </div>
  );
}

interface FrontMatterProps {
  head: string;
  pendingCount: number;
}

function DocumentFrontMatter({ head, pendingCount }: FrontMatterProps) {
  const net = getNetwork(ACTIVE_CHAIN_ID);
  return (
    <section className="mx-auto w-full max-w-[1100px] px-10 pt-10 pb-8 md:px-16">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
        Queue · Document {DASHBOARD_VERSION}
      </div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text md:text-4xl">
        Pending policy actions
      </h1>

      <dl className="mt-6 grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
        <dt className="text-text-muted">Queue contract</dt>
        <dd className="font-mono text-[12px] text-text">
          {net?.queueAddress ?? "—"}
        </dd>
        <dt className="text-text-muted">Network</dt>
        <dd className="text-text">
          {net?.name ?? "—"}
          <span className="ml-2 font-mono text-[12px] text-text-muted">
            chain id {ACTIVE_CHAIN_ID}
          </span>
        </dd>
        <dt className="text-text-muted">Indexed through</dt>
        <dd className="font-mono text-[12px] text-text">block {head}</dd>
        <dt className="text-text-muted">Pending</dt>
        <dd className="text-text">
          <span className="font-mono tabular-nums text-[12px]">{pendingCount}</span>
          <span className="ml-2 text-text-muted">
            {pendingCount === 1 ? "request awaiting action" : "requests awaiting action"}
          </span>
        </dd>
      </dl>
    </section>
  );
}

interface SectionProps {
  number: string;
  title: string;
  children: React.ReactNode;
}

function Section({ number, title, children }: SectionProps) {
  return (
    <section className="mx-auto w-full max-w-[1100px] px-10 pt-10 md:px-16">
      <h2 className="border-b border-rule pb-2 text-[19px] font-semibold tracking-tight text-text">
        <span className="mr-2 text-text-muted">{number}</span>
        {title}
      </h2>
      <div className="pt-5">{children}</div>
    </section>
  );
}

interface ToolbarProps {
  typeFilter: EventTypeFilter | null;
  setTypeFilter: (v: EventTypeFilter | null) => void;
  mineOnly: boolean;
  setMineOnly: (next: boolean | ((prev: boolean) => boolean)) => void;
  canFilterMine: boolean;
  ownedCount: number;
}

function RecentEventsToolbar({
  typeFilter,
  setTypeFilter,
  mineOnly,
  setMineOnly,
  canFilterMine,
  ownedCount,
}: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2 text-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <ToolbarLink
          label="All"
          active={typeFilter === null}
          onClick={() => setTypeFilter(null)}
        />
        {ALL_EVENT_TYPES.map((t) => (
          <ToolbarLink
            key={t}
            label={t}
            active={typeFilter === t}
            onClick={() => setTypeFilter(t)}
          />
        ))}
      </div>
      {canFilterMine && (
        <ToolbarLink
          label={`Mine only (${ownedCount})`}
          active={mineOnly}
          onClick={() => setMineOnly((v) => !v)}
        />
      )}
    </div>
  );
}

interface ToolbarLinkProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

const TOOLBAR_HINT: Record<string, string> = {
  All: "Show every event type",
  Enqueued: "Intents that entered the queue awaiting commit/veto",
  Dispatched: "Intents that the owner or agent committed on-chain",
  Vetoed: "Intents rejected by the policy owner",
  Expired: "Intents cleared after passing the deadline unclaimed",
  PolicyPublished: "First-time publish of a policy by its owner",
  PolicyUpdated: "Edits to an existing policy",
  Ownership: "All three ownership-transfer lifecycle events grouped",
};

function ToolbarLink({ label, active, onClick }: ToolbarLinkProps) {
  // Mine-only label is dynamic (`Mine only (3)`) so look up by prefix.
  const hint =
    TOOLBAR_HINT[label] ??
    (label.startsWith("Mine only")
      ? "Restrict to events for policies your wallet owns"
      : undefined);

  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? "text-text underline underline-offset-4 decoration-text"
          : "text-text-muted hover:text-text"
      }
    >
      {label}
    </button>
  );

  if (!hint) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

interface EventRowProps {
  event: StoreEvent;
  onOpenExec: (execId: bigint) => void;
  onOpenPolicy: (policyId: Hex) => void;
  isFresh?: boolean;
}

function EventRow({ event, onOpenExec, onOpenPolicy, isFresh }: EventRowProps) {
  const typeColor = TYPE_COLOR[event.type];

  const isQueueEvent =
    event.type === "Enqueued" ||
    event.type === "Dispatched" ||
    event.type === "Vetoed" ||
    event.type === "Expired";

  const handleOpen = () => {
    if (isQueueEvent && "execId" in event) {
      onOpenExec(event.execId);
    } else if ("policyId" in event) {
      onOpenPolicy(event.policyId);
    }
  };

  const idLabel = isQueueEvent && "execId" in event
    ? `#${event.execId.toString()}`
    : truncateHex(event.policyId);

  return (
    <li>
      <button
        type="button"
        onClick={handleOpen}
        className={`group/row relative grid w-full grid-cols-[6rem_8rem_10rem_1fr] items-baseline gap-3 border-t border-rule py-2.5 text-left text-xs first:border-t-0 first:pt-0 hover:text-accent focus-visible:outline-none focus-visible:underline ${isFresh ? "row-pulse" : ""}`}
        title={
          isQueueEvent && "execId" in event
            ? `execId ${event.execId.toString()}`
            : "policyId" in event
              ? event.policyId
              : undefined
        }
      >
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-2 bottom-2 w-0.5 bg-accent opacity-0 transition-opacity group-hover/row:opacity-100"
          style={{ transitionDuration: "var(--motion-feedback)" }}
        />
        <span className="font-mono tabular-nums text-text-muted">
          blk {event.blockNumber.toString()}
        </span>
        <span className={`font-mono ${typeColor}`}>{event.type}</span>
        <span className="font-mono tabular-nums text-text">{idLabel}</span>
        <span className="truncate font-mono text-text-muted">{eventKeyArg(event)}</span>
      </button>
    </li>
  );
}
