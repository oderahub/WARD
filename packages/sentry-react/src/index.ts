import { useCallback, useState } from "react";
import { useConfig } from "wagmi";
import { writeContract as wagmiWriteContract } from "wagmi/actions";
import {
  buildIntent,
  preflight,
  type PreflightResult,
  type PreflightSource,
} from "@sentry-somnia/sdk";
import type {
  Abi,
  AbiStateMutability,
  Address,
  ContractFunctionArgs,
  ContractFunctionName,
  Hex,
} from "viem";

export interface WriteContractArgs<
  TAbi extends Abi = Abi,
  TMutability extends AbiStateMutability = AbiStateMutability,
  TFunctionName extends ContractFunctionName<TAbi, TMutability> = ContractFunctionName<
    TAbi,
    TMutability
  >,
> {
  abi: TAbi;
  address: Address;
  functionName: TFunctionName;
  args?: ContractFunctionArgs<TAbi, TMutability, TFunctionName>;
  value?: bigint;
  account?: unknown;
  chainId?: number;
  /** Optional explicit gas limit for wallets that cannot estimate custom-chain gas. */
  gas?: bigint;
  sentry?: {
    requestId?: bigint;
    agentId?: bigint;
    promptHash?: Hex;
    taskClass?: number;
  };
}

export interface UseSentryGuardedWriteOptions {
  source: PreflightSource;
  spentTodayWei?: bigint | (() => Promise<bigint>);
}

export interface UseSentryGuardedWriteReturn {
  write: <const TAbi extends Abi>(args: WriteContractArgs<TAbi>) => Promise<Hex>;
  isPreflightPending: boolean;
  lastDecision: PreflightResult | null;
}

export class SentryPreflightRejectedError extends Error {
  readonly decision: PreflightResult;

  constructor(decision: PreflightResult) {
    super(decision.reasonText);
    this.name = "SentryPreflightRejectedError";
    this.decision = decision;
  }
}

export interface CreateGuardedWriteArgs {
  config: unknown;
  source: PreflightSource;
  spentTodayWei?: bigint | (() => Promise<bigint>);
  setPending?: (pending: boolean) => void;
  setLastDecision?: (decision: PreflightResult | null) => void;
  writeContract?: (config: unknown, args: WriteContractArgs) => Promise<Hex>;
}

export function createSentryGuardedWrite(options: CreateGuardedWriteArgs) {
  return async function write<const TAbi extends Abi>(
    args: WriteContractArgs<TAbi>,
  ): Promise<Hex> {
    options.setPending?.(true);
    try {
      const spentTodayWei =
        typeof options.spentTodayWei === "function"
          ? await options.spentTodayWei()
          : (options.spentTodayWei ?? 0n);
      const intent = buildIntent({
        abi: args.abi,
        address: args.address,
        functionName: args.functionName,
        args: args.args,
        value: args.value,
        requestId: args.sentry?.requestId ?? 0n,
        agentId: args.sentry?.agentId,
        promptHash: args.sentry?.promptHash,
        taskClass: args.sentry?.taskClass,
      } as Parameters<typeof buildIntent>[0]);
      const decision = await preflight({
        source: options.source,
        intent,
        spentTodayWei,
      });

      options.setLastDecision?.(decision);
      if (!decision.ok) throw new SentryPreflightRejectedError(decision);

      const writer = (options.writeContract ?? wagmiWriteContract) as (
        config: unknown,
        args: WriteContractArgs,
      ) => Promise<Hex>;
      return writer(options.config, args as WriteContractArgs);
    } finally {
      options.setPending?.(false);
    }
  };
}

export function useSentryGuardedWrite(
  opts: UseSentryGuardedWriteOptions,
): UseSentryGuardedWriteReturn {
  const config = useConfig();
  const [isPreflightPending, setPreflightPending] = useState(false);
  const [lastDecision, setLastDecision] = useState<PreflightResult | null>(null);

  const write = useCallback(
    createSentryGuardedWrite({
      config,
      source: opts.source,
      spentTodayWei: opts.spentTodayWei,
      setPending: setPreflightPending,
      setLastDecision,
    }),
    [config, opts.source, opts.spentTodayWei],
  );

  return { write, isPreflightPending, lastDecision };
}

export * from "./useSentryActionPlan.js";
