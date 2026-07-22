import { describe, it, expect } from "vitest";
import { SENTRY_ORACLE_ABI, SENTRY_QUEUE_ABI, SENTRY_AGENT_REGISTRY_ABI, ERC20_ABI } from "../src/abi.js";

function hasFn(abi: readonly unknown[], name: string): boolean {
  return abi.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: string; name?: string }).type === "function" &&
      (item as { name?: string }).name === name,
  );
}

function hasEvent(abi: readonly unknown[], name: string): boolean {
  return abi.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: string; name?: string }).type === "event" &&
      (item as { name?: string }).name === name,
  );
}

function functionComponents(abi: readonly unknown[], name: string): Array<{ name?: string; type?: string }> {
  const fn = abi.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: string; name?: string }).type === "function" &&
      (item as { name?: string }).name === name,
  ) as { outputs?: Array<{ components?: Array<{ name?: string; type?: string }> }> } | undefined;
  return fn?.outputs?.[0]?.components ?? [];
}

describe("ABI extraction", () => {
  it("SentryOracle exposes core entrypoints", () => {
    expect(hasFn(SENTRY_ORACLE_ABI, "publishPolicy")).toBe(true);
    expect(hasFn(SENTRY_ORACLE_ABI, "updatePolicy")).toBe(true);
    expect(hasFn(SENTRY_ORACLE_ABI, "checkIntent")).toBe(true);
    expect(hasFn(SENTRY_ORACLE_ABI, "tierAndDelay")).toBe(true);
    expect(hasFn(SENTRY_ORACLE_ABI, "policyIdFor")).toBe(true);
    expect(hasFn(SENTRY_ORACLE_ABI, "policyOwner")).toBe(true);
  });

  it("SentryOracle emits publish + update events", () => {
    expect(hasEvent(SENTRY_ORACLE_ABI, "PolicyPublished")).toBe(true);
    expect(hasEvent(SENTRY_ORACLE_ABI, "PolicyUpdated")).toBe(true);
  });

  it("SentryOracle exposes policyHealth (v0.5 kill-switch read)", () => {
    expect(hasFn(SENTRY_ORACLE_ABI, "policyHealth")).toBe(true);
  });

  it("SentryQueue exposes the queue lifecycle entrypoints", () => {
    expect(hasFn(SENTRY_QUEUE_ABI, "enqueue")).toBe(true);
    expect(hasFn(SENTRY_QUEUE_ABI, "dispatch")).toBe(true);
    expect(hasFn(SENTRY_QUEUE_ABI, "veto")).toBe(true);
    expect(hasFn(SENTRY_QUEUE_ABI, "expireIfStale")).toBe(true);
    expect(hasFn(SENTRY_QUEUE_ABI, "getRecord")).toBe(true);
    expect(hasFn(SENTRY_QUEUE_ABI, "getRecordHeader")).toBe(true);
    expect(hasFn(SENTRY_QUEUE_ABI, "nextExecId")).toBe(true);
  });

  it("SentryQueue getRecordHeader ABI matches the Solidity RecordHeader tuple order", () => {
    expect(functionComponents(SENTRY_QUEUE_ABI, "getRecordHeader").map((c) => [c.name, c.type])).toEqual([
      ["policyId", "bytes32"],
      ["policyVersion", "uint64"],
      ["asker", "address"],
      ["enqueuedAt", "uint64"],
      ["earliestCommitAt", "uint64"],
      ["deadline", "uint64"],
      ["tier", "uint8"],
      ["state", "uint8"],
      ["target", "address"],
      ["selector", "bytes4"],
      ["value", "uint256"],
      ["requestId", "uint256"],
    ]);
  });

  it("SentryQueue emits the four lifecycle events", () => {
    expect(hasEvent(SENTRY_QUEUE_ABI, "Enqueued")).toBe(true);
    expect(hasEvent(SENTRY_QUEUE_ABI, "Dispatched")).toBe(true);
    expect(hasEvent(SENTRY_QUEUE_ABI, "Vetoed")).toBe(true);
    expect(hasEvent(SENTRY_QUEUE_ABI, "Expired")).toBe(true);
  });

  it("ERC20 standard subset (handwritten, not derived from any mock)", () => {
    expect(hasFn(ERC20_ABI, "balanceOf")).toBe(true);
    expect(hasFn(ERC20_ABI, "approve")).toBe(true);
    expect(hasFn(ERC20_ABI, "transfer")).toBe(true);
    expect(hasFn(ERC20_ABI, "transferFrom")).toBe(true);
    expect(hasFn(ERC20_ABI, "allowance")).toBe(true);
    expect(hasEvent(ERC20_ABI, "Transfer")).toBe(true);
    expect(hasEvent(ERC20_ABI, "Approval")).toBe(true);
  });

  it("SentryAgentRegistry ABI exposes the entrypoints findSentryAgents needs", () => {
    expect(hasFn(SENTRY_AGENT_REGISTRY_ABI, "agentCount")).toBe(true);
    expect(hasFn(SENTRY_AGENT_REGISTRY_ABI, "agentsPaginated")).toBe(true);
    expect(hasFn(SENTRY_AGENT_REGISTRY_ABI, "getAgent")).toBe(true);
  });
});
