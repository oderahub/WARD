import type { Address, Hex } from "viem";
import type { PreflightResult } from "./preflight.js";
import { decodeReason } from "./reason-codes.js";

export interface WardDecisionContext {
  policyId?: Hex;
  target?: Address;
  selector?: Hex;
  requestId?: bigint;
  agentId?: bigint;
  source?: string;
}

export interface WardDecisionLog {
  event: "ward.decision";
  ok: boolean;
  reason: Hex;
  reasonText: string;
  source: PreflightResult["source"];
  policyId?: Hex;
  target?: Address;
  selector?: Hex;
  requestId?: string;
  agentId?: string;
  contextSource?: string;
}

export function formatWardDecision(
  result: PreflightResult,
  context: WardDecisionContext = {},
): WardDecisionLog {
  return {
    event: "ward.decision",
    ok: result.ok,
    reason: result.reason,
    reasonText: result.reasonText,
    source: result.source,
    policyId: context.policyId,
    target: context.target,
    selector: context.selector,
    requestId: context.requestId?.toString(),
    agentId: context.agentId?.toString(),
    contextSource: context.source,
  };
}

export function formatWardUserMessage(reason: Hex): string {
  return decodeReason(reason).description;
}
