/**
 * Agent-target discovery — the engine behind the agent-first Publish entry
 * point.
 *
 * Pipeline:
 *   1. Load the agent's ABI via `fetchContractAddressViews`. This filters to
 *      parameter-less view/pure functions returning a single address — the
 *      canonical shape SentryAgentBase derivatives use to expose their
 *      immutable targets (counter(), router(), tokenIn(), echoTarget(), …).
 *   2. For each candidate view, readContract it on chain. A per-view revert
 *      is tolerated (logged via the warnings array) — the agent might expose
 *      a getter like factory() that reverts when uninitialized, and we don't
 *      want one bad view to nuke the whole discovery.
 *   3. Filter out: zero address (uninitialized slot), the agent itself
 *      (self-reference is a footgun, not a target), and RESERVED_TARGETS
 *      (oracle / queue / precompiles — already blocked by the publish form).
 *   4. Dedupe by lowercase address, BUT preserve every source view name per
 *      bucket so the UI can show "this address was returned by counter() AND
 *      target()". Useful when a single contract is referenced by multiple
 *      role-named getters.
 *   5. Tag each surviving target with `suspicious: boolean` when the view
 *      name matches the SUSPICIOUS_NAMES set (owner / admin / etc.) — the
 *      operator might want to govern those, but they're easy to mis-target.
 *
 * No React, no wagmi — pure async function. The caller wires the publicClient
 * + an AbortSignal; we honor the signal before applying any result so an
 * in-flight discovery can be safely cancelled when the operator re-pastes.
 */
import type { Address, PublicClient } from "viem";

import {
  fetchContractAddressViews,
  type AddressViewInfo,
} from "./abi-fetch";
import { RESERVED_TARGETS } from "./policy-draft";

/**
 * View names that very commonly point at addresses the operator did NOT mean
 * to govern from a generic policy (owner/admin/governance/etc.). We don't
 * filter them out — the operator may legitimately want to gate calls to
 * `governor` for example — but we tag them so the UI can render a small
 * warning chip.
 */
const SUSPICIOUS_NAMES: ReadonlySet<string> = new Set(
  [
    "owner",
    "admin",
    "implementation",
    "factory",
    "beacon",
    "guardian",
    "governor",
    "feeRecipient",
    "treasury",
  ].map((s) => s.toLowerCase()),
);

export interface AgentTarget {
  address: Address;
  /** Names of every parameter-less address-returning view that resolved to
   *  this address. Multiple entries when several getters point at the same
   *  contract (e.g. router() and weth() returning the same wrapper). */
  sourceViewNames: string[];
  /** True when ANY source view name lands in SUSPICIOUS_NAMES. */
  suspicious: boolean;
}

export type AgentTargetDiscoveryResult =
  | { ok: true; targets: AgentTarget[]; warnings: string[] }
  | { ok: false; error: string };

export interface DiscoverAgentTargetsOpts {
  publicClient: PublicClient;
  chainId: number;
  signal?: AbortSignal;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Run the full discovery pipeline against `agent`. Returns the resolved
 * targets + a list of human-readable warnings (per-view reverts, abi-load
 * failures, etc.). Never throws on per-view problems — those become warnings.
 */
export async function discoverAgentTargets(
  agent: Address,
  opts: DiscoverAgentTargetsOpts,
): Promise<AgentTargetDiscoveryResult> {
  if (opts.signal?.aborted) {
    return { ok: false, error: "aborted" };
  }

  const abi = await fetchContractAddressViews(agent, {
    publicClient: opts.publicClient,
    chainId: opts.chainId,
    signal: opts.signal,
  });

  if (opts.signal?.aborted) {
    return { ok: false, error: "aborted" };
  }

  if (!abi.ok) {
    return { ok: false, error: abi.error };
  }

  if (abi.views.length === 0) {
    return { ok: true, targets: [], warnings: [] };
  }

  const warnings: string[] = [];
  const agentLower = agent.toLowerCase();

  // Read every candidate view in parallel; allSettled so one revert doesn't
  // strand the others.
  const results = await Promise.allSettled(
    abi.views.map((view) =>
      opts.publicClient
        .readContract({
          address: agent,
          abi: [
            {
              type: "function",
              name: view.name,
              stateMutability: "view",
              inputs: [],
              outputs: [{ type: "address" }],
            },
          ],
          functionName: view.name,
        })
        .then((value) => ({ view, value: value as Address })),
    ),
  );

  if (opts.signal?.aborted) {
    return { ok: false, error: "aborted" };
  }

  // Dedupe + classify in a single pass. Map preserves insertion order so the
  // UI surfaces targets in ABI order, which mirrors the contract author's
  // declared priority.
  const buckets = new Map<
    string,
    { address: Address; names: string[]; suspicious: boolean }
  >();

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const view: AddressViewInfo = abi.views[i];
    if (r.status === "rejected") {
      warnings.push(
        `${view.name}() reverted — skipped. ${shortenError(r.reason)}`,
      );
      continue;
    }
    const raw = r.value.value;
    if (!raw || typeof raw !== "string") continue;
    const lower = raw.toLowerCase() as Address;

    if (lower === ZERO_ADDR) continue;
    if (lower === agentLower) continue;
    if (RESERVED_TARGETS.has(lower)) continue;

    const existing = buckets.get(lower);
    const isSuspicious = SUSPICIOUS_NAMES.has(view.name.toLowerCase());
    if (existing) {
      // Preserve every source view name so the UI can render all chips.
      // Same view name repeating (rare — only via ABI duplication) shouldn't
      // double-list; dedupe within the bucket.
      if (!existing.names.includes(view.name)) {
        existing.names.push(view.name);
      }
      existing.suspicious = existing.suspicious || isSuspicious;
    } else {
      buckets.set(lower, {
        address: lower,
        names: [view.name],
        suspicious: isSuspicious,
      });
    }
  }

  const targets: AgentTarget[] = Array.from(buckets.values()).map((b) => ({
    address: b.address,
    sourceViewNames: b.names,
    suspicious: b.suspicious,
  }));

  return { ok: true, targets, warnings };
}

function shortenError(reason: unknown): string {
  if (reason instanceof Error) {
    const first = reason.message.split("\n")[0]?.trim() ?? "";
    return first.length > 0 ? first : "RPC reverted.";
  }
  return "RPC reverted.";
}
