/**
 * Minimal ABI fragment for late-bindable WardAgentBase agents — the canonical
 * pattern from contracts/src/integration/WardAgentBase.sol. The dashboard
 * only ever needs to call `setPolicyId(bytes32)` on the dev's agent and decode
 * the `PolicyBound(newPolicyId, oldPolicyId, by)` event from the receipt.
 *
 * Why a local fragment and not a SDK export:
 * - The SDK exposes oracle/queue/registry ABIs — the Ward-owned contracts.
 *   `WardAgentBase` is INHERITED by the developer's agent (so the address is
 *   theirs, not ours), and exposing the ABI from the SDK would imply we ship
 *   that contract. Keeping the fragment in the dashboard makes the boundary
 *   honest: this is what we READ/WRITE against an arbitrary dev-owned agent
 *   that opted into the late-binding pattern.
 * - The fragment intentionally omits everything else on WardAgentBase
 *   (`owner`, `transferOwnership`, the `_call` internals). We don't simulate
 *   or send those from the dashboard; if a future surface needs them, extend
 *   here rather than re-publishing the whole contract ABI.
 *
 * NotOwner is included in the ABI so viem's `ContractFunctionRevertedError`
 * resolves `revertError.data.errorName === "NotOwner"` when `setPolicyId` is
 * called from a non-owner wallet — humanizeWeb3Error picks that up by name,
 * no manual selector matching needed.
 */
import type { Address, Hex } from "viem";

export const WARD_AGENT_BASE_ABI = [
  {
    type: "function",
    name: "setPolicyId",
    stateMutability: "nonpayable",
    inputs: [{ name: "newPolicyId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "event",
    name: "PolicyBound",
    inputs: [
      { name: "newPolicyId", type: "bytes32", indexed: true },
      { name: "oldPolicyId", type: "bytes32", indexed: true },
      { name: "by", type: "address", indexed: true },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "NotOwner",
    inputs: [],
  },
] as const;

/**
 * Decoded shape of the `PolicyBound` event — useful for callers parsing
 * receipts after a `setPolicyId` write.
 */
export interface PolicyBoundEventArgs {
  newPolicyId: Hex;
  oldPolicyId: Hex;
  by: Address;
}
