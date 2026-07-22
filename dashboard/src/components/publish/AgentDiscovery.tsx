import { useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import type { PublicClient } from "viem";
import { Alert, Button, Input, AddressChip } from "../primitives";
import type { PolicyDraft, SelectorDraft, TargetDraft } from "../../lib/policy-draft";
import {
  discoverAgentCallSurface,
  type DiscoveredTarget,
  type DiscoveredFunction,
  type DiscoverySource,
} from "../../lib/agent-discovery";

interface Props {
  onApplyDraft: (draft: Partial<PolicyDraft>) => void;
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type State =
  | { kind: "idle" }
  | { kind: "scanning" }
  | {
      kind: "results";
      targets: DiscoveredTarget[];
      source: DiscoverySource;
      agentKind: "contract" | "eoa";
      txsScanned: number;
      traceFailed: boolean;
      warnings: string[];
    }
  | { kind: "error"; message: string }
  | { kind: "empty" };

// Sentinel: when this exact string appears in `warnings`, the result is
// suspicious (the address looks like a token). The agent-discovery lib
// emits the same string; keeping it in one constant keeps the two sides
// in sync without exporting a tagged enum.
const TOKEN_WARNING_PREFIX = "This address looks like a token";

/** Canonical key for a (target, function) pair used by the selection set. */
function fnKey(targetAddress: string, fn: DiscoveredFunction): string {
  return `${targetAddress.toLowerCase()}::${fn.signature ?? fn.selector}`;
}

/**
 * Agent-side discovery panel. The user pastes the address of their AGENT
 * (the EOA or contract that will sign intents) and we scan recent on-chain
 * activity to surface which (target, selector) pairs that agent has called.
 * Selected pairs are folded into the publish form's draft as `targets[]`.
 *
 * This complements AbiPicker, which works target-side (paste a target, get
 * its functions). Here we work agent-side: the call surface is observed,
 * not declared by the target.
 */
export default function AgentDiscovery({ onApplyDraft }: Props) {
  const publicClient = usePublicClient();
  const [address, setAddress] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Stale-response guard. Each scan stamps the agent address it was started
  // for; responses for a different address (or after the user cleared the
  // input) are dropped on the floor.
  const inFlightFor = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const addressValid = ADDRESS_RE.test(address);
  const scanDisabled = !addressValid || state.kind === "scanning" || !publicClient;

  async function onDiscover() {
    if (!publicClient) {
      setState({
        kind: "error",
        message: "no RPC client available (wagmi public client missing)",
      });
      return;
    }
    // Cancel any previous scan still in flight.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const agent = address;
    inFlightFor.current = agent;
    setState({ kind: "scanning" });
    setChecked(new Set());

    try {
      const result = await discoverAgentCallSurface(agent, {
        publicClient: publicClient as PublicClient,
        maxTxs: 50,
        signal: controller.signal,
      });
      if (inFlightFor.current !== agent) return;

      if (!result.ok) {
        setState({ kind: "error", message: result.error });
        return;
      }
      if (result.targets.length === 0) {
        // If every tx failed to trace, prefer the explicit "RPC doesn't
        // support debug_traceTransaction" message that the lib already put
        // at the front of warnings, rather than a generic "no calls" line
        // that hides the real cause.
        if (result.traceFailed && result.txsScanned === 0) {
          const msg =
            result.warnings[0] ??
            "Discovery requires debug_traceTransaction. Your RPC does not support it.";
          setState({ kind: "error", message: msg });
          return;
        }
        setState({ kind: "empty" });
        return;
      }
      setState({
        kind: "results",
        targets: result.targets,
        source: result.source,
        agentKind: result.agentKind,
        txsScanned: result.txsScanned,
        traceFailed: result.traceFailed,
        warnings: result.warnings ?? [],
      });
    } catch (err) {
      if (inFlightFor.current !== agent) return;
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function onApply() {
    if (state.kind !== "results") return;
    // Group selected functions back under their target address. We only emit
    // targets that have at least one selected function so the form doesn't
    // pick up empty target entries.
    const targets: TargetDraft[] = [];
    for (const t of state.targets) {
      const selectors: SelectorDraft[] = [];
      for (const fn of t.functions) {
        if (!checked.has(fnKey(t.address, fn))) continue;
        // Prefer the canonical signature when available; otherwise fall back
        // to the raw 4-byte selector so at least the on-chain match works.
        const sel = fn.signature ?? fn.selector;
        selectors.push({
          selector: sel,
          tier: "IMMEDIATE",
          valueCapPerCall: "0",
          delaySeconds: 0,
        });
      }
      if (selectors.length > 0) {
        targets.push({ target: t.address, selectors });
      }
    }
    if (targets.length === 0) return;
    onApplyDraft({ targets });
  }

  const totalTargets = state.kind === "results" ? state.targets.length : 0;

  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-text-subtle">
        discover from an existing agent on fuji
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value.trim())}
          placeholder="0x… agent address"
          className="flex-1 font-mono"
          spellCheck={false}
          autoComplete="off"
        />
        <Button variant="accent" size="sm" disabled={scanDisabled} onClick={onDiscover}>
          Discover call surface
        </Button>
      </div>

      {state.kind === "scanning" && (
        <div className="space-y-1">
          <div className="text-[11px] text-text-subtle">
            Scanning recent agent activity, then explorer history if needed…
          </div>
          <div className="space-y-1">
            <div className="shimmer h-4 rounded-md" />
            <div className="shimmer h-4 w-3/4 rounded-md" />
            <div className="shimmer h-4 w-1/2 rounded-md" />
          </div>
        </div>
      )}

      {state.kind === "error" && (
        <Alert variant="danger" title="Couldn't discover">
          {state.message}
        </Alert>
      )}

      {state.kind === "empty" && (
        <Alert variant="info" title="Nothing to import">
          This address has no outbound contract calls in recent history. If
          you're hand-crafting a policy from scratch, skip this and fill the
          form below.
        </Alert>
      )}

      {state.kind === "results" && (
        <>
          {state.warnings.some((w) => w.startsWith(TOKEN_WARNING_PREFIX)) && (
            <Alert variant="warn" title="Suspicious address">
              Looks like a token, not an agent. Discovery will be noisy — are
              you sure this is your agent?
            </Alert>
          )}
          <div className="text-[11px] uppercase tracking-wider text-text-subtle">
            found {totalTargets} target{totalTargets === 1 ? "" : "s"} across{" "}
            {state.txsScanned} tx{state.txsScanned === 1 ? "" : "s"} · source:{" "}
            {state.source}
            {state.agentKind === "eoa"
              ? " (EOA, outbound txs)"
              : " (contract, inbound txs)"}
          </div>
          {state.warnings.length > 0 && (
            <div className="text-[11px] text-warn">{state.warnings.join(" · ")}</div>
          )}

          <div className="space-y-2">
            {state.targets.map((t) => (
              <div
                key={t.address}
                className="rounded-md border border-ward-border bg-surface p-2 space-y-1"
              >
                <AddressChip address={t.address as `0x${string}`} />
                <div className="space-y-1">
                  {t.functions.map((fn) => {
                    const key = fnKey(t.address, fn);
                    const id = `agentdisc-${key}`;
                    const isChecked = checked.has(key);
                    return (
                      <label
                        key={key}
                        htmlFor={id}
                        className="flex items-center gap-2 rounded-md border border-ward-border bg-surface-elev px-2 py-1 text-sm hover:border-text-muted cursor-pointer"
                      >
                        <input
                          id={id}
                          type="checkbox"
                          className="h-3 w-3 accent-accent"
                          checked={isChecked}
                          onChange={() => toggle(key)}
                        />
                        <span className="flex-1 font-mono text-xs">
                          {fn.signature ?? fn.selector}
                        </span>
                        <span className="text-[11px] text-text-subtle">
                          {fn.callCount} call{fn.callCount === 1 ? "" : "s"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <Button
            variant="accent"
            size="sm"
            disabled={checked.size === 0}
            onClick={onApply}
          >
            Apply all selected
          </Button>
        </>
      )}
    </div>
  );
}
