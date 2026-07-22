import { encodeFunctionData, type Hex } from "viem";
import { SENTRY_QUEUE_ABI } from "@sentry-somnia/sdk";

import { encodeBytes32Label } from "../../lib/encoding";
import { type ButtonVariant } from "../primitives";

export type ModalKind = "veto" | "dispatch" | "expire";

/**
 * Strategy table keyed by modal kind. Centralising label/variant/encoding
 * here kills the trio of nested ternaries the old component carried for
 * gas estimation, button styling, and submit-button copy.
 */
export const ACTION_CONFIG: Record<
  ModalKind,
  {
    title: string;
    primaryLabel: string;
    variant: Extract<ButtonVariant, "danger" | "success" | "warn">;
    functionName: "veto" | "dispatch" | "expireIfStale";
    encodeArgs: (execId: bigint, reason?: string) => readonly unknown[];
    helperBody: string;
    miningVerb: string;
  }
> = {
  veto: {
    title: "Reject request",
    primaryLabel: "Reject",
    variant: "danger",
    functionName: "veto",
    encodeArgs: (id, r) => [id, encodeBytes32Label(r ?? "")],
    helperBody: "Up to 32 characters. Stored on-chain with the rejection.",
    miningVerb: "rejection",
  },
  dispatch: {
    title: "Approve and execute",
    primaryLabel: "Approve and execute",
    variant: "success",
    functionName: "dispatch",
    encodeArgs: (id) => [id],
    helperBody:
      "This signs the policy-approved call. Once mined, the queue executes the request immediately.",
    miningVerb: "execution",
  },
  expire: {
    title: "Clear expired request",
    primaryLabel: "Clear",
    variant: "warn",
    functionName: "expireIfStale",
    encodeArgs: (id) => [id],
    helperBody:
      "Anyone can clear this once the deadline passes. You pay the gas; there's no refund.",
    miningVerb: "clear",
  },
};

/**
 * Build the calldata for a given action. Shared by the gas-estimate effect
 * and the submit path so the bytes we estimate against match what we sign.
 */
export function buildCallData(kind: ModalKind, execId: bigint, reason?: string): Hex {
  const cfg = ACTION_CONFIG[kind];
  // encodeFunctionData's `args` union narrows per functionName; the strategy
  // map intentionally types them as readonly unknown[], so we lean on the
  // ABI generic to do the runtime check.
  return encodeFunctionData({
    abi: SENTRY_QUEUE_ABI,
    functionName: cfg.functionName,
    args: cfg.encodeArgs(execId, reason) as never,
  });
}

export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
