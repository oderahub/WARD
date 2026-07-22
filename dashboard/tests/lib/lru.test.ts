import { describe, it, expect } from "vitest";
import { setWithLruCap, setWithFifoCap } from "../../src/lib/lru";

describe("setWithLruCap", () => {
  it("inserts below cap without evicting any existing entry", () => {
    const m = new Map<string, number>();
    setWithLruCap(m, "a", 100, 4);
    setWithLruCap(m, "b", 200, 4);
    setWithLruCap(m, "c", 300, 4);
    expect(m.size).toBe(3);
    expect(m.get("a")).toBe(100);
    expect(m.get("b")).toBe(200);
    expect(m.get("c")).toBe(300);
  });

  it("evicts the entry with the oldest value when inserting past the cap", () => {
    const m = new Map<string, number>();
    // Insert deliberately out of order so insertion order ≠ value order; the
    // helper must evict by smallest value, not by Map iteration order alone.
    setWithLruCap(m, "old", 10, 3);
    setWithLruCap(m, "mid", 50, 3);
    setWithLruCap(m, "new", 90, 3);
    expect(m.size).toBe(3);

    setWithLruCap(m, "fresh", 100, 3);
    expect(m.size).toBe(3);
    expect(m.has("old")).toBe(false);
    expect(m.get("mid")).toBe(50);
    expect(m.get("new")).toBe(90);
    expect(m.get("fresh")).toBe(100);
  });

  it("evicts by smallest value even when insertion order does not match value order", () => {
    const m = new Map<string, number>();
    setWithLruCap(m, "a", 500, 2);
    setWithLruCap(m, "b", 100, 2);
    // "b" was inserted second but has the smallest value, so it must be evicted.
    setWithLruCap(m, "c", 600, 2);
    expect(m.size).toBe(2);
    expect(m.has("b")).toBe(false);
    expect(m.get("a")).toBe(500);
    expect(m.get("c")).toBe(600);
  });

  it("updating an existing key never evicts and leaves size unchanged", () => {
    const m = new Map<string, number>();
    setWithLruCap(m, "a", 1, 2);
    setWithLruCap(m, "b", 2, 2);
    expect(m.size).toBe(2);

    setWithLruCap(m, "a", 999, 2);
    expect(m.size).toBe(2);
    expect(m.get("a")).toBe(999);
    expect(m.get("b")).toBe(2);
  });

  it("updating an existing key with the smallest value still does not evict it", () => {
    const m = new Map<string, number>();
    setWithLruCap(m, "a", 100, 2);
    setWithLruCap(m, "b", 200, 2);
    // Lowering "a"'s value would, in a naive impl, mark it as evictable on
    // the next insert. Updating an existing key must not trigger eviction.
    setWithLruCap(m, "a", 1, 2);
    expect(m.size).toBe(2);
    expect(m.get("a")).toBe(1);
    expect(m.get("b")).toBe(200);
  });

  it("cap=0 still inserts the new entry (size ends at 1, not 0)", () => {
    const m = new Map<string, number>();
    setWithLruCap(m, "a", 1, 0);
    expect(m.size).toBe(1);
    expect(m.get("a")).toBe(1);

    // A second insert at cap=0 evicts the prior entry and lands the new one.
    setWithLruCap(m, "b", 2, 0);
    expect(m.size).toBe(1);
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toBe(2);
  });

  it("works with non-string keys", () => {
    const m = new Map<number, number>();
    setWithLruCap(m, 1, 10, 2);
    setWithLruCap(m, 2, 20, 2);
    setWithLruCap(m, 3, 30, 2);
    expect(m.size).toBe(2);
    expect(m.has(1)).toBe(false);
    expect(m.get(2)).toBe(20);
    expect(m.get(3)).toBe(30);
  });
});

describe("setWithFifoCap", () => {
  it("inserts below cap without evicting", () => {
    const m = new Map<bigint, bigint>();
    setWithFifoCap(m, 1n, 100n, 3);
    setWithFifoCap(m, 2n, 200n, 3);
    expect(m.size).toBe(2);
    expect(m.get(1n)).toBe(100n);
    expect(m.get(2n)).toBe(200n);
  });

  it("evicts the oldest-inserted key when growing past cap", () => {
    const m = new Map<bigint, bigint>();
    setWithFifoCap(m, 1n, 100n, 3);
    setWithFifoCap(m, 2n, 200n, 3);
    setWithFifoCap(m, 3n, 300n, 3);
    expect(m.size).toBe(3);
    setWithFifoCap(m, 4n, 400n, 3);
    expect(m.size).toBe(3);
    expect(m.has(1n)).toBe(false); // oldest insertion dropped
    expect(m.get(2n)).toBe(200n);
    expect(m.get(3n)).toBe(300n);
    expect(m.get(4n)).toBe(400n);
  });

  it("updating an existing key does not change insertion order", () => {
    const m = new Map<bigint, bigint>();
    setWithFifoCap(m, 1n, 100n, 2);
    setWithFifoCap(m, 2n, 200n, 2);
    // Update key 1 — order should stay [1, 2], so a subsequent insert evicts 1.
    setWithFifoCap(m, 1n, 999n, 2);
    expect(m.get(1n)).toBe(999n);
    setWithFifoCap(m, 3n, 300n, 2);
    expect(m.has(1n)).toBe(false);
    expect(m.get(2n)).toBe(200n);
    expect(m.get(3n)).toBe(300n);
  });

  it("works with bigint keys for blockNumber -> blockTimestamp caching", () => {
    // Canonical use case: cap the recent-block timestamp cache the Cockpit's
    // history panel uses to render relative timestamps without re-fetching
    // getBlock for blocks we've already seen.
    const m = new Map<bigint, bigint>();
    const cap = 4;
    for (let i = 0n; i < 10n; i += 1n) {
      setWithFifoCap(m, i, i * 1000n, cap);
    }
    expect(m.size).toBe(cap);
    // Last 4 inserted (6, 7, 8, 9) should still be present.
    expect(m.has(5n)).toBe(false);
    expect(m.get(6n)).toBe(6000n);
    expect(m.get(7n)).toBe(7000n);
    expect(m.get(8n)).toBe(8000n);
    expect(m.get(9n)).toBe(9000n);
  });

  it("cap=0 inserts the new entry and ends at size 1", () => {
    const m = new Map<bigint, bigint>();
    setWithFifoCap(m, 1n, 100n, 0);
    expect(m.size).toBe(1);
    setWithFifoCap(m, 2n, 200n, 0);
    expect(m.size).toBe(1);
    expect(m.has(1n)).toBe(false);
    expect(m.get(2n)).toBe(200n);
  });
});
