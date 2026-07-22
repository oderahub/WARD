import {
  encodeFunctionData,
  getAbiItem,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type AbiStateMutability,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
} from "viem";
import type { EvalIntent } from "./policy-eval.js";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export interface BuildIntentArgs<
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
  requestId: bigint;
  agentId?: bigint;
  promptHash?: Hex;
  taskClass?: number;
}

export function buildIntent<
  const TAbi extends Abi,
  TMutability extends AbiStateMutability = AbiStateMutability,
  TFunctionName extends ContractFunctionName<TAbi, TMutability> = ContractFunctionName<
    TAbi,
    TMutability
  >,
>(args: BuildIntentArgs<TAbi, TMutability, TFunctionName>): EvalIntent {
  if (args.requestId === undefined) {
    throw new Error("buildIntent: requestId is required");
  }

  const functionArgs = (args.args ?? []) as ContractFunctionArgs<
    TAbi,
    TMutability,
    TFunctionName
  >;
  const data = encodeFunctionData({
    abi: args.abi,
    functionName: args.functionName,
    args: functionArgs,
  } as Parameters<typeof encodeFunctionData>[0]) as Hex;
  const abiItem = getAbiItem({
    abi: args.abi,
    name: args.functionName,
    args: functionArgs,
  } as Parameters<typeof getAbiItem>[0]);

  if (!abiItem || abiItem.type !== "function") {
    throw new Error(`buildIntent: function ${String(args.functionName)} not found in ABI`);
  }

  return {
    agentId: args.agentId ?? 0n,
    requestId: args.requestId,
    target: args.address,
    selector: toFunctionSelector(abiItem as AbiFunction) as Hex,
    data,
    value: args.value ?? 0n,
    promptHash: args.promptHash ?? ZERO_BYTES32,
    taskClass: args.taskClass ?? 0,
  };
}
