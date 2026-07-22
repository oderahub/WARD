import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import {
  ArrowDown,
  ArrowsClockwise,
  ArrowUp,
  ArrowUpRight,
  CheckCircle,
  ClockClockwise,
  Eye,
  MagicWand,
  MagnifyingGlass,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import type { PolicyMeta } from "@sentry-somnia/sdk";

import {
  useAgentWatcher,
  POLL_INTERVAL_MS,
  type Violation,
  type WatcherError,
} from "../hooks/useAgentWatcher";
import { useUrlState } from "../hooks/useUrlState";
import { useEventStore, type RehydrateFailure } from "../hooks/useEventStore";
import { useWallet } from "../hooks/useWallet";
import { SOMNIA_CHAIN_ID, getNetwork } from "../lib/networks";
import { ownerIndexThrottleKey } from "../lib/owner-index-throttle";
import { setWithLruCap } from "../lib/lru";
import {
  loadAllWatchSubscriptions,
  removeWatchSubscription,
  type OwnerIndexEntry,
  type WatchSubscriptionRecord,
} from "../lib/persistence";
import { maskWebhookUrl } from "../lib/slack";
import { maskBotToken } from "../lib/telegram";
import { AddressChip, Alert, ExplorerLink } from "../components/primitives";
import { decodeLabel } from "../components/PolicyDrawer";
import EmptyState from "../components/EmptyState";
import AgentsCatalogPanel from "../components/AgentsCatalogPanel";
import { Separator } from "../components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_VERSION = "v0.10.0";

function formatWeiCompact(valueWei: bigint): string {
  if (valueWei === 0n) return "0";
  const ETH = 1_000_000_000_000_000_000n;
  if (valueWei >= ETH / 1000n) {
    const whole = valueWei / ETH;
    const frac = (valueWei % ETH) * 10000n / ETH;
    return `${whole.toString()}.${frac.toString().padStart(4, "0").replace(/0+$/, "") || "0"}`;
  }
  return `${valueWei.toString()}`;
}

interface AggregatedViolation {
  agentAddress: Address;
  policyId: Hex;
  count: number;
  dominantReason: string;
  latestMs: number;
}

function aggregateByAgent(violations: ReadonlyArray<Violation>): AggregatedViolation[] {
  const map = new Map<string, AggregatedViolation>();
  const reasonCounts = new Map<string, Map<string, number>>();
  for (const v of violations) {
    const key = `${v.agentAddress.toLowerCase()}:${v.policyId.toLowerCase()}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (v.observedAtMs > existing.latestMs) existing.latestMs = v.observedAtMs;
    } else {
      map.set(key, {
        agentAddress: v.agentAddress,
        policyId: v.policyId,
        count: 1,
        dominantReason: v.reason,
        latestMs: v.observedAtMs,
      });
    }
    let r = reasonCounts.get(key);
    if (!r) {
      r = new Map();
      reasonCounts.set(key, r);
    }
    r.set(v.reason, (r.get(v.reason) ?? 0) + 1);
  }
  // Pick the dominant reason per agent (highest count, ties broken by first-seen).
  for (const [key, agg] of map) {
    const rc = reasonCounts.get(key)!;
    let topReason = agg.dominantReason;
    let topCount = 0;
    for (const [reason, count] of rc) {
      if (count > topCount) {
        topCount = count;
        topReason = reason;
      }
    }
    agg.dominantReason = topReason;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

interface HourlyBucket {
  hourStartMs: number;
  count: number;
}

/**
 * Group violations into a 168-bin hourly histogram for the last 7 days.
 * Bins are always populated even when zero so the chart x-axis is uniform.
 */
function bucketHourly(violations: ReadonlyArray<Violation>, nowMs: number): HourlyBucket[] {
  const startMs = nowMs - SEVEN_DAYS_MS;
  const bins: HourlyBucket[] = [];
  for (let i = 0; i < 168; i++) {
    bins.push({ hourStartMs: startMs + i * HOUR_MS, count: 0 });
  }
  for (const v of violations) {
    if (v.observedAtMs < startMs || v.observedAtMs >= nowMs) continue;
    const idx = Math.floor((v.observedAtMs - startMs) / HOUR_MS);
    if (idx >= 0 && idx < 168) bins[idx].count += 1;
  }
  return bins;
}

function countSince(violations: ReadonlyArray<Violation>, sinceMs: number): number {
  let n = 0;
  for (const v of violations) {
    if (v.observedAtMs >= sinceMs) n += 1;
  }
  return n;
}

export function WatchedPage() {
  const {
    violations,
    watchedEntries,
    debugTraceUnavailable,
    truncated,
    traceCoverage,
    isPolling,
    lastPolledAt,
    errors,
    manualPoll,
  } = useAgentWatcher();
  const { setMode, setTab } = useUrlState();
  const { store, snapshotKey } = useEventStore();

  const nowMs = Date.now();
  const anyTraceUnavailable = useMemo(
    () => Object.values(debugTraceUnavailable).some(Boolean),
    [debugTraceUnavailable],
  );
  const anyTruncated = useMemo(
    () => Object.values(truncated).some(Boolean),
    [truncated],
  );

  const violations24h = useMemo(
    () => countSince(violations, nowMs - ONE_DAY_MS),
    [violations, nowMs],
  );
  const weekTotal = useMemo(
    () => countSince(violations, nowMs - SEVEN_DAYS_MS),
    [violations, nowMs],
  );
  const dailyAvg7d = weekTotal / 7;
  const trend24h = dailyAvg7d === 0 ? null : violations24h - dailyAvg7d;

  const aggregated = useMemo(() => aggregateByAgent(violations), [violations]);
  const worstEntry = aggregated[0] ?? null;

  const coveragePct =
    traceCoverage.total === 0
      ? null
      : Math.round((traceCoverage.successful / traceCoverage.total) * 100);

  // Head block for the front-matter "Indexed through" line. Re-read on every
  // snapshotKey++ so the value tracks the live cursor like StatusBar does.
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

  // Empty-state branch — full-page CTA, no front-matter.
  if (watchedEntries.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg text-text">
        <DocumentFrontMatter
          watchedCount={0}
          head={head}
          isPolling={false}
          lastPolledAt={null}
          onRefresh={null}
          errors={[]}
        />
        <Section number="" title="Registered agents">
          <AgentsCatalogPanel />
        </Section>
        <Section number="" title="My policies">
          <MyPoliciesPanel />
        </Section>
        <Section number="" title="Watch mode">
          <div className="flex flex-col items-start gap-3 py-6">
            <div className="flex items-start gap-3">
              <Eye size={22} weight="duotone" className="mt-0.5 text-text-subtle" aria-hidden />
              <div className="max-w-xl">
                <p className="text-sm text-text">No agents are being watched.</p>
                <p className="mt-1 text-sm text-text-muted">
                  Watch mode lets you publish a policy for an already-deployed agent and
                  receive violation alerts as the agent transacts. It never blocks the call.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setMode("watch");
                setTab("publish");
              }}
              className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
              style={{ transitionDuration: "var(--motion-feedback)" }}
            >
              Publish a watch-mode policy
              <ArrowUpRight size={13} weight="regular" />
            </button>
          </div>
        </Section>
        <Section number="" title="Subscriptions">
          <SubscriptionsPanel />
        </Section>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg text-text">
      <DocumentFrontMatter
        watchedCount={watchedEntries.length}
        head={head}
        isPolling={isPolling}
        lastPolledAt={lastPolledAt}
        onRefresh={manualPoll}
        errors={errors}
      />

      <Section number="" title="Registered agents">
        <AgentsCatalogPanel />
      </Section>

      <Section number="" title="My policies">
        <MyPoliciesPanel />
      </Section>

      {anyTraceUnavailable ? (
        <Section number="" title="Watch mode unavailable">
          <Alert variant="danger" title="Watch mode unavailable on this RPC">
            Watch mode requires the <code className="font-mono">debug_traceTransaction</code> RPC
            method, which the current provider does not expose. Switch to an RPC that
            supports it, or violations will not be evaluated.
          </Alert>
        </Section>
      ) : (
        <Section number="" title="Violations · last 7 days">
          {anyTruncated && (
            <div className="mb-4">
              <Alert variant="warn" title="History truncated">
                First-time scan is bounded at 7 days of agent history. Older violations
                may be missed; new ones are captured normally going forward.
              </Alert>
            </div>
          )}

          <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
            <KpiCell
              label="Watched agents"
              value={watchedEntries.length.toString()}
              subtext={
                watchedEntries.length === 1
                  ? "1 policy bound"
                  : `${watchedEntries.length} policies bound`
              }
            />
            <KpiCell
              label="Violations 24h"
              value={violations.length === 0 && traceCoverage.total === 0 ? "—" : violations24h.toString()}
              subtext={
                trend24h === null
                  ? violations.length === 0
                    ? isPolling || traceCoverage.total === 0
                      ? "polling…"
                      : "no data yet"
                    : "first day of data"
                  : trend24h === 0
                    ? "matches 7d avg"
                    : trend24h > 0
                      ? `${trend24h.toFixed(1)} above 7d avg`
                      : `${Math.abs(trend24h).toFixed(1)} below 7d avg`
              }
              trend={trend24h === null ? null : trend24h > 0 ? "bad" : "good"}
            />
            <KpiCell
              label="Worst entry"
              value={worstEntry ? worstEntry.count.toString() : "—"}
              subtext={
                worstEntry ? (
                  <span className="inline-flex items-center gap-1.5">
                    <AddressChip address={worstEntry.agentAddress} />
                    <span className="text-text-subtle">violations</span>
                  </span>
                ) : (
                  "no violations recorded"
                )
              }
            />
            <KpiCell
              label="Trace coverage"
              value={coveragePct === null ? "—" : `${coveragePct}%`}
              subtext={
                coveragePct === null
                  ? "no traces attempted yet"
                  : coveragePct >= 95
                    ? <span className="inline-flex items-center gap-1 text-success"><CheckCircle size={12} weight="regular" />healthy</span>
                    : coveragePct >= 70
                      ? <span className="inline-flex items-center gap-1 text-warn"><WarningCircle size={12} weight="regular" />degraded</span>
                      : <span className="inline-flex items-center gap-1 text-danger"><WarningCircle size={12} weight="regular" />blind</span>
              }
            />
          </div>

          <div className="mt-8 grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-[3fr_2fr]">
            <ViolationsTimeChart violations={violations} nowMs={nowMs} />
            <TopViolators rows={aggregated.slice(0, 10)} />
          </div>

          <div className="mt-8">
            <RecentViolationsLog violations={violations} />
          </div>
        </Section>
      )}

      <Section number="" title="Subscriptions">
        <SubscriptionsPanel />
      </Section>

      <Footnote />
    </div>
  );
}

interface FrontMatterProps {
  watchedCount: number;
  head: string;
  isPolling: boolean;
  lastPolledAt: number | null;
  onRefresh: (() => Promise<void>) | null;
  errors: ReadonlyArray<WatcherError>;
}

function DocumentFrontMatter({
  watchedCount,
  head,
  isPolling,
  lastPolledAt,
  onRefresh,
  errors,
}: FrontMatterProps) {
  const net = getNetwork(SOMNIA_CHAIN_ID);
  const lastPolledText = lastPolledAt === null ? null : formatRelative(lastPolledAt);
  const hasErrors = errors.length > 0;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-10 pt-10 pb-8 md:px-16">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-muted">
        Registry · Document {DASHBOARD_VERSION}
      </div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text md:text-4xl">
        Sentry-watched agents on Somnia Shannon
      </h1>

      <dl className="mt-6 grid max-w-[640px] grid-cols-[140px_1fr] gap-y-1.5 gap-x-6 text-[13px]">
        <dt className="text-text-muted">Registry contract</dt>
        <dd className="font-mono text-[12px] text-text">
          {net?.registryAddress ?? "—"}
        </dd>
        <dt className="text-text-muted">Network</dt>
        <dd className="text-text">
          {net?.name ?? "—"}
          <span className="ml-2 font-mono text-[12px] text-text-muted">
            chain id {SOMNIA_CHAIN_ID}
          </span>
        </dd>
        <dt className="text-text-muted">RPC</dt>
        <dd className="font-mono text-[12px] text-text-muted">{net?.rpc ?? "—"}</dd>
        <dt className="text-text-muted">Indexed through</dt>
        <dd className="inline-flex flex-wrap items-center gap-1.5 text-text">
          <ClockClockwise size={12} weight="regular" aria-hidden className="text-text-subtle" />
          <span className="font-mono text-[12px]">block {head}</span>
          {lastPolledText && (
            <>
              <span className="mx-2 text-text-subtle">·</span>
              <span
                className={
                  hasErrors ? "text-warn" : "text-text-muted"
                }
              >
                polled {lastPolledText}
              </span>
              <span className="mx-2 text-text-subtle">·</span>
              <span className="text-text-muted">
                every {Math.round(POLL_INTERVAL_MS / 1000)}s
              </span>
            </>
          )}
        </dd>
        <dt className="text-text-muted">Entries</dt>
        <dd className="text-text">
          <span className="font-mono tabular-nums text-[12px]">{watchedCount}</span>
          <span className="ml-2 text-text-muted">
            {watchedCount === 1 ? "watched agent" : "watched agents"}
          </span>
        </dd>
      </dl>

      {(hasErrors || onRefresh) && (
        <div className="mt-5 flex items-center gap-4 text-[12px]">
          <WatcherWarnings errors={errors} />
          {onRefresh && (
            <button
              type="button"
              onClick={() => void onRefresh()}
              disabled={isPolling}
              className="inline-flex items-center gap-1.5 text-accent hover:underline disabled:cursor-wait disabled:opacity-60"
              style={{ transitionDuration: "var(--motion-feedback)" }}
            >
              <ArrowsClockwise
                size={12}
                weight="regular"
                aria-hidden
                className={isPolling ? "animate-spin" : ""}
              />
              {isPolling ? "polling…" : "poll now"}
            </button>
          )}
        </div>
      )}
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
      <h2 className="pb-2 text-[19px] font-semibold tracking-tight text-text">
        <span className="mr-2 text-text-muted">{number}</span>
        {title}
      </h2>
      <Separator orientation="horizontal" />
      <div className="pt-5">{children}</div>
    </section>
  );
}

function Footnote() {
  return (
    <footer className="mx-auto mt-10 mb-12 w-full max-w-[1100px] px-10 md:px-16">
      <Separator orientation="horizontal" />
      <div className="pt-4 text-[12px] text-text-muted">
        <sup className="font-semibold text-accent">†</sup> Registration is
        permissionless. The first wallet to call{" "}
        <code className="font-mono">register(agent, policyId, …)</code> for a
        given address becomes the entry's <em>registrar</em> and the only one who
        can subsequently update or deactivate it. See{" "}
        <code className="font-mono">SentryAgentRegistry.sol </code>.
      </div>
    </footer>
  );
}

const WATCHER_ERROR_KIND_LABEL: Record<WatcherError["kind"], string> = {
  rpc_logs_fetch: "rpc logs",
  explorer_fetch: "explorer",
  policy_input_lookup: "policy lookup",
  trace_exhausted: "trace",
};

interface WatcherWarningsProps {
  errors: ReadonlyArray<WatcherError>;
}

/** Expandable line-style affordance over the watcher's bounded ring buffer. */
function WatcherWarnings({ errors }: WatcherWarningsProps) {
  const [open, setOpen] = useState(false);
  if (errors.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${errors.length} watcher warnings`}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-warn hover:underline"
      >
        <WarningCircle size={12} weight="regular" aria-hidden />
        {errors.length} watcher warning{errors.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-[min(28rem,calc(100vw-2rem))] border border-rule bg-surface-elev p-2 text-[11px]">
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {errors.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                className="flex flex-col gap-0.5 border-t border-rule pt-1 first:border-t-0 first:pt-0"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-warn">
                    {WATCHER_ERROR_KIND_LABEL[e.kind]}
                  </span>
                  <span className="font-mono tabular-nums text-[10px] text-text-subtle">
                    {formatRelative(e.at)}
                  </span>
                </div>
                <div className="break-words text-text">{e.message}</div>
                {e.targetTxHash && (
                  <div className="flex items-center gap-1 text-[10px]">
                    <span className="font-mono text-text-subtle" title={e.targetTxHash}>
                      {e.targetTxHash.slice(0, 10)}…{e.targetTxHash.slice(-8)}
                    </span>
                    <ExplorerLink txHash={e.targetTxHash} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatRelative(thenMs: number): string {
  const dt = Date.now() - thenMs;
  if (dt < 5_000) return "just now";
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  return `${Math.floor(dt / 3_600_000)}h ago`;
}

function formatRemaining(ms: number): string {
  if (ms < 1_000) return "<1 sec";
  if (ms < 60_000) return `~${Math.round(ms / 1_000)} sec`;
  if (ms < 3_600_000) return `~${Math.round(ms / 60_000)} min`;
  return `~${Math.round(ms / 3_600_000)} hr`;
}

interface KpiCellProps {
  label: string;
  value: string;
  subtext: React.ReactNode;
  trend?: "good" | "bad" | null;
}

function KpiCell({ label, value, subtext, trend }: KpiCellProps) {
  return (
    <div className="border-t border-rule pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-text-muted">
          {label}
        </span>
        {trend === "bad" && <ArrowUp size={12} weight="regular" className="text-danger" />}
        {trend === "good" && <ArrowDown size={12} weight="regular" className="text-success" />}
      </div>
      <div className="mt-1.5 text-[28px] font-semibold tabular-nums leading-none text-text">
        {value}
      </div>
      <div className="mt-2 text-xs text-text-muted">{subtext}</div>
    </div>
  );
}

interface ChartProps {
  violations: ReadonlyArray<Violation>;
  nowMs: number;
}

function ViolationsTimeChart({ violations, nowMs }: ChartProps) {
  const bins = useMemo(() => bucketHourly(violations, nowMs), [violations, nowMs]);
  const maxCount = useMemo(() => bins.reduce((m, b) => (b.count > m ? b.count : m), 0), [bins]);
  const totalCount = useMemo(() => bins.reduce((s, b) => s + b.count, 0), [bins]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const VB_W = 720;
  const VB_H = 180;
  const PAD_L = 28;
  const PAD_R = 12;
  const PAD_T = 12;
  const PAD_B = 26;
  const plotW = VB_W - PAD_L - PAD_R;
  const plotH = VB_H - PAD_T - PAD_B;

  const stepX = plotW / Math.max(bins.length - 1, 1);
  const yScale = (count: number) =>
    maxCount === 0 ? PAD_T + plotH : PAD_T + plotH - (count / maxCount) * plotH;

  const linePath = bins
    .map((b, i) => `${i === 0 ? "M" : "L"} ${(PAD_L + i * stepX).toFixed(2)} ${yScale(b.count).toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${(PAD_L + (bins.length - 1) * stepX).toFixed(2)} ${PAD_T + plotH} L ${PAD_L.toFixed(2)} ${PAD_T + plotH} Z`;

  const startMs = nowMs - SEVEN_DAYS_MS;
  const firstMidnight = Math.ceil(startMs / ONE_DAY_MS) * ONE_DAY_MS;
  const dayMarks: { x: number; label: string }[] = [];
  for (let dayMs = firstMidnight; dayMs <= nowMs; dayMs += ONE_DAY_MS) {
    const idx = Math.floor((dayMs - startMs) / HOUR_MS);
    if (idx < 0 || idx >= bins.length) continue;
    const x = PAD_L + idx * stepX;
    const label = new Date(dayMs).toLocaleDateString(undefined, { weekday: "short" });
    dayMarks.push({ x, label });
  }

  return (
    <section className="border-t border-rule pt-3">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          Violations over time
        </h3>
        <span className="font-mono tabular-nums text-xs text-text-muted">
          {totalCount} total
        </span>
      </div>

      {totalCount === 0 ? (
        <div className="flex h-[180px] items-center">
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <CheckCircle size={16} weight="regular" className="text-success" />
            No violations in the last 7 days.
          </div>
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Violations over the last 7 days: ${totalCount} total, peak of ${maxCount} in a single hour`}
            className="block h-[180px] w-full"
            onMouseLeave={() => setHoverIdx(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const xRel = ((e.clientX - rect.left) / rect.width) * VB_W;
              const i = Math.round((xRel - PAD_L) / stepX);
              if (i >= 0 && i < bins.length) setHoverIdx(i);
              else setHoverIdx(null);
            }}
          >
            <defs>
              <linearGradient id="chartArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.00" />
              </linearGradient>
            </defs>

            <line
              x1={PAD_L}
              x2={VB_W - PAD_R}
              y1={PAD_T + plotH}
              y2={PAD_T + plotH}
              stroke="var(--rule)"
              strokeWidth={1}
            />

            {dayMarks.map((m, i) => (
              <g key={`d-${i}`}>
                <line
                  x1={m.x}
                  x2={m.x}
                  y1={PAD_T}
                  y2={PAD_T + plotH}
                  stroke="var(--rule)"
                  strokeWidth={1}
                  strokeOpacity={0.6}
                  strokeDasharray="2 4"
                />
                <text
                  x={m.x}
                  y={PAD_T + plotH + 16}
                  fontSize="10"
                  fontFamily="JetBrains Mono, ui-monospace, monospace"
                  fill="var(--text-muted)"
                  textAnchor="middle"
                >
                  {m.label}
                </text>
              </g>
            ))}

            <path d={areaPath} fill="url(#chartArea)" />
            <path
              d={linePath}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />

            {hoverIdx !== null && (
              <g>
                <line
                  x1={PAD_L + hoverIdx * stepX}
                  x2={PAD_L + hoverIdx * stepX}
                  y1={PAD_T}
                  y2={PAD_T + plotH}
                  stroke="var(--accent)"
                  strokeOpacity={0.6}
                  strokeWidth={1}
                />
                <circle
                  cx={PAD_L + hoverIdx * stepX}
                  cy={yScale(bins[hoverIdx].count)}
                  r={3}
                  fill="var(--accent)"
                />
              </g>
            )}
          </svg>

          {hoverIdx !== null && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full border border-rule bg-surface-elev px-2 py-1 text-[11px] text-text"
              style={{
                left: `${(((PAD_L + hoverIdx * stepX) / VB_W) * 100).toFixed(2)}%`,
                top: `${(((yScale(bins[hoverIdx].count) - 4) / VB_H) * 100).toFixed(2)}%`,
              }}
            >
              <div className="font-mono tabular-nums">
                {bins[hoverIdx].count} {bins[hoverIdx].count === 1 ? "violation" : "violations"}
              </div>
              <div className="font-mono text-[10px] text-text-muted">
                {new Date(bins[hoverIdx].hourStartMs).toLocaleString(undefined, {
                  weekday: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface TopViolatorsProps {
  rows: AggregatedViolation[];
}

function TopViolators({ rows }: TopViolatorsProps) {
  return (
    <section className="border-t border-rule pt-3">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          Top violators
        </h3>
        <span className="font-mono tabular-nums text-xs text-text-muted">
          showing {Math.min(rows.length, 10)}
        </span>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No violations to rank yet." />
      ) : (
        <ul>
          {rows.map((row) => (
            <li
              key={`${row.agentAddress}:${row.policyId}`}
              className="grid grid-cols-[minmax(8rem,1fr)_minmax(7rem,auto)_3rem] items-center gap-3 border-t border-rule py-2 text-xs first:border-t-0 first:pt-0"
            >
              <AddressChip address={row.agentAddress} />
              <span
                className="truncate font-mono text-[10px] uppercase tracking-wider text-warn"
                title={row.dominantReason}
              >
                {row.dominantReason}
              </span>
              <span className="text-right font-mono tabular-nums text-text">{row.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const DEFAULT_LOG_LIMIT = 10;

interface LogProps {
  violations: ReadonlyArray<Violation>;
}

function RecentViolationsLog({ violations }: LogProps) {
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(
    () => [...violations].sort((a, b) => b.observedAtMs - a.observedAtMs),
    [violations],
  );
  const visible = showAll ? sorted : sorted.slice(0, DEFAULT_LOG_LIMIT);

  return (
    <section className="border-t border-rule pt-3">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          Recent violations
        </h3>
        <span className="font-mono tabular-nums text-xs text-text-muted">
          showing {visible.length} of {sorted.length}
        </span>
      </header>
      {sorted.length === 0 ? (
        <EmptyState
          title="No violations recorded yet."
          hint="Trigger a tx that breaks the policy from one of the watched agents to see it appear here."
        />
      ) : (
        <>
          <ul>
            {visible.map((v, i) => (
              <ViolationRow key={`${v.txHash}-${v.observationIndex}-${i}`} violation={v} />
            ))}
          </ul>
          {sorted.length > DEFAULT_LOG_LIMIT && (
            <div className="pt-3">
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-xs text-accent hover:underline"
              >
                {showAll ? `Show 10` : `Show all ${sorted.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface ViolationRowProps {
  violation: Violation;
}

function ViolationRow({ violation }: ViolationRowProps) {
  return (
    <li
      className="group/row relative grid grid-cols-[6rem_minmax(9rem,1fr)_minmax(9rem,1fr)_minmax(7rem,auto)_minmax(10rem,1.5fr)_minmax(5rem,auto)] items-center gap-2 border-t border-rule py-2 text-xs first:border-t-0 first:pt-0"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-2 bottom-2 w-0.5 bg-danger opacity-0 transition-opacity group-hover/row:opacity-100"
        style={{ transitionDuration: "var(--motion-feedback)" }}
      />
      <span className="font-mono tabular-nums text-text-muted">
        blk {violation.blockNumber.toString()}
      </span>
      <span title={violation.agentAddress}>
        <AddressChip address={violation.agentAddress} />
      </span>
      <span title={violation.target}>
        <AddressChip address={violation.target} />
      </span>
      <span className="font-mono text-text-muted" title={violation.selector}>
        {violation.selector}
      </span>
      <span className="truncate font-mono uppercase tracking-wider text-warn" title={violation.reason}>
        {violation.reason}
      </span>
      <span className="flex items-center justify-end gap-2">
        <span className="font-mono tabular-nums text-text">
          {formatWeiCompact(violation.valueWei)}
          <span className="ml-1 text-[10px] text-text-muted">STT</span>
        </span>
        <ExplorerLink txHash={violation.txHash} />
      </span>
    </li>
  );
}

const AUTO_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_SCAN_LRU_CAP = 16;

/** Legacy persisted owner-index records used 0n as the unknown publish block. */
const LEGACY_PUBLISH_BLOCK_SENTINEL = 0n;

export type PolicyDisplayRow =
  | { kind: "loaded"; policy: PolicyMeta }
  | { kind: "loading"; policyId: Hex; publishedBlock: bigint }
  | { kind: "failed"; policyId: Hex; publishedBlock: bigint };

/**
 * Pure helper: merge in-memory PolicyMeta with persisted ownerIndex entries.
 * Tested in tests/pages/policy-display-rows.test.ts.
 */
export function mergePolicyDisplayRows(
  inMemory: readonly PolicyMeta[],
  ownerIndexEntries: readonly OwnerIndexEntry[],
  failureKeys: ReadonlySet<string>,
): PolicyDisplayRow[] {
  const seen = new Set<string>();
  const loaded: PolicyDisplayRow[] = [];
  for (const p of inMemory) {
    const k = p.policyId.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    loaded.push({ kind: "loaded", policy: p });
  }
  const pending: PolicyDisplayRow[] = [];
  for (const e of ownerIndexEntries) {
    const k = e.policyId.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    pending.push({
      kind: failureKeys.has(k) ? "failed" : "loading",
      policyId: e.policyId,
      publishedBlock: e.publishedBlock,
    });
  }
  loaded.sort((a, b) => {
    if (a.kind !== "loaded" || b.kind !== "loaded") return 0;
    const ab = a.policy.lastUpdatedBlock;
    const bb = b.policy.lastUpdatedBlock;
    if (ab === bb) return 0;
    return ab > bb ? -1 : 1;
  });
  pending.sort((a, b) => {
    if (a.kind === "loaded" || b.kind === "loaded") return 0;
    const ab = a.publishedBlock;
    const bb = b.publishedBlock;
    if (ab === bb) return 0;
    return ab > bb ? -1 : 1;
  });
  return [...loaded, ...pending];
}

function MyPoliciesPanel() {
  const { address: walletAddress, isConnected } = useWallet();
  const {
    store,
    snapshotKey,
    refreshOwnerIndex,
    refreshOwnerIndexShallow,
    approxBlocksPer24Hours,
    ownerIndexState,
    retryRehydrate,
    retryAllRehydrates,
    loadOwnerIndexEntries,
    rehydrateMissing,
  } = useEventStore();
  const { oracle, setDrawer } = useUrlState();
  const [ownerIndexEntries, setOwnerIndexEntries] = useState<OwnerIndexEntry[]>([]);
  const autoRehydratedRef = useRef<Set<string>>(new Set());
  const lastAutoScanAtRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!isConnected || !walletAddress || !store) return;
    const scopeKey = ownerIndexThrottleKey(SOMNIA_CHAIN_ID, oracle, walletAddress);
    const lastAt = lastAutoScanAtRef.current.get(scopeKey);
    if (lastAt !== undefined && Date.now() - lastAt < AUTO_SCAN_INTERVAL_MS) return;
    setWithLruCap(lastAutoScanAtRef.current, scopeKey, Date.now(), AUTO_SCAN_LRU_CAP);
    void refreshOwnerIndexShallow(walletAddress, approxBlocksPer24Hours);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, walletAddress, oracle, refreshOwnerIndexShallow, approxBlocksPer24Hours, store]);

  const myPolicies = useMemo(() => {
    if (!store || !walletAddress) return [];
    return store.listPoliciesByOwner(walletAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, walletAddress, snapshotKey]);

  useEffect(() => {
    if (!walletAddress) {
      setOwnerIndexEntries([]);
      return;
    }
    let cancelled = false;
    setOwnerIndexEntries([]);
    autoRehydratedRef.current = new Set();
    void loadOwnerIndexEntries(walletAddress)
      .then((entries) => {
        if (cancelled) return;
        setOwnerIndexEntries(entries);
      })
      .catch(() => {
        // best-effort
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, oracle, snapshotKey, loadOwnerIndexEntries]);

  const failureKeys = useMemo(() => {
    const s = new Set<string>();
    for (const k of ownerIndexState.rehydrateFailures.keys()) s.add(k);
    return s;
  }, [ownerIndexState.rehydrateFailures]);

  const displayRows = useMemo(
    () => mergePolicyDisplayRows(myPolicies, ownerIndexEntries, failureKeys),
    [myPolicies, ownerIndexEntries, failureKeys],
  );

  useEffect(() => {
    if (!walletAddress) return;
    for (const row of displayRows) {
      if (row.kind !== "loading") continue;
      const key = row.policyId.toLowerCase();
      if (autoRehydratedRef.current.has(key)) continue;
      autoRehydratedRef.current.add(key);
      void rehydrateMissing(walletAddress, row.policyId);
    }
  }, [displayRows, walletAddress, rehydrateMissing]);

  if (!isConnected || !walletAddress) {
    return (
      <p className="text-sm text-text-muted">
        Connect your wallet to see policies you've published.
      </p>
    );
  }

  const scanning = ownerIndexState.status === "scanning";
  const progress = ownerIndexState.progress;
  const fromBlock = ownerIndexState.scannedFromBlock;
  const SHALLOW_SKIP_HEADROOM_BLOCKS = 500_000n;
  const showSkipLink =
    scanning &&
    progress !== null &&
    fromBlock !== null &&
    progress.scannedToBlock > fromBlock &&
    BigInt(progress.totalChunks) * 1000n >
      approxBlocksPer24Hours + SHALLOW_SKIP_HEADROOM_BLOCKS;
  const handleSkip = () => {
    if (!walletAddress) return;
    void refreshOwnerIndexShallow(walletAddress, approxBlocksPer24Hours);
  };

  return (
    <div>
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <span
            className="font-mono tabular-nums text-xs text-text-muted"
            title={
              displayRows.length === myPolicies.length
                ? undefined
                : `${myPolicies.length} loaded · ${displayRows.length - myPolicies.length} loading`
            }
          >
            {displayRows.length} {displayRows.length === 1 ? "policy" : "policies"}
          </span>
          {scanning && (
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted">
              {progress === null
                ? "starting scan…"
                : `chunk ${progress.chunkIdx} / ${progress.totalChunks}` +
                  ` · block ${progress.scannedToBlock.toString()} of ${progress.targetToBlock.toString()}` +
                  ` · ${progress.foundCount} found` +
                  (progress.estRemainingMs !== null
                    ? ` · ${formatRemaining(progress.estRemainingMs)} remaining`
                    : "")}
              {showSkipLink && (
                <>
                  <span className="mx-1.5 text-text-subtle">·</span>
                  <button
                    type="button"
                    onClick={handleSkip}
                    className="text-accent underline hover:text-accent-hover"
                    title="Skip the full backward walk and only scan the last 24 hours."
                  >
                    Skip last 24 hours
                  </button>
                </>
              )}
            </span>
          )}
          {ownerIndexState.status === "error" && (
            <span className="font-mono text-[11px] text-danger" title={ownerIndexState.error}>
              scan failed
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void refreshOwnerIndex(walletAddress)}
          disabled={scanning}
          aria-label={scanning ? "Discovering my policies" : "Discover my policies across full history"}
          title={scanning ? "Scanning…" : "Discover my policies across full history"}
          className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:underline disabled:cursor-wait disabled:opacity-60"
        >
          <MagnifyingGlass
            size={12}
            weight="regular"
            aria-hidden
            className={scanning ? "animate-spin" : ""}
          />
          Discover
        </button>
      </header>

      <RehydrateFailuresPanel
        failures={ownerIndexState.rehydrateFailures}
        onRetry={retryRehydrate}
        onRetryAll={retryAllRehydrates}
      />

      {displayRows.length === 0 ? (
        <EmptyState
          title="No policies discovered yet."
          hint="Recent policies load automatically. Click Discover to scan full historical PolicyPublished events for your address."
        />
      ) : (
        <ul>
          {displayRows.map((row, idx) => {
            const rowCls =
              "grid grid-cols-[1fr_auto] items-center gap-3 border-t border-rule py-2.5 text-[13px] first:border-t-0 first:pt-0";
            if (row.kind === "loaded") {
              const p = row.policy;
              const decoded = decodeLabel(p.label);
              const shortId = `${p.policyId.slice(0, 10)}…${p.policyId.slice(-8)}`;
              const hasLabel = p.labelRecovered !== false && !!p.label;
              return (
                <li key={p.policyId}>
                  <button
                    type="button"
                    onClick={() => setDrawer({ kind: "policy", policyId: p.policyId })}
                    className={`${rowCls} w-full text-left hover:text-accent focus-visible:outline-none focus-visible:underline`}
                    title={p.policyId}
                  >
                    <span className="min-w-0 truncate">
                      {hasLabel ? (
                        <>
                          <span className={`font-medium ${decoded.kind === "hex" ? "font-mono tabular-nums" : ""}`}>
                            {decoded.value}
                          </span>
                          <span className="ml-3 font-mono text-[11px] text-text-muted">
                            {shortId}
                          </span>
                        </>
                      ) : (
                        <span className="font-mono tabular-nums text-[12px]">{shortId}</span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-[11px] text-text-muted">
                      {p.publishedBlock !== undefined
                        ? `blk ${p.publishedBlock.toString()}`
                        : `upd ${p.lastUpdatedBlock.toString()}`}
                    </span>
                  </button>
                </li>
              );
            }
            const shortId = `${row.policyId.slice(0, 10)}…${row.policyId.slice(-8)}`;
            const isLegacySentinel = row.publishedBlock === LEGACY_PUBLISH_BLOCK_SENTINEL;
            const isFailed = row.kind === "failed";
            const statusText = isFailed
              ? "Load failed"
              : isLegacySentinel
                ? "Loading (older history, may take ~1 min)…"
                : "Loading…";
            return (
              <li key={`pending-${idx}-${row.policyId}`}>
                <div
                  className={`${rowCls} ${isFailed ? "opacity-60" : ""}`}
                  title={row.policyId}
                  aria-busy={!isFailed}
                >
                  <span className="min-w-0 truncate font-mono tabular-nums text-[12px] text-text-muted">
                    {shortId}
                  </span>
                  <span
                    className={`shrink-0 font-mono text-[11px] ${
                      isFailed ? "text-danger" : "text-text-muted"
                    }`}
                  >
                    {statusText}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface RehydrateFailuresPanelProps {
  failures: ReadonlyMap<string, RehydrateFailure>;
  onRetry: (policyId: Hex) => Promise<void>;
  onRetryAll: () => Promise<void>;
}

function RehydrateFailuresPanel({
  failures,
  onRetry,
  onRetryAll,
}: RehydrateFailuresPanelProps) {
  if (failures.size === 0) return null;
  const rows = Array.from(failures.values());
  const anyInFlight = rows.some((r) => r.inFlight);
  return (
    <div className="mb-3 border-l-2 border-warn pl-3 text-xs">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-warn">
          {rows.length} polic{rows.length === 1 ? "y" : "ies"} failed to load
        </span>
        <button
          type="button"
          onClick={() => void onRetryAll()}
          disabled={anyInFlight}
          className="text-[11px] text-accent underline hover:no-underline disabled:cursor-wait disabled:opacity-60"
        >
          Retry all
        </button>
      </div>
      <ul className="mt-1 space-y-0.5">
        {rows.map((f) => (
          <li key={f.policyId} className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11px]" title={f.policyId}>
              {f.policyId.slice(0, 10)}…{f.policyId.slice(-8)}
            </span>
            <span
              className="flex-1 truncate text-[11px] text-text-muted"
              title={f.errorMessage}
            >
              {f.errorMessage.slice(0, 40)}
            </span>
            <button
              type="button"
              onClick={() => void onRetry(f.policyId)}
              disabled={f.inFlight}
              className="text-[11px] text-accent underline hover:no-underline disabled:cursor-wait disabled:opacity-60"
            >
              {f.inFlight ? "Retrying…" : "Retry"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type SubscriptionsLoad =
  | { kind: "loading" }
  | { kind: "ready"; rows: WatchSubscriptionRecord[] }
  | { kind: "error"; message: string };

const TIER_LABEL: Record<WatchSubscriptionRecord["tier"], string> = {
  conservative: "CONSERVATIVE",
  balanced: "BALANCED",
  aggressive: "AGGRESSIVE",
};

function SubscriptionsPanel() {
  const { setTab } = useUrlState();
  const [state, setState] = useState<SubscriptionsLoad>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [removingKeys, setRemovingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void loadAllWatchSubscriptions(SOMNIA_CHAIN_ID)
      .then((rows) => {
        if (cancelled) return;
        const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
        setState({ kind: "ready", rows: sorted });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Failed to read subscriptions";
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const refresh = () => setReloadKey((k) => k + 1);

  const handleRemove = (agent: Address) => {
    const key = agent.toLowerCase();
    if (removingKeys.has(key)) return;
    setRemovingKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    void removeWatchSubscription(SOMNIA_CHAIN_ID, agent)
      .catch(() => {
        // best-effort
      })
      .finally(() => {
        setRemovingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        refresh();
      });
  };

  const handleReplace = (agent: Address) => {
    const params = new URLSearchParams(window.location.search);
    params.set("address", agent);
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
    setTab("watch-wizard");
  };

  const rows = state.kind === "ready" ? state.rows : [];
  const count = rows.length;

  return (
    <div id="subscriptions">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          {state.kind === "ready" && (
            <span className="font-mono tabular-nums text-xs text-text-muted">
              {count} {count === 1 ? "subscription" : "subscriptions"}
            </span>
          )}
          {state.kind === "loading" && (
            <span className="font-mono text-[11px] text-text-muted">loading…</span>
          )}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={state.kind === "loading"}
          aria-label="Refresh subscriptions"
          title="Refresh subscriptions"
          className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:underline disabled:cursor-wait disabled:opacity-60"
        >
          <ArrowsClockwise
            size={12}
            weight="regular"
            aria-hidden
            className={state.kind === "loading" ? "animate-spin" : ""}
          />
          Refresh
        </button>
      </header>

      {state.kind === "error" && (
        <Alert variant="danger" title="Failed to load subscriptions">
          {state.message}
        </Alert>
      )}

      {state.kind === "ready" && rows.length === 0 && (
        <div className="flex flex-col items-start gap-3">
          <EmptyState
            title="No watched subscriptions yet."
            hint="Use the Watch Wizard to add one."
          />
          <button
            type="button"
            onClick={() => setTab("watch-wizard")}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
          >
            <MagicWand size={14} weight="regular" aria-hidden />
            Open Watch Wizard
          </button>
        </div>
      )}

      {state.kind === "ready" && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Webhook fingerprint</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const key = row.agent.toLowerCase();
              const removing = removingKeys.has(key);
              return (
                <TableRow key={row.key}>
                  <TableCell>
                    <AddressChip address={row.agent} />
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent">
                          {TIER_LABEL[row.tier]}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Recommendation tier: {TIER_LABEL[row.tier]}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block truncate font-mono text-[11px] text-text-muted">
                          {row.slackWebhookUrl
                            ? `Slack · ${maskWebhookUrl(row.slackWebhookUrl)}`
                            : row.telegram
                              ? `Telegram · ${maskBotToken(row.telegram.botToken)}`
                              : "(no channel)"}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Alert channel (masked — credentials are an operator secret and are never rendered in full)
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-mono tabular-nums text-[11px] text-text-muted">
                          {formatRelative(row.createdAt)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {new Date(row.createdAt).toISOString()}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center justify-end gap-4">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => handleReplace(row.agent)}
                            className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
                          >
                            <ArrowsClockwise size={12} weight="regular" aria-hidden />
                            Replace
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Re-run the Watch Wizard for this agent (replace tier or webhook)
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => handleRemove(row.agent)}
                            disabled={removing}
                            className="inline-flex items-center gap-1 text-[12px] text-danger hover:underline disabled:cursor-wait disabled:opacity-60"
                          >
                            <Trash size={12} weight="regular" aria-hidden />
                            {removing ? "Removing…" : "Remove"}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Forget this subscription locally (does not affect on-chain state)
                        </TooltipContent>
                      </Tooltip>
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
