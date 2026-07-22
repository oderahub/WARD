import { useMemo } from "react";
import type { Address, Hex } from "viem";
import { Eye } from "@phosphor-icons/react";

import {
  POLL_INTERVAL_MS,
  useAgentWatcher,
  type Violation,
} from "../hooks/useAgentWatcher";
import type { WatchedPolicy } from "../lib/watched-policies";
import { useUrlState } from "../hooks/useUrlState";
import { Alert, ExplorerLink } from "./primitives";

/**
 * WatchedSection — third section of QueueTab.
 *
 * Sentry's "watch mode": same policy spec / same on-chain publish as enforce
 * mode, but the dashboard polls the agent's tx history off-chain and
 * surfaces violations as alerts. Never blocks the call.
 *
 * For each entry in the watched-policies registry, shows the most recent
 * 10 violations sorted newest first.
 */

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

function formatWei(valueWei: bigint): string {
  if (valueWei === 0n) return "0";
  // Compact STT/ETH display. 1 ETH = 1e18 wei.
  const ETH = 1_000_000_000_000_000_000n;
  if (valueWei >= ETH / 1000n) {
    // Render with 4 decimals.
    const whole = valueWei / ETH;
    const frac = (valueWei % ETH) * 10000n / ETH;
    return `${whole.toString()}.${frac.toString().padStart(4, "0")}`;
  }
  return `${valueWei.toString()} wei`;
}

interface GroupedEntry {
  agent: Address;
  policyId: Hex;
  violations: Violation[];
}

/**
 * Group the flat violation stream by (agent, policyId) so the section can
 * render one block per watched entry. The hook itself only knows about a
 * global ring buffer — the per-entry view lives here because that's where
 * the rendering shape changes.
 *
 * The registry is the strict source of truth: only (agent, policyId) pairs
 * present in `entries` produce a group. Violations whose pair is not in the
 * registry (e.g. a watch the user removed but whose violations linger in
 * the persistent store) are silently dropped from the view. If the user
 * re-adds the watch later, the stored violations re-appear under the new
 * registry entry — by design.
 */
function groupViolations(
  violations: Violation[],
  entries: WatchedPolicy[],
): GroupedEntry[] {
  const map = new Map<string, GroupedEntry>();
  const registryKeys = new Set<string>();
  for (const e of entries) {
    const agent = e.watchedAgentAddress as Address;
    const key = `${agent.toLowerCase()}:${e.policyId.toLowerCase()}`;
    registryKeys.add(key);
    map.set(key, { agent, policyId: e.policyId, violations: [] });
  }
  for (const v of violations) {
    const key = `${v.agentAddress.toLowerCase()}:${v.policyId.toLowerCase()}`;
    if (!registryKeys.has(key)) continue;
    const existing = map.get(key);
    if (existing) existing.violations.push(v);
  }
  return [...map.values()].filter((g) =>
    registryKeys.has(`${g.agent.toLowerCase()}:${g.policyId.toLowerCase()}`),
  );
}

const POLL_INTERVAL_SEC = Math.round(POLL_INTERVAL_MS / 1000);

export default function WatchedSection() {
  const { violations, watchedEntries, debugTraceUnavailable, truncated } =
    useAgentWatcher();
  const { setTab } = useUrlState();

  const watched = useMemo(
    () => groupViolations(violations, watchedEntries),
    [violations, watchedEntries],
  );
  const anyTraceUnavailable = useMemo(
    () => Object.values(debugTraceUnavailable).some(Boolean),
    [debugTraceUnavailable],
  );
  const anyTruncated = useMemo(
    () => Object.values(truncated).some(Boolean),
    [truncated],
  );

  // Banners belong above the section body whether or not any violations have
  // been recorded yet — debug_trace missing means we won't ever see
  // violations, so the user needs to know before they wonder why the list
  // stays empty.
  const banners = (anyTraceUnavailable || anyTruncated) ? (
    <div className="space-y-2 px-4 py-2">
      {anyTraceUnavailable && (
        <Alert variant="danger" title="Watch mode unavailable on this RPC">
          Watch mode requires the <code className="font-mono">debug_traceTransaction</code> RPC
          method. Your current RPC doesn't support it — violations cannot be evaluated.
          Switch RPC or contact your provider.
        </Alert>
      )}
      {anyTruncated && (
        <Alert variant="warn" title="History truncated">
          Some history was truncated — first-time scan is bounded at 7 days / 10K txs.
          Older violations may be missed.
        </Alert>
      )}
    </div>
  ) : null;

  if (watched.length === 0) {
    return (
      <section className="border-t border-sentry-border">
        <header className="flex items-baseline justify-between border-b border-sentry-border px-4 py-1.5">
          <h2 className="text-[11px] uppercase tracking-wider font-semibold text-text">
            Watched agents
            <span className="ml-2 rounded-full border border-warn bg-warn/20 px-1.5 py-0.5 text-[9px] text-warn">
              BETA — known limitations
            </span>
          </h2>
        </header>
        {banners}
        <div className="px-4 py-6 text-sm text-text-subtle">
          No violations seen yet. Bind an agent under a watch-mode policy to start.{" "}
          <button
            type="button"
            onClick={() => setTab("publish")}
            className="text-accent hover:underline"
          >
            Publish tab → Watch mode
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="border-t border-sentry-border">
      <header className="flex items-baseline justify-between border-b border-sentry-border px-4 py-1.5">
        <h2 className="text-[11px] uppercase tracking-wider font-semibold text-text">
          Watched agents
        </h2>
        <span className="font-mono tabular-nums text-xs text-text-subtle">
          {watched.length}
        </span>
      </header>
      {banners}
      <div className="divide-y divide-sentry-border">
        {watched.map((entry) => (
          <WatchedEntry
            key={`${entry.agent}-${entry.policyId}`}
            agent={entry.agent}
            policyId={entry.policyId}
            violations={entry.violations}
          />
        ))}
      </div>
    </section>
  );
}

interface WatchedEntryProps {
  agent: Address;
  policyId: Hex;
  violations: ReadonlyArray<{
    blockNumber: bigint;
    target: Address;
    selector: Hex;
    valueWei: bigint;
    reason: string;
    txHash: Hex;
  }>;
}

function WatchedEntry({ agent, policyId, violations }: WatchedEntryProps) {
  // Sort newest first, then take last 10.
  const recent = [...violations]
    .sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : b.blockNumber < a.blockNumber ? -1 : 0))
    .slice(0, 10);

  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-1.5 text-[10px] uppercase tracking-wider text-text-subtle">
        <Eye size={11} weight="bold" className="text-text-muted" />
        <span>
          watching <span className="font-mono normal-case text-text">{truncateAddr(agent)}</span>
          {" · "}policy{" "}
          <span className="font-mono normal-case text-text">{truncateHex(policyId)}</span>
          {" · "}
          <span className="text-text-muted">
            {violations.length} {violations.length === 1 ? "violation" : "violations"}
          </span>
        </span>
      </div>
      {recent.length === 0 ? (
        <div className="px-4 py-3 text-xs text-text-subtle">
          No violations seen yet — polled every {POLL_INTERVAL_SEC}s.
        </div>
      ) : (
        <ul className="divide-y divide-sentry-border">
          {recent.map((v, i) => (
            <li
              key={`${v.txHash}-${i}`}
              className="grid grid-cols-[6rem_minmax(9rem,1fr)_8rem_minmax(6rem,auto)_minmax(10rem,1.5fr)_minmax(6rem,auto)] items-center gap-2 px-4 py-1.5 text-xs"
            >
              <span className="font-mono tabular-nums text-text-subtle">
                blk {v.blockNumber.toString()}
              </span>
              <span className="font-mono text-text-muted truncate" title={v.target}>
                {truncateAddr(v.target)}
              </span>
              <span className="font-mono text-text-muted" title={v.selector}>
                {v.selector}
              </span>
              <span className="font-mono tabular-nums text-text">{formatWei(v.valueWei)}</span>
              <span className="truncate text-warn" title={v.reason}>
                {v.reason}
              </span>
              <span className="text-right">
                <ExplorerLink txHash={v.txHash} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
