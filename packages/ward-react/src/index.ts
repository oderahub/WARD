import { useCallback, useState } from "react";
import { useConfig } from "wagmi";
import { writeContract as wagmiWriteContract } from "wagmi/actions";
import {
  buildIntent,
  preflight,
  type PreflightResult,
  type PreflightSource,
} from "@ward/sdk";
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
  ward?: {
    requestId?: bigint;
    agentId?: bigint;
    promptHash?: Hex;
    taskClass?: number;
  };
}

export interface UseWardGuardedWriteOptions {
  source: PreflightSource;
  spentTodayWei?: bigint | (() => Promise<bigint>);
}

export interface UseWardGuardedWriteReturn {
  write: <const TAbi extends Abi>(args: WriteContractArgs<TAbi>) => Promise<Hex>;
  isPreflightPending: boolean;
  lastDecision: PreflightResult | null;
}

export class WardPreflightRejectedError extends Error {
  readonly decision: PreflightResult;

  constructor(decision: PreflightResult) {
    super(decision.reasonText);
    this.name = "WardPreflightRejectedError";
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

export function createWardGuardedWrite(options: CreateGuardedWriteArgs) {
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
        requestId: args.ward?.requestId ?? 0n,
        agentId: args.ward?.agentId,
        promptHash: args.ward?.promptHash,
        taskClass: args.ward?.taskClass,
      } as Parameters<typeof buildIntent>[0]);
      const decision = await preflight({
        source: options.source,
        intent,
        spentTodayWei,
      });

      options.setLastDecision?.(decision);
      if (!decision.ok) throw new WardPreflightRejectedError(decision);

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

export function useWardGuardedWrite(
  opts: UseWardGuardedWriteOptions,
): UseWardGuardedWriteReturn {
  const config = useConfig();
  const [isPreflightPending, setPreflightPending] = useState(false);
  const [lastDecision, setLastDecision] = useState<PreflightResult | null>(null);

  const write = useCallback(
    createWardGuardedWrite({
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

export * from "./useWardActionPlan.js";
