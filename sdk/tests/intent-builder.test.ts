import { describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  getAbiItem,
  parseAbi,
  toFunctionSelector,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { buildIntent } from "../src/intent-builder.js";

const TARGET: Address = "0x1111111111111111111111111111111111111111";
const PROMPT_HASH: Hex =
  "0x2222222222222222222222222222222222222222222222222222222222222222";
const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

const jsonAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "ok", type: "bool" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "setMemo",
    stateMutability: "nonpayable",
    inputs: [{ name: "memo", type: "string" }],
    outputs: [],
  },
] as const;

const overloadedAbi = [
  {
    type: "function",
    name: "set",
    stateMutability: "nonpayable",
    inputs: [{ name: "value", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "set",
    stateMutability: "nonpayable",
    inputs: [{ name: "value", type: "address" }],
    outputs: [],
  },
] as const;

describe("buildIntent", () => {
  it("encodes calldata exactly like viem encodeFunctionData", () => {
    const args = ["0x3333333333333333333333333333333333333333", 123n] as const;

    const intent = buildIntent({
      abi: jsonAbi,
      address: TARGET,
      functionName: "transfer",
      args,
      requestId: 99n,
    });

    expect(intent.data).toBe(
      encodeFunctionData({ abi: jsonAbi, functionName: "transfer", args }),
    );
  });

  it("derives selector from the ABI function, not a caller-supplied field", () => {
    const intent = buildIntent({
      abi: jsonAbi,
      address: TARGET,
      functionName: "transfer",
      args: ["0x3333333333333333333333333333333333333333", 1n],
      requestId: 1n,
    });
    const item = getAbiItem({ abi: jsonAbi, name: "transfer" }) as AbiFunction;

    expect(intent.selector).toBe(toFunctionSelector(item));
    expect(intent.selector).toBe(intent.data.slice(0, 10));
  });

  it("forwards value into the EvalIntent", () => {
    const intent = buildIntent({
      abi: jsonAbi,
      address: TARGET,
      functionName: "deposit",
      value: 2n,
      requestId: 1n,
    });

    expect(intent.value).toBe(2n);
  });

  it("defaults Sentry metadata fields", () => {
    const intent = buildIntent({
      abi: jsonAbi,
      address: TARGET,
      functionName: "deposit",
      requestId: 7n,
    });

    expect(intent.agentId).toBe(0n);
    expect(intent.promptHash).toBe(ZERO_BYTES32);
    expect(intent.taskClass).toBe(0);
    expect(intent.value).toBe(0n);
  });

  it("preserves explicit Sentry metadata fields", () => {
    const intent = buildIntent({
      abi: jsonAbi,
      address: TARGET,
      functionName: "deposit",
      requestId: 7n,
      agentId: 8n,
      promptHash: PROMPT_HASH,
      taskClass: 3,
    });

    expect(intent.agentId).toBe(8n);
    expect(intent.promptHash).toBe(PROMPT_HASH);
    expect(intent.taskClass).toBe(3);
  });

  it("sets requestId exactly as provided", () => {
    const intent = buildIntent({
      abi: jsonAbi,
      address: TARGET,
      functionName: "deposit",
      requestId: 123456789n,
    });

    expect(intent.requestId).toBe(123456789n);
  });

  it("sets target address from the write args address", () => {
    const intent = buildIntent({
      abi: jsonAbi,
      address: TARGET,
      functionName: "deposit",
      requestId: 1n,
    });

    expect(intent.target).toBe(TARGET);
  });

  it("supports parsed human-readable viem ABIs", () => {
    const abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
    const args = ["0x4444444444444444444444444444444444444444", 10n] as const;

    const intent = buildIntent({
      abi,
      address: TARGET,
      functionName: "approve",
      args,
      requestId: 1n,
    });

    expect(intent.data).toBe(
      encodeFunctionData({ abi, functionName: "approve", args }),
    );
  });

  it("supports no-arg functions without args", () => {
    const intent = buildIntent({
      abi: jsonAbi,
      address: TARGET,
      functionName: "deposit",
      requestId: 1n,
    });

    expect(intent.data).toBe(
      encodeFunctionData({ abi: jsonAbi, functionName: "deposit" }),
    );
  });

  it("supports string arguments", () => {
    const intent = buildIntent({
      abi: jsonAbi,
      address: TARGET,
      functionName: "setMemo",
      args: ["ship it"],
      requestId: 1n,
    });

    expect(intent.data).toBe(
      encodeFunctionData({ abi: jsonAbi, functionName: "setMemo", args: ["ship it"] }),
    );
  });

  it("resolves overloaded functions by args", () => {
    const intent = buildIntent({
      abi: overloadedAbi,
      address: TARGET,
      functionName: "set",
      args: ["0x5555555555555555555555555555555555555555"],
      requestId: 1n,
    });
    const item = getAbiItem({
      abi: overloadedAbi,
      name: "set",
      args: ["0x5555555555555555555555555555555555555555"],
    }) as AbiFunction;

    expect(intent.selector).toBe(toFunctionSelector(item));
    expect(intent.data).toBe(
      encodeFunctionData({
        abi: overloadedAbi,
        functionName: "set",
        args: ["0x5555555555555555555555555555555555555555"],
      }),
    );
  });

  it("throws when requestId is missing at runtime", () => {
    expect(() =>
      buildIntent({
        abi: jsonAbi,
        address: TARGET,
        functionName: "deposit",
      } as never),
    ).toThrow(/requestId is required/);
  });

  it("throws when the function is absent from the ABI", () => {
    expect(() =>
      buildIntent({
        abi: jsonAbi,
        address: TARGET,
        functionName: "missing" as never,
        requestId: 1n,
      }),
    ).toThrow();
  });
});
