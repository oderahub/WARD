import { describe, it, expect } from "vitest";
import type { Address, Hex } from "viem";
import {
  compareLogPosition,
  policyCacheKey,
} from "../../src/hooks/useAgentWatcher";

// These two helpers underpin two correctness fixes in useAgentWatcher:
//
//   1. `policyCacheKey` — the policy cache used to be keyed on policyId alone,
//      so the same policyId derived against a different deployment
//      (different chain or different oracle contract) would collide and
//      return the wrong PolicyInput on scope switch. The key now scopes by
//      chainId + oracle address + policyId.
//
//   2. `compareLogPosition` — the fallback policy reconstruction sorts
//      candidate events to pick the most recent state-touch. Sorting on
//      blockNumber alone is non-deterministic for intra-block ties and can
//      decode a stale policy. The comparator extends ordering to
//      (blockNumber, transactionIndex, logIndex).
//
// The hook itself is hard to unit-test (intervals, IndexedDB, RPC), so we
// pin the pure helpers here.

describe("policyCacheKey", () => {
  const oracleA = "0xAAAA000000000000000000000000000000000001" as Address;
  const oracleB = "0xBBBB000000000000000000000000000000000002" as Address;
  const policy1 =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
  const policy2 =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

  it("includes chainId, oracle, and policyId components", () => {
    const key = policyCacheKey(50312, oracleA, policy1);
    expect(key).toContain("50312");
    expect(key).toContain(oracleA.toLowerCase());
    expect(key).toContain(policy1.toLowerCase());
  });

  it("is case-insensitive on the hex inputs", () => {
    const lower = policyCacheKey(
      50312,
      oracleA.toLowerCase() as Address,
      policy1.toLowerCase() as Hex,
    );
    const upper = policyCacheKey(
      50312,
      oracleA.toUpperCase().replace(/^0X/, "0x") as Address,
      policy1.toUpperCase().replace(/^0X/, "0x") as Hex,
    );
    expect(lower).toBe(upper);
  });

  it("distinguishes different chains for the same policyId+oracle", () => {
    const a = policyCacheKey(1, oracleA, policy1);
    const b = policyCacheKey(50312, oracleA, policy1);
    expect(a).not.toBe(b);
  });

  it("distinguishes different oracles for the same chain+policyId", () => {
    const a = policyCacheKey(50312, oracleA, policy1);
    const b = policyCacheKey(50312, oracleB, policy1);
    expect(a).not.toBe(b);
  });

  it("distinguishes different policyIds for the same chain+oracle", () => {
    const a = policyCacheKey(50312, oracleA, policy1);
    const b = policyCacheKey(50312, oracleA, policy2);
    expect(a).not.toBe(b);
  });

  it("does not collide with similarly-shaped strings (component boundaries are unambiguous)", () => {
    // Without a separator, "50312" + "0xabc..." and "5031" + "20xabc..." could
    // collide. The key uses ":" to delimit components, so adjacent
    // chainId/oracle combinations stay distinct.
    const a = policyCacheKey(50312, oracleA, policy1);
    const b = policyCacheKey(5031, ("0x2" + oracleA.slice(2)) as Address, policy1);
    expect(a).not.toBe(b);
  });
});

describe("compareLogPosition", () => {
  // Minimal log shape the comparator reads.
  type L = {
    blockNumber?: bigint | null;
    transactionIndex?: number | null;
    logIndex?: number | null;
    tag?: string;
  };

  it("orders by blockNumber ascending", () => {
    const logs: L[] = [
      { blockNumber: 30n, transactionIndex: 0, logIndex: 0, tag: "c" },
      { blockNumber: 10n, transactionIndex: 0, logIndex: 0, tag: "a" },
      { blockNumber: 20n, transactionIndex: 0, logIndex: 0, tag: "b" },
    ];
    const sorted = [...logs].sort(compareLogPosition);
    expect(sorted.map((l) => l.tag)).toEqual(["a", "b", "c"]);
  });

  it("breaks block ties by transactionIndex ascending", () => {
    const logs: L[] = [
      { blockNumber: 10n, transactionIndex: 5, logIndex: 0, tag: "c" },
      { blockNumber: 10n, transactionIndex: 1, logIndex: 0, tag: "a" },
      { blockNumber: 10n, transactionIndex: 3, logIndex: 0, tag: "b" },
    ];
    const sorted = [...logs].sort(compareLogPosition);
    expect(sorted.map((l) => l.tag)).toEqual(["a", "b", "c"]);
  });

  it("breaks block+tx ties by logIndex ascending", () => {
    const logs: L[] = [
      { blockNumber: 10n, transactionIndex: 2, logIndex: 7, tag: "c" },
      { blockNumber: 10n, transactionIndex: 2, logIndex: 1, tag: "a" },
      { blockNumber: 10n, transactionIndex: 2, logIndex: 4, tag: "b" },
    ];
    const sorted = [...logs].sort(compareLogPosition);
    expect(sorted.map((l) => l.tag)).toEqual(["a", "b", "c"]);
  });

  it("last element is the most recent state-touch within a shared block", () => {
    // The fallback reconstruction takes candidates.at(-1) — pin that contract.
    const logs: L[] = [
      { blockNumber: 100n, transactionIndex: 0, logIndex: 0, tag: "old" },
      { blockNumber: 100n, transactionIndex: 0, logIndex: 1, tag: "newer" },
      { blockNumber: 100n, transactionIndex: 1, logIndex: 0, tag: "newest" },
    ];
    const sorted = [...logs].sort(compareLogPosition);
    expect(sorted[sorted.length - 1]!.tag).toBe("newest");
  });

  it("treats missing tie-break fields as 0 without crashing", () => {
    const logs: L[] = [
      { blockNumber: 10n, tag: "a" },
      { blockNumber: 10n, transactionIndex: 1, tag: "b" },
    ];
    const sorted = [...logs].sort(compareLogPosition);
    expect(sorted.map((l) => l.tag)).toEqual(["a", "b"]);
  });
});
