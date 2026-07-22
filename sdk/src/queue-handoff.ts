import type { Address } from "viem";

export type QueueHandoffTier = "IMMEDIATE" | "DELAYED" | "VETO_REQUIRED" | `UNKNOWN(${number})`;

export interface QueueHandoffInput {
  execId: bigint | string;
  queueAddress: Address;
  tier: number;
  asker: Address;
  target: Address;
  agentAddress?: Address;
  agentHasDispatchQueued?: boolean;
  policyOwner?: Address;
}

export interface QueueHandoffRecommendation {
  tier: QueueHandoffTier;
  summary: string;
  detail: string;
  command?: string;
  warning?: string;
  policyOwner?: Address;
}

export function queueTierName(tier: number): QueueHandoffTier {
  if (tier === 0) return "IMMEDIATE";
  if (tier === 1) return "DELAYED";
  if (tier === 2) return "VETO_REQUIRED";
  return `UNKNOWN(${tier})`;
}

export function castSendCommand(address: Address, signature: string, execId: bigint | string): string {
  // Use a foundry keystore account (--account) rather than --private-key, which would
  // expand the raw key into argv and expose it to local process listing (ps).
  // Operators who accept the risk can substitute --private-key $DEPLOYER_PK manually.
  return `cast send ${address} "${signature}" ${execId.toString()} --account "$CAST_ACCOUNT" --rpc-url $SOMNIA_TESTNET_RPC`;
}

export function buildQueueHandoffRecommendation(input: QueueHandoffInput): QueueHandoffRecommendation {
  const tier = queueTierName(input.tier);
  const queueDispatch = castSendCommand(input.queueAddress, "dispatch(uint256)", input.execId);

  if (tier === "IMMEDIATE") {
    return {
      tier,
      summary: "IMMEDIATE requests should not be sitting in WardQueue.",
      detail: `The queued record points at target ${input.target} from requester ${input.asker}. Dispatch the queue record to clean it up, then route future IMMEDIATE calls directly through the agent.`,
      warning: "IMMEDIATE_NO_QUEUE_NEEDED: this record is unusual and may come from an old integration path.",
      command: queueDispatch,
    };
  }

  if (tier === "DELAYED") {
    if (input.agentAddress && input.agentHasDispatchQueued) {
      return {
        tier,
        summary: "Use the integrator agent dispatch flow.",
        detail: "The supplied agent ABI exposes dispatchQueued(uint256), so the operator handoff should stay on the agent instead of bypassing its integration wrapper.",
        command: castSendCommand(input.agentAddress, "dispatchQueued(uint256)", input.execId),
      };
    }

    return {
      tier,
      summary: "Dispatch directly through WardQueue.",
      detail: "No agent ABI exposing dispatchQueued(uint256) was supplied. Raw queue dispatch is valid for DELAYED records, but the integrator's agent may have its own dispatch flow.",
      warning: "Check the agent docs before using raw queue dispatch in production.",
      command: queueDispatch,
    };
  }

  if (tier === "VETO_REQUIRED") {
    return {
      tier,
      summary: "Policy owner only.",
      detail: input.policyOwner
        ? `Send this from the policy owner wallet: ${input.policyOwner}.`
        : "Send this from the policy owner wallet. The owner address is not loaded yet.",
      policyOwner: input.policyOwner,
      command: queueDispatch,
    };
  }

  return {
    tier,
    summary: "Unknown queue tier.",
    detail: "This SDK does not recognize the record tier, so it cannot provide a safe handoff command.",
    warning: "Inspect the queue contract and policy before dispatching.",
  };
}

export function abiExposesDispatchQueued(abi: unknown): boolean {
  if (!Array.isArray(abi)) return false;
  return abi.some((item) => {
    if (!item || typeof item !== "object") return false;
    const fn = item as {
      type?: unknown;
      name?: unknown;
      inputs?: Array<{ type?: unknown }>;
    };
    return (
      fn.type === "function" &&
      fn.name === "dispatchQueued" &&
      Array.isArray(fn.inputs) &&
      fn.inputs.length === 1 &&
      fn.inputs[0]?.type === "uint256"
    );
  });
}

export function extractAbi(json: unknown): unknown {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && Array.isArray((json as { abi?: unknown }).abi)) {
    return (json as { abi: unknown }).abi;
  }
  return undefined;
}
