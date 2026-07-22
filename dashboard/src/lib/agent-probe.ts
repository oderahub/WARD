/**
 * Shared probe for "is this address a SentryAgentBase-shaped contract that
 * the dashboard can re-bind?" Extracted from BindStep so the agent-first
 * Publish entry point (SourceAgentEntry) and the post-publish Bind step
 * call exactly the same code path — one source of truth for the discriminated
 * union of probe outcomes.
 *
 * No React, no wagmi — accepts a viem PublicClient + Address, returns a
 * ProbeState. Lives in /lib/ so both call sites import without dragging
 * BindStep's render code along.
 *
 * Reads happen in series rather than parallel because POLICY_ID() / owner()
 * are only meaningful when hasCode is true — the early-exit on EOA saves two
 * RPCs in the common wrong-paste case.
 */
import type { Address, Hex, PublicClient } from "viem";

/**
 * Probe outcome. Mirrors the shape BindStep already used internally; kept
 * narrow on purpose — three signals matter (does the address have code, does
 * it expose POLICY_ID, and who owns it).
 */
export type ProbeState =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "eoa" } // hasCode === false
  | { kind: "no-set-policy-id" } // hasCode but POLICY_ID() reverts
  | {
      kind: "sentry-agent";
      currentPolicyId: Hex | null;
      owner: Address | null;
    }
  | { kind: "probe-error"; message: string };

const POLICY_ID_VIEW_ABI = [
  {
    type: "function",
    name: "POLICY_ID",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const OWNER_VIEW_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * Probe `address` and report whether it's a SentryAgentBase-style late-bindable
 * contract. The result discriminates between EOA / no-late-binding /
 * sentry-agent / RPC failure so call sites can render or gate appropriately.
 */
export async function probeAgent(
  publicClient: PublicClient,
  address: Address,
): Promise<ProbeState> {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") return { kind: "eoa" };

  // POLICY_ID() first — if this reverts, the contract isn't a SentryAgentBase
  // derivative and there's nothing more to learn. owner() is a separate read
  // because OZ Ownable's owner() is so common that a contract can expose it
  // without inheriting SentryAgentBase.
  let currentPolicyId: Hex | null = null;
  try {
    currentPolicyId = (await publicClient.readContract({
      address,
      abi: POLICY_ID_VIEW_ABI,
      functionName: "POLICY_ID",
    })) as Hex;
  } catch {
    return { kind: "no-set-policy-id" };
  }

  let owner: Address | null = null;
  try {
    owner = (await publicClient.readContract({
      address,
      abi: OWNER_VIEW_ABI,
      functionName: "owner",
    })) as Address;
  } catch {
    // Some valid SentryAgentBase derivatives might not expose owner() publicly
    // (e.g. they override visibility). Treat as unknown rather than fatal.
    owner = null;
  }

  return { kind: "sentry-agent", currentPolicyId, owner };
}
