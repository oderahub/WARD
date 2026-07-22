import type { Address, Hex, PublicClient } from "viem";
import { WARD_ORACLE_ABI } from "./abi.js";
import { compilePolicy } from "./policy-compiler.js";
import {
  evalCheckIntent,
  evalPolicyFromInput,
  type EvalIntent,
  type EvalPolicy,
} from "./policy-eval.js";
import { decodeReason } from "./reason-codes.js";

/** Source of policy data for a preflight check. */
export type PreflightSource =
  | {
      kind: "chain";
      publicClient: PublicClient;
      oracleAddress: Address;
      policyId: Hex;
    }
  | { kind: "local"; policy: EvalPolicy }
  | { kind: "spec"; yaml: string };

export interface PreflightArgs {
  source: PreflightSource;
  intent: EvalIntent;
  /** Wei this asker has already spent today against this policy. */
  spentTodayWei: bigint;
  /** Optional observer for structured telemetry and UI state. */
  onWardDecision?: (result: PreflightResult) => void;
  /** Unix seconds to evaluate against; defaults to the wall clock at the API boundary. */
  nowSec?: bigint;
}

export interface PreflightResult {
  ok: boolean;
  reason: Hex;
  /** Human-readable description from `decodeReason`. */
  reasonText: string;
  /** Which source actually answered the check (echoes `args.source.kind`). */
  source: "chain" | "local" | "spec";
}

function defaultNowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function withDecisionCallback(
  result: PreflightResult,
  callback: ((result: PreflightResult) => void) | undefined,
): PreflightResult {
  callback?.(result);
  return result;
}

/** Preflight gate for Ward-policy-protected calls. Policy rejections return `ok: false`; programmer errors throw. */
export async function preflight(args: PreflightArgs): Promise<PreflightResult> {
  const { source, intent, spentTodayWei } = args;

  if (source.kind === "chain") {
    const [ok, reason] = (await source.publicClient.readContract({
      address: source.oracleAddress,
      abi: WARD_ORACLE_ABI as never,
      functionName: "checkIntent",
      args: [source.policyId, intent as never, spentTodayWei],
    })) as readonly [boolean, Hex];
    const { description } = decodeReason(reason);
    return withDecisionCallback(
      { ok, reason, reasonText: description, source: "chain" },
      args.onWardDecision,
    );
  }

  if (source.kind === "local") {
    const nowSec = args.nowSec ?? defaultNowSec();
    const { ok, reason } = evalCheckIntent(
      source.policy,
      intent,
      spentTodayWei,
      nowSec,
    );
    const { description } = decodeReason(reason);
    return withDecisionCallback(
      { ok, reason, reasonText: description, source: "local" },
      args.onWardDecision,
    );
  }

  if (source.kind === "spec") {
    const compiled = compilePolicy(source.yaml);
    const policy = evalPolicyFromInput(compiled);
    const nowSec = args.nowSec ?? defaultNowSec();
    const { ok, reason } = evalCheckIntent(policy, intent, spentTodayWei, nowSec);
    const { description } = decodeReason(reason);
    return withDecisionCallback(
      { ok, reason, reasonText: description, source: "spec" },
      args.onWardDecision,
    );
  }

  throw new Error(
    `preflight: unsupported source.kind ${(source as { kind: string }).kind}`,
  );
}
