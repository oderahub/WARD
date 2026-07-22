import { describe, it, expect, vi } from "vitest";

// `useEventStore.tsx` transitively imports `src/main.tsx`, which calls
// `ReactDOM.createRoot(document.getElementById("root")!)` at module-load
// time. In a Node vitest run with no DOM environment, that throws
// ReferenceError before any test code runs. The same stub used by
// `tests/pages/policy-display-rows.test.ts` keeps the import side-effect-
// free so the constant export below is reachable in isolation.
vi.mock("../../src/main", () => ({
  avalancheFuji: { id: 43113 },
}));

import { APPROX_24H_BLOCKS, APPROX_30D_BLOCKS } from "../../src/hooks/useEventStore";

/**
 * Pins the size of the "Skip — last 24 hours" cold-start window. The
 * value matters because Fuji (the L2 this dashboard targets) is
 * younger than 30 days at the time of writing — the prior
 * `APPROX_30D_BLOCKS = 5_200_000n` window was larger than chain head,
 * so `head - skip` clamped back to ORACLE_DEPLOYMENT_BLOCK inside
 * `refreshOwnerIndexShallow` and Skip silently turned into a full
 * re-scan. A 24-hour window at Fuji's 0.5s block time
 * (24 × 3600 ÷ 0.5 = 172_800 blocks) fits comfortably inside the live
 * chain history, so the Skip optimization actually shortens the scan.
 */
describe("useEventStore — skip-window constants", () => {
  it("APPROX_24H_BLOCKS encodes 24h at Fuji's 0.5s block time", () => {
    expect(APPROX_24H_BLOCKS).toBe(172_800n);
  });

  it("APPROX_24H_BLOCKS is small enough to fit inside Fuji's current ~57h history (~5M blocks)", () => {
    // Sanity check the value is well below the observed head distance
    // (5_000_000n) so `head - APPROX_24H_BLOCKS` lands strictly above
    // ORACLE_DEPLOYMENT_BLOCK and Skip actually shortens the scan.
    expect(APPROX_24H_BLOCKS).toBeLessThan(5_000_000n);
  });

  it("APPROX_30D_BLOCKS is still exported for forward-compat", () => {
    // Kept available so a future Skip variant can anchor on it once
    // Fuji has >30 days of history, but no longer drives the Skip
    // button (see the constant's doc comment in useEventStore.tsx).
    expect(APPROX_30D_BLOCKS).toBe(5_200_000n);
  });
});
