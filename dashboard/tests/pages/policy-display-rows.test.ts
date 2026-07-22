import { describe, it, expect, vi } from "vitest";
import type { Hex } from "viem";
import type { PolicyMeta } from "@sentry-somnia/sdk";

// `WatchedPage.tsx` indirectly imports `src/main.tsx` (via the
// `useEventStore` hook reaching for the `somniaTestnet` chain export),
// which calls `ReactDOM.createRoot(document.getElementById("root")!)` at
// module-load time. In a Node vitest run with no DOM environment, that
// line throws ReferenceError before any test code runs. Stubbing the
// module here keeps the load side-effect-free so the pure-helper export
// we actually want to test can be imported in isolation.
vi.mock("../../src/main", () => ({
  somniaTestnet: { id: 50312 },
}));

import { mergePolicyDisplayRows } from "../../src/pages/WatchedPage";
import type { OwnerIndexEntry } from "../../src/lib/persistence";

/**
 * Pins the union-merge semantics that drive MY POLICIES. The whole point
 * of this helper is to surface every id the persisted ownerIndex knows
 * about, even when the in-memory EventStore hasn't rehydrated it yet —
 * before this code path, an unrehydrated id silently vanished from the
 * panel and the user saw "2 of 4 policies" with no signal the other 2
 * existed.
 */

const id = (suffix: string): Hex =>
  (`0x${suffix.padStart(64, "0")}` as Hex);

const owner: PolicyMeta["owner"] = "0x000000000000000000000000000000000000beef";

function meta(suffix: string, lastUpdatedBlock: bigint): PolicyMeta {
  return {
    policyId: id(suffix),
    owner,
    label: "0x68656c6c6f000000000000000000000000000000000000000000000000000000" as Hex,
    labelRecovered: true,
    publishedBlock: lastUpdatedBlock - 1n,
    lastUpdatedBlock,
  };
}

function entry(suffix: string, publishedBlock: bigint): OwnerIndexEntry {
  return { policyId: id(suffix), publishedBlock };
}

describe("mergePolicyDisplayRows", () => {
  it("emits loaded rows for in-memory policies, sorted by lastUpdatedBlock desc", () => {
    const inMem = [meta("1", 100n), meta("2", 300n), meta("3", 200n)];
    const rows = mergePolicyDisplayRows(inMem, [], new Set());
    expect(rows.map((r) => r.kind)).toEqual(["loaded", "loaded", "loaded"]);
    const ids = rows.flatMap((r) => (r.kind === "loaded" ? [r.policy.policyId] : []));
    expect(ids).toEqual([id("2"), id("3"), id("1")]);
  });

  it("surfaces ownerIndex-only entries as loading rows so missing rehydrates do not vanish", () => {
    // Reproduces the bug: ownerIndex has 4 ids, EventStore has 2.
    const inMem = [meta("a", 1000n), meta("b", 2000n)];
    const ownerIndex = [
      entry("a", 999n),
      entry("b", 1999n),
      entry("c", 500n),
      entry("d", 600n),
    ];
    const rows = mergePolicyDisplayRows(inMem, ownerIndex, new Set());
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ kind: "loaded" });
    expect(rows[1]).toMatchObject({ kind: "loaded" });
    expect(rows[2]).toMatchObject({ kind: "loading", policyId: id("d") });
    expect(rows[3]).toMatchObject({ kind: "loading", policyId: id("c") });
  });

  it("collapses case variants so a mixed-case id is rendered exactly once", () => {
    const loaded = meta("ab", 100n);
    // Same underlying id with uppercase hex digits in the ownerIndex copy.
    const upperCase = (loaded.policyId.toUpperCase() as Hex).replace(/^0X/, "0x") as Hex;
    const rows = mergePolicyDisplayRows(
      [loaded],
      [{ policyId: upperCase, publishedBlock: 99n }],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("loaded");
  });

  it("marks rows in the failure set as failed instead of loading so we do not auto-retry them", () => {
    const ownerIndex = [entry("c", 500n)];
    const failures = new Set([id("c").toLowerCase()]);
    const rows = mergePolicyDisplayRows([], ownerIndex, failures);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "failed", policyId: id("c") });
  });

  it("places v7 sentinel (publishedBlock=0n) rows last among pending rows", () => {
    // Sentinel means publishedBlock is unknown — those rows must not jump
    // the queue ahead of rows with real blocks.
    const ownerIndex = [
      entry("legacy", 0n),
      entry("recent", 9_000n),
      entry("older", 3_000n),
    ];
    const rows = mergePolicyDisplayRows([], ownerIndex, new Set());
    expect(rows.map((r) => (r.kind === "loading" ? r.policyId : null))).toEqual([
      id("recent"),
      id("older"),
      id("legacy"),
    ]);
  });

  it("returns an empty array when both inputs are empty", () => {
    expect(mergePolicyDisplayRows([], [], new Set())).toEqual([]);
  });

  it("loaded rows always precede pending rows even when pending publishedBlock is higher", () => {
    // A pending row with a recent publishedBlock must NOT outrank a loaded
    // row with an older lastUpdatedBlock — loaded data is always more
    // informative to the user than a "Loading…" placeholder.
    const inMem = [meta("loaded", 50n)];
    const ownerIndex = [entry("pending", 9_000n)];
    const rows = mergePolicyDisplayRows(inMem, ownerIndex, new Set());
    expect(rows[0].kind).toBe("loaded");
    expect(rows[1].kind).toBe("loading");
  });
});
