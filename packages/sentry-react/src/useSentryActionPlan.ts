import { useCallback, useEffect, useRef, useState } from "react";
import {
  REASON_CODES,
  compilePolicy,
  evalPolicyFromInput,
  formatSentryUserMessage,
  preflight,
  type EvalIntent,
  type EvalPolicy,
  type PreflightSource,
} from "@sentry-somnia/sdk";
import type { Hex } from "viem";

export type SentryActionPlan =
  | { kind: "write-now"; intent: EvalIntent }
  | {
      kind: "queue";
      tier: "DELAYED" | "VETO_REQUIRED";
      delaySeconds: number;
      intent: EvalIntent;
    }
  | { kind: "reject"; reason: Hex; reasonText: string };

export interface PlanSentryActionArgs {
  source: PreflightSource;
  intent: EvalIntent;
  spentTodayWei: bigint | (() => Promise<bigint>);
}

export interface UseSentryActionPlanOptions extends PlanSentryActionArgs {
  /** Defaults true. Set false when the caller wants refresh-only planning. */
  enabled?: boolean;
}

export interface UseSentryActionPlanReturn {
  plan: SentryActionPlan | null;
  isPending: boolean;
  refresh: () => Promise<void>;
  error: Error | null;
}

function policyForQueuePlan(source: PreflightSource): EvalPolicy {
  if (source.kind === "local") return source.policy;
  if (source.kind === "spec") return evalPolicyFromInput(compilePolicy(source.yaml));
  throw new Error(
    "useSentryActionPlan: queue tier requires local or spec policy data; source.kind=chain only returns the decision.",
  );
}

function queuePlanFromPolicy(source: PreflightSource, intent: EvalIntent): Extract<SentryActionPlan, { kind: "queue" }> {
  const policy = policyForQueuePlan(source);
  const targetKey = intent.target.toLowerCase();
  const selectorKey = intent.selector.toLowerCase();
  const tier = policy.tier[targetKey]?.[selectorKey];
  const delaySeconds = policy.delaySeconds[targetKey]?.[selectorKey] ?? 0;

  if (tier === 1) {
    return { kind: "queue", tier: "DELAYED", delaySeconds, intent };
  }
  if (tier === 2) {
    return { kind: "queue", tier: "VETO_REQUIRED", delaySeconds, intent };
  }

  throw new Error(
    `useSentryActionPlan: preflight returned a queue reason but policy tier is ${tier ?? "missing"}.`,
  );
}

export async function planSentryAction(args: PlanSentryActionArgs): Promise<SentryActionPlan> {
  const spentTodayWei =
    typeof args.spentTodayWei === "function"
      ? await args.spentTodayWei()
      : args.spentTodayWei;
  const decision = await preflight({
    source: args.source,
    intent: args.intent,
    spentTodayWei,
  });

  if (decision.ok) {
    return { kind: "write-now", intent: args.intent };
  }

  if (decision.reason === REASON_CODES.REQUIRES_DELAY || decision.reason === REASON_CODES.REQUIRES_VETO) {
    return queuePlanFromPolicy(args.source, args.intent);
  }

  return {
    kind: "reject",
    reason: decision.reason,
    reasonText: formatSentryUserMessage(decision.reason),
  };
}

export function useSentryActionPlan(opts: UseSentryActionPlanOptions): UseSentryActionPlanReturn {
  const [plan, setPlan] = useState<SentryActionPlan | null>(null);
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const runId = useRef(0);

  const refresh = useCallback(async () => {
    const id = runId.current + 1;
    runId.current = id;
    setPending(true);
    setError(null);
    try {
      const next = await planSentryAction(opts);
      if (runId.current === id) setPlan(next);
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      if (runId.current === id) {
        setPlan(null);
        setError(errorObj);
      }
      throw errorObj;
    } finally {
      if (runId.current === id) setPending(false);
    }
  }, [opts]);

  useEffect(() => {
    if (opts.enabled === false) return;
    refresh().catch(() => {
      // Automatic refresh errors are exposed through `error`.
    });
  }, [opts.enabled, refresh]);

  return { plan, isPending, refresh, error };
}
