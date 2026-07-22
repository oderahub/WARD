import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hex, WalletClient } from "viem";
import { formatSentryUserMessage } from "./formatters.js";
import { buildIntent } from "./intent-builder.js";
import { preflight, type PreflightResult, type PreflightSource } from "./preflight.js";

export interface WithSentryPreflightOptions {
  source: PreflightSource;
  spentTodayWei: bigint | (() => Promise<bigint>);
  onRejected?: (decision: PreflightResult) => void;
}

type WriteContractInput<TAbi extends Abi = Abi> = {
  abi: TAbi;
  address: Address;
  functionName: ContractFunctionName<TAbi>;
  args?: ContractFunctionArgs<TAbi, never, ContractFunctionName<TAbi>>;
  value?: bigint;
  sentry?: {
    requestId?: bigint;
    agentId?: bigint;
    promptHash?: Hex;
    taskClass?: number;
  };
};

async function resolveSpentTodayWei(value: bigint | (() => Promise<bigint>)): Promise<bigint> {
  return typeof value === "function" ? value() : value;
}

export function withSentryPreflight<TWallet extends WalletClient>(
  wallet: TWallet,
  opts: WithSentryPreflightOptions,
): TWallet {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop === "_underlying") return target;

      const original = Reflect.get(target, prop, receiver);

      if (prop === "writeContract" && typeof original === "function") {
        return async (args: WriteContractInput) => {
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
            source: opts.source,
            intent,
            spentTodayWei: await resolveSpentTodayWei(opts.spentTodayWei),
          });

          if (!decision.ok) {
            opts.onRejected?.(decision);
            throw new Error(formatSentryUserMessage(decision.reason));
          }

          return original.call(target, args);
        };
      }

      if (prop === "sendTransaction" && typeof original === "function") {
        return async (...args: unknown[]) => {
          console.warn(
            "withSentryPreflight: sendTransaction without ABI context skipped — preflight needs functionName+abi",
          );
          return original.apply(target, args);
        };
      }

      return typeof original === "function" ? original.bind(target) : original;
    },
  }) as TWallet;
}
