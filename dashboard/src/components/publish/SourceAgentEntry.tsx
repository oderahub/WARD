/**
 * SourceAgentEntry — the agent-first entry point at the top of the enforce-
 * mode Publish form.
 *
 * Flow:
 *   1. Operator pastes a deployed agent address.
 *   2. We debounce-then-probe (lib/agent-probe) to confirm shape: hasCode,
 *      POLICY_ID() present, owner readable.
 *   3. In parallel with probe — once the address parses — we run the
 *      agent-target discovery (lib/agent-target-discovery) to enumerate which
 *      contracts the agent is wired to call (immutable address views like
 *      counter() / router() / echoTarget()).
 *   4. Operator clicks Apply → we hand the discovered targets to the parent
 *      via onApplyDraft({ targets, bindAgentAddress? }). bindAgentAddress is
 *      ONLY set when probe.kind === "sentry-agent" (the bind step can act on
 *      it); for non-Sentry contracts we still hand back the targets but skip
 *      the bind prefill.
 *
 * State / tokens:
 *   Every input change increments a request token. Both the probe debounce
 *   and the discovery promise check the token before applying results so a
 *   stale RPC response can't overwrite a newer paste. We also drive an
 *   AbortController for the underlying fetch so the network work itself
 *   stops when possible.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getAddress, type Address } from "viem";
import { usePublicClient } from "wagmi";

import { Alert, Button, Input } from "../primitives";
import type { PolicyDraft, TargetDraft } from "../../lib/policy-draft";
import {
  probeAgent,
  type ProbeState,
} from "../../lib/agent-probe";
import {
  discoverAgentTargets,
  type AgentTarget,
} from "../../lib/agent-target-discovery";
import { useWrongNetwork } from "../../hooks/useWrongNetwork";

interface SourceAgentEntryProps {
  onApplyDraft: (partial: Partial<PolicyDraft>) => void;
}

type DiscoveryState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "results"; targets: AgentTarget[]; warnings: string[] }
  | { kind: "empty" }
  | { kind: "error"; message: string };

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function validateAddress(
  raw: string,
): { ok: true; address: Address } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: "" };
  if (!ADDRESS_RE.test(trimmed)) {
    return { ok: false, error: "Enter a 0x-prefixed 40-hex address." };
  }
  try {
    return { ok: true, address: getAddress(trimmed) };
  } catch {
    return {
      ok: false,
      error:
        "Address checksum looks off. Paste from your wallet, or use all-lowercase.",
    };
  }
}

export function SourceAgentEntry({ onApplyDraft }: SourceAgentEntryProps) {
  const publicClient = usePublicClient();
  const {
    wrong: wrongNetwork,
    current: currentChainId,
    expected: expectedChainId,
  } = useWrongNetwork();

  const [input, setInput] = useState("");
  const [validation, setValidation] = useState<
    { ok: true; address: Address } | { ok: false; error: string } | null
  >(null);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [discovery, setDiscovery] = useState<DiscoveryState>({ kind: "idle" });

  // One token covers BOTH the probe and the discovery — both async, both
  // started off the same input. Bumping it tells in-flight tasks to drop
  // their result.
  const requestTokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const onChangeInput = useCallback((next: string) => {
    setInput(next);
    setValidation(null);
    setProbe({ kind: "idle" });
    setDiscovery({ kind: "idle" });
    requestTokenRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Debounced probe + discovery. Runs 250ms after the input becomes a valid
  // address. Wrong-network gating mirrors BindStep so a probe never goes out
  // when the wallet RPC is on the wrong chain.
  useEffect(() => {
    if (wrongNetwork) {
      setProbe({ kind: "idle" });
      setDiscovery({ kind: "idle" });
      return;
    }
    const v = validateAddress(input);
    if (!v.ok) {
      if (input.trim().length === 0) setValidation(null);
      else setValidation(v);
      setProbe({ kind: "idle" });
      setDiscovery({ kind: "idle" });
      return;
    }
    setValidation(v);
    if (!publicClient) {
      setProbe({ kind: "probe-error", message: "RPC client is not ready." });
      setDiscovery({ kind: "idle" });
      return;
    }

    const myToken = ++requestTokenRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setProbe({ kind: "probing" });
    setDiscovery({ kind: "running" });

    const id = window.setTimeout(async () => {
      // Probe + discovery in parallel — the discovery doesn't depend on the
      // probe result. Per-task token-check before setState so a re-paste
      // mid-flight is honored.
      const [probeResult, discoveryResult] = await Promise.allSettled([
        probeAgent(publicClient, v.address),
        discoverAgentTargets(v.address, {
          publicClient,
          chainId: publicClient.chain?.id ?? expectedChainId,
          signal: controller.signal,
        }),
      ]);

      if (requestTokenRef.current !== myToken) return;

      if (probeResult.status === "fulfilled") {
        setProbe(probeResult.value);
      } else {
        setProbe({
          kind: "probe-error",
          message:
            probeResult.reason instanceof Error
              ? probeResult.reason.message
              : String(probeResult.reason),
        });
      }

      if (discoveryResult.status === "fulfilled") {
        const r = discoveryResult.value;
        if (!r.ok) {
          setDiscovery({ kind: "error", message: r.error });
        } else if (r.targets.length === 0) {
          setDiscovery({ kind: "empty" });
        } else {
          setDiscovery({
            kind: "results",
            targets: r.targets,
            warnings: r.warnings,
          });
        }
      } else {
        setDiscovery({
          kind: "error",
          message:
            discoveryResult.reason instanceof Error
              ? discoveryResult.reason.message
              : String(discoveryResult.reason),
        });
      }
    }, 250);

    return () => {
      window.clearTimeout(id);
    };
  }, [input, publicClient, wrongNetwork, expectedChainId]);

  const onApply = useCallback(() => {
    if (!validation?.ok) return;
    if (discovery.kind !== "results") return;
    const targets: TargetDraft[] = discovery.targets.map((t) => ({
      target: t.address,
      selectors: [
        {
          selector: "",
          tier: "IMMEDIATE",
          valueCapPerCall: "0",
          delaySeconds: 0,
        },
      ],
    }));
    // bindAgentAddress is only set for genuinely bind-capable agents.
    // Operators who pasted a non-Sentry contract still get the targets, but
    // the BindStep won't be pre-filled with an address that can't be bound.
    const isBindCapable = probe.kind === "sentry-agent";
    onApplyDraft({
      targets,
      ...(isBindCapable ? { bindAgentAddress: validation.address } : {}),
    });
  }, [discovery, probe.kind, validation, onApplyDraft]);

  const showInputError =
    validation && !validation.ok && validation.error.length > 0;

  return (
    <details
      className="group rounded-lg border border-rule bg-surface"
      aria-labelledby="source-agent-entry-heading"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-4 hover:bg-surface-elev">
        <div className="min-w-0">
          <div
            id="source-agent-entry-heading"
            className="text-[10px] font-medium uppercase tracking-wider text-accent"
          >
            Source agent (optional)
          </div>
          <p className="mt-1 text-[12px] text-text-muted">
            Paste a deployed agent address to pre-fill the targets below.
          </p>
        </div>
        <span className="shrink-0 text-[11px] text-text-muted">
          <span className="group-open:hidden">Expand ▾</span>
          <span className="hidden group-open:inline">Collapse ▴</span>
        </span>
      </summary>

      <div className="space-y-3 border-t border-rule p-4">
        {wrongNetwork && (
          <Alert variant="warn" title="Wrong network">
            Switch your wallet to Somnia testnet (chain {expectedChainId}).
            Currently on chain {currentChainId ?? "?"}. The probe is paused
            until you switch.
          </Alert>
        )}

        <div>
          <label
            htmlFor="source-agent-address"
            className="block text-[10px] font-medium uppercase tracking-wider text-text-muted"
          >
            Agent address
          </label>
          <Input
            id="source-agent-address"
            value={input}
            onChange={(e) => onChangeInput(e.target.value)}
            placeholder="0x… deployed agent address"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={showInputError ? true : undefined}
            aria-describedby={showInputError ? "source-agent-address-error" : undefined}
            className="mt-1 w-full font-mono"
          />
          {validation && !validation.ok && validation.error.length > 0 && (
            <p
              id="source-agent-address-error"
              className="mt-1 text-[12px] text-danger"
            >
              {validation.error}
            </p>
          )}
        </div>

        {validation?.ok && !wrongNetwork && <ProbeSummary probe={probe} />}

        {validation?.ok && !wrongNetwork && (
          <DiscoveryReport
            state={discovery}
            probeKind={probe.kind}
            onApply={onApply}
          />
        )}
      </div>
    </details>
  );
}

interface ProbeSummaryProps {
  probe: ProbeState;
}

function ProbeSummary({ probe }: ProbeSummaryProps) {
  if (probe.kind === "idle") return null;
  if (probe.kind === "probing") {
    return (
      <div className="text-[11px] text-text-muted" role="status">
        Checking agent…
      </div>
    );
  }
  if (probe.kind === "eoa") {
    return (
      <Alert variant="danger" title="That's a wallet, not a contract">
        There is no contract code at this address. Paste a deployed agent
        contract instead.
      </Alert>
    );
  }
  if (probe.kind === "no-set-policy-id") {
    return (
      <Alert variant="warn" title="Not a Sentry agent">
        This contract does not expose the standard{" "}
        <code className="font-mono text-[11px]">setPolicyId</code> function.
        We can still try to read its targets, but you will need to bind any
        policy manually.
      </Alert>
    );
  }
  if (probe.kind === "probe-error") {
    return (
      <Alert variant="warn" title="Could not probe agent">
        {probe.message}
      </Alert>
    );
  }
  // sentry-agent
  return (
    <div className="text-[11px] text-success">
      Confirmed: this contract inherits Sentry. We will pre-fill the bind step
      below so you only sign once.
    </div>
  );
}

interface DiscoveryReportProps {
  state: DiscoveryState;
  probeKind: ProbeState["kind"];
  onApply: () => void;
}

function DiscoveryReport({ state, probeKind, onApply }: DiscoveryReportProps) {
  if (state.kind === "idle") return null;
  if (state.kind === "running") {
    return (
      <div className="text-[11px] text-text-muted" role="status">
        Reading agent targets…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <Alert variant="warn" title="Could not read agent targets">
        {state.message}
      </Alert>
    );
  }
  if (state.kind === "empty") {
    // Hide the empty signal entirely for EOAs — the probe summary already
    // told the operator why, no need to duplicate.
    if (probeKind === "eoa") return null;
    return (
      <Alert variant="info" title="No targets found">
        We did not find any address-returning getters on this contract.
        Fill the targets section below by hand.
      </Alert>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-text-subtle">
        Found {state.targets.length} target
        {state.targets.length === 1 ? "" : "s"} on this agent
      </div>
      <ul className="space-y-1.5">
        {state.targets.map((t) => (
          <li
            key={t.address}
            className="rounded-md border border-sentry-border bg-surface-elev p-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-[11px] text-text break-all">
                {t.address}
              </code>
              {t.sourceViewNames.map((name) => (
                <span
                  key={name}
                  className="rounded border border-rule px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
                >
                  {name}()
                </span>
              ))}
            </div>
            {t.suspicious && (
              <p className="mt-1 text-[11px] text-warn">
                Heads up: this looks like an admin or ownership pointer.
                Double-check that it is really a target you want to govern.
              </p>
            )}
          </li>
        ))}
      </ul>
      {state.warnings.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-text-muted">
          {state.warnings.map((w) => (
            <li key={w}>· {w}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <Button variant="accent" size="sm" onClick={onApply}>
          Apply targets below
        </Button>
      </div>
    </div>
  );
}

export default SourceAgentEntry;
