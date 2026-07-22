import type { Address, Hex } from "viem";
import type { PreflightResult } from "./preflight.js";
import { decodeReason } from "./reason-codes.js";

export interface SentryDecisionContext {
  policyId?: Hex;
  target?: Address;
  selector?: Hex;
  requestId?: bigint;
  agentId?: bigint;
  source?: string;
}

export interface SentryDecisionLog {
  event: "sentry.decision";
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

export function formatSentryDecision(
  result: PreflightResult,
  context: SentryDecisionContext = {},
): SentryDecisionLog {
  return {
    event: "sentry.decision",
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

export function formatSentryUserMessage(reason: Hex): string {
  return decodeReason(reason).description;
}
