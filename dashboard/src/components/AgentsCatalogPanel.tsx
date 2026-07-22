import { useState } from "react";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import {
  ArrowsClockwise,
  Check as CheckIcon,
  CircleHalf,
  Circle,
  CircleNotch,
  Copy,
} from "@phosphor-icons/react";

import { useUrlState } from "../hooks/useUrlState";
import { SOMNIA_CHAIN_ID } from "../lib/networks";
import {
  resolveRegistryAddress,
  useAgentsCatalog,
  type AgentsFreshness,
  type CatalogAgent,
} from "../lib/agents-catalog";
import { Alert, SkeletonLines } from "./primitives";
import EmptyState from "./EmptyState";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";

/**
 * Ward-watched agents on Somnia — the discoverability surface that answers
 * "who else is using Ward?" Stacks above MyPoliciesPanel on the Watched tab.
 *
 * Data flows from `useAgentsCatalog` which runs the 2-tier fallback (on-chain
 * registry walk → IDB cache). The hook is intentionally
 * passive: it never blocks the page, the loader never throws, and a failed
 * live tier is surfaced as a non-blocking warning under the cached list.
 *
 * Lane B "Document Grade" presentation: each registered agent is a row in a
 * horizontal-rule list, NOT a card. The agent name is the line item; address,
 * tags, and policy live under it. No surface fills, no rounded chips.
 */
export default function AgentsCatalogPanel() {
  const publicClient = usePublicClient({ chainId: SOMNIA_CHAIN_ID });
  const { setDrawer, setTab } = useUrlState();
  const registryAddress = resolveRegistryAddress(SOMNIA_CHAIN_ID);

  const openInWizard = (agentAddress: CatalogAgent["agent"]) => {
    const params = new URLSearchParams(window.location.search);
    params.set("address", agentAddress);
    params.set("tab", "watch-wizard");
    params.delete("drawer");
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
    setTab("watch-wizard");
  };

  const { data, isLoading, error, refetch } = useAgentsCatalog({
    publicClient: publicClient as PublicClient | undefined,
    chainId: SOMNIA_CHAIN_ID,
    registryAddress,
  });

  const freshness = data?.freshness ?? null;
  const agents = data?.agents ?? [];
  const errors = data?.errors ?? [];

  return (
    <div>
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="font-mono tabular-nums text-xs text-text-muted">
            {agents.length} {agents.length === 1 ? "agent" : "agents"}
          </span>
          <FreshnessBadge
            freshness={freshness}
            staleAgeMs={data?.staleAgeMs}
          />
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isLoading}
          aria-label={isLoading ? "Refreshing agents catalog" : "Refresh agents catalog"}
          title={isLoading ? "Refreshing…" : "Refresh"}
          className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:underline disabled:cursor-wait disabled:opacity-60"
          style={{ transitionDuration: "var(--motion-feedback)" }}
        >
          <ArrowsClockwise
            size={12}
            weight="regular"
            aria-hidden
            className={isLoading ? "animate-spin" : ""}
          />
          Refresh
        </button>
      </header>

      {(error || errors.length > 0) && (
        <div className="mb-3">
          <Alert variant="warn" title="Some sources are degraded">
            {[error?.message, errors.join(" · ")].filter(Boolean).join(" · ")}
          </Alert>
        </div>
      )}

      {isLoading && agents.length === 0 ? (
        <div className="py-3">
          <SkeletonLines count={3} />
        </div>
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents have registered with Ward yet."
          hint="Be the first. Register your agent in the Publish flow."
        />
      ) : (
        <AgentsRegistryList
          agents={agents}
          onPolicyClick={(policyId) => setDrawer({ kind: "policy", policyId })}
          onWatchInWizard={openInWizard}
        />
      )}
    </div>
  );
}

interface FreshnessBadgeProps {
  freshness: AgentsFreshness | null;
  staleAgeMs?: number;
}

function FreshnessBadge({
  freshness,
  staleAgeMs,
}: FreshnessBadgeProps) {
  if (freshness === null) return null;
  if (freshness === "live") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-accent">
            <CircleNotch size={11} weight="regular" aria-hidden />
            live · on-chain
          </span>
        </TooltipTrigger>
        <TooltipContent>Live · on-chain registry walk</TooltipContent>
      </Tooltip>
    );
  }
  if (freshness === "cached") {
    const ageLabel = staleAgeMs !== undefined ? formatAge(staleAgeMs) : "";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-warn">
            <CircleHalf size={11} weight="regular" aria-hidden />
            cached {ageLabel ? `· ${ageLabel} ago` : ""}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Last live on-chain result, fetched {ageLabel} ago
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-text-muted">
      <Circle size={11} weight="regular" aria-hidden />
      no agents
    </span>
  );
}

function formatAge(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

interface AgentsRegistryListProps {
  agents: CatalogAgent[];
  onPolicyClick: (policyId: CatalogAgent["policyId"]) => void;
  onWatchInWizard: (agentAddress: CatalogAgent["agent"]) => void;
}

function AgentsRegistryList({
  agents,
  onPolicyClick,
  onWatchInWizard,
}: AgentsRegistryListProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Address</TableHead>
          <TableHead>Tags</TableHead>
          <TableHead>Policy</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((a) => (
          <AgentRow
            key={a.agent}
            agent={a}
            onPolicyClick={onPolicyClick}
            onWatchInWizard={onWatchInWizard}
          />
        ))}
      </TableBody>
    </Table>
  );
}

interface AgentRowProps {
  agent: CatalogAgent;
  onPolicyClick: (policyId: CatalogAgent["policyId"]) => void;
  onWatchInWizard: (agentAddress: CatalogAgent["agent"]) => void;
}

function AgentRow({ agent, onPolicyClick, onWatchInWizard }: AgentRowProps) {
  const shortPolicy = `${agent.policyId.slice(0, 10)}…${agent.policyId.slice(-8)}`;
  const displayName = agent.name.trim().length > 0 ? agent.name : "Unnamed agent";
  const tagsText = agent.tags.length > 0 ? agent.tags.join(" · ") : null;

  return (
    <TableRow>
      <TableCell>
        <span className="text-[14px] font-medium text-text">{displayName}</span>
      </TableCell>
      <TableCell>
        <span className="font-mono text-[12px] text-text-muted">
          {agent.agent}
        </span>
      </TableCell>
      <TableCell>
        {tagsText ? (
          <span className="text-[12px] text-text-muted">{tagsText}</span>
        ) : (
          <span className="text-[12px] text-text-subtle">—</span>
        )}
      </TableCell>
      <TableCell>
        <span className="inline-flex flex-wrap items-baseline gap-x-2 text-[12px]">
          <PolicyIdRef
            policyId={agent.policyId}
            shortPolicy={shortPolicy}
            onPolicyClick={onPolicyClick}
          />
        </span>
      </TableCell>
      <TableCell>
        <StatusInline active={agent.active} />
      </TableCell>
      <TableCell className="text-right">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onWatchInWizard(agent.agent)}
              aria-label={`Watch ${agent.name || agent.agent} in wizard`}
              className="text-[12px] text-accent hover:underline"
            >
              add to watch →
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Open {agent.agent} in the Watch Wizard with the address pre-filled
          </TooltipContent>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}

interface PolicyIdRefProps {
  policyId: CatalogAgent["policyId"];
  shortPolicy: string;
  onPolicyClick: (policyId: CatalogAgent["policyId"]) => void;
}

function PolicyIdRef({ policyId, shortPolicy, onPolicyClick }: PolicyIdRefProps) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(policyId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore — clipboard may be unavailable
    }
  };
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onPolicyClick(policyId)}
            className="font-mono tabular-nums text-accent hover:underline focus-visible:outline-none focus-visible:underline"
          >
            {shortPolicy}
          </button>
        </TooltipTrigger>
        <TooltipContent>{policyId}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text"
            aria-label="Copy policy id"
          >
            {copied ? (
              <>
                <CheckIcon size={11} weight="regular" /> copied
              </>
            ) : (
              <>
                <Copy size={11} weight="regular" aria-hidden /> copy
              </>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>Copy policy id</TooltipContent>
      </Tooltip>
    </>
  );
}

function StatusInline({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-success">
        <Circle size={7} weight="regular" aria-hidden />
        active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-text-muted">
      <CircleHalf size={7} weight="regular" aria-hidden />
      inactive
    </span>
  );
}
