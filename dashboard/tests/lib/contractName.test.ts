import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import type { Address } from "viem";

import {
  resolveContractName,
  __resetContractNameInflightForTests,
} from "../../src/lib/contractName";
import {
  loadContractName,
  saveContractName,
} from "../../src/lib/persistence";

const DB_NAME = "ward-store";
const CHAIN_ID = 43113;
const EXPLORER = "https://testnet.snowtrace.io";

// WardOracle (v2) from the local map — one of the small set of Ward-
// canonical addresses that resolve synchronously without an explorer hit.
const LOCAL_ADDR = "0x3C7bF90f243d670a01f512221d9546e09fEaCC9c" as Address;
const LOCAL_NAME = "WardOracle";
// Random unverified-shaped address not in LOCAL.
const UNKNOWN_ADDR = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const UNKNOWN_ADDR_UPPER = "0x1234567890ABCDEF1234567890ABCDEF12345678" as Address;

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
  // Inflight-promise dedupe is module-level; clear it between tests so a
  // hung promise from one test cannot bleed into the next.
  __resetContractNameInflightForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function mockFetchOnce(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
) {
  const spy = vi.fn(impl) as unknown as typeof fetch;
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("resolveContractName", () => {
  it("local-map hit returns immediately, no fetch invoked", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: LOCAL_ADDR,
      explorerApiUrl: EXPLORER,
    });

    expect(rec.name).toBe(LOCAL_NAME);
    expect(rec.source).toBe("local");
    expect(rec.verified).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("IDB cache hit within 24h returns cached result without hitting network", async () => {
    await saveContractName(CHAIN_ID, UNKNOWN_ADDR, {
      name: "CachedThing",
      verified: true,
      source: "explorer",
      fetchedAtMs: Date.now() - 60_000,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });

    expect(rec.name).toBe("CachedThing");
    expect(rec.source).toBe("explorer");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("IDB cache stale (>24h) falls back to explorer and refreshes the cache", async () => {
    await saveContractName(CHAIN_ID, UNKNOWN_ADDR, {
      name: "Old",
      verified: true,
      source: "explorer",
      fetchedAtMs: Date.now() - 25 * 60 * 60 * 1000,
    });
    mockFetchOnce(async () =>
      new Response(
        JSON.stringify({
          message: "OK",
          result: [{ ContractName: "Fresh", SourceCode: "contract Fresh {}" }],
          status: "1",
        }),
        { status: 200 },
      ),
    );

    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });

    expect(rec.name).toBe("Fresh");
    expect(rec.source).toBe("explorer");
    expect(rec.verified).toBe(true);
  });

  it("IDB cache miss + explorer success caches the result", async () => {
    const fetchSpy = mockFetchOnce(async () =>
      new Response(
        JSON.stringify({
          message: "OK",
          result: [{ ContractName: "DiscoveredVault", SourceCode: "contract X {}" }],
          status: "1",
        }),
        { status: 200 },
      ),
    );

    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });

    expect(rec.name).toBe("DiscoveredVault");
    expect(rec.source).toBe("explorer");
    expect(rec.verified).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const cached = await loadContractName(CHAIN_ID, UNKNOWN_ADDR);
    expect(cached).not.toBeNull();
    expect(cached!.name).toBe("DiscoveredVault");
  });

  it("explorer 404 returns source=unknown and writes a negative cache entry", async () => {
    mockFetchOnce(async () => new Response("not found", { status: 404 }));

    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });

    expect(rec.name).toBeNull();
    expect(rec.source).toBe("unknown");
    expect(rec.verified).toBe(false);
    // Negative caching: we persist the unknown so re-renders don't spam the
    // explorer. The 1h TTL (see negative-cache test below) means the lookup
    // re-attempts within an hour.
    const cached = await loadContractName(CHAIN_ID, UNKNOWN_ADDR);
    expect(cached).not.toBeNull();
    expect(cached!.name).toBeNull();
    expect(cached!.source).toBe("unknown");
  });

  it("explorer returns empty ContractName (unverified) -> unknown, negative-cached", async () => {
    // Mirrors the actual Fuji Blockscout response shape for unverified
    // contracts: 200 OK with result[0] but no ContractName field.
    mockFetchOnce(async () =>
      new Response(
        JSON.stringify({
          message: "OK",
          result: [{ Address: UNKNOWN_ADDR }],
          status: "1",
        }),
        { status: 200 },
      ),
    );

    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });

    expect(rec.name).toBeNull();
    expect(rec.source).toBe("unknown");
    const cached = await loadContractName(CHAIN_ID, UNKNOWN_ADDR);
    expect(cached).not.toBeNull();
    expect(cached!.name).toBeNull();
  });

  it("explorer timeout / network error returns source=unknown, negative-cached", async () => {
    mockFetchOnce(async () => {
      throw new Error("network down");
    });

    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });

    expect(rec.name).toBeNull();
    expect(rec.source).toBe("unknown");
    const cached = await loadContractName(CHAIN_ID, UNKNOWN_ADDR);
    expect(cached).not.toBeNull();
    expect(cached!.name).toBeNull();
  });

  it("no explorerApiUrl skips the network and returns unknown for non-local addresses", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
    });

    expect(rec.source).toBe("unknown");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("privacy gate: missing explorerApiUrl skips fetch AND skips negative-cache write", async () => {
    // When the user has not opted into ?explorerNames=1, AddressChip passes
    // explorerApiUrl=undefined. We must NOT poison the cache with a negative
    // entry in that case — otherwise the first lookup after they flip the
    // flag within the 1h TTL would be suppressed.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
    });

    expect(rec.source).toBe("unknown");
    expect(fetchSpy).not.toHaveBeenCalled();
    const cached = await loadContractName(CHAIN_ID, UNKNOWN_ADDR);
    expect(cached).toBeNull();
  });

  it("dedupe: concurrent calls for the same address share one in-flight fetch", async () => {
    // Latch so we can hold the single fetch open while three concurrent
    // callers pile up behind the dedupe map. We resolve the latch only
    // AFTER confirming exactly one fetch was issued.
    let release: ((value: Response) => void) | undefined;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const p1 = resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });
    const p2 = resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });
    const p3 = resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });

    // Wait for fetch to actually be invoked. The resolver awaits IDB
    // (fake-indexeddb schedules via setTimeout, a macrotask) before
    // touching the network, so we need to yield through the macrotask queue
    // until the fetch spy fires and captures `release`. Bail out after 50
    // ticks (~100ms) to avoid hanging if the dedupe is broken.
    for (let i = 0; i < 50 && !release; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(release).toBeDefined();

    release!(
      new Response(
        JSON.stringify({
          message: "OK",
          result: [{ ContractName: "Deduped", SourceCode: "contract X {}" }],
          status: "1",
        }),
        { status: 200 },
      ),
    );

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // All three callers see the same value...
    expect(r1.name).toBe("Deduped");
    expect(r2.name).toBe("Deduped");
    expect(r3.name).toBe("Deduped");
    // ...but only ONE network call fired.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("dedupe by explorer settings: concurrent calls with different explorerApiUrl values do NOT share a promise", async () => {
    // If the in-flight key ignored explorerApiUrl, the second (opt-in) caller
    // would attach to the first (no-explorer) promise and never fire the
    // fetch — briefly suppressing the explorer lookup right after the user
    // flipped ?explorerNames=1. The dedupe key includes explorerApiUrl so
    // each caller gets the correct path.
    let release: ((value: Response) => void) | undefined;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // First caller: no explorer (privacy gate off). Should NOT fetch.
    const pNoExplorer = resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
    });
    // Second caller: opt-in. Must fire its own fetch, not reuse the
    // no-explorer promise.
    const pWithExplorer = resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });

    // Wait for the opt-in caller to actually issue the fetch. IDB schedules
    // via setTimeout (macrotask), so yield until the spy captures `release`.
    for (let i = 0; i < 50 && !release; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(release).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    release!(
      new Response(
        JSON.stringify({
          message: "OK",
          result: [{ ContractName: "OptInOnly", SourceCode: "contract X {}" }],
          status: "1",
        }),
        { status: 200 },
      ),
    );

    const [rNoExplorer, rWithExplorer] = await Promise.all([
      pNoExplorer,
      pWithExplorer,
    ]);
    // No-explorer caller stays unknown (privacy gate); opt-in caller resolves
    // to the name the explorer returned.
    expect(rNoExplorer.source).toBe("unknown");
    expect(rNoExplorer.name).toBeNull();
    expect(rWithExplorer.name).toBe("OptInOnly");
    expect(rWithExplorer.source).toBe("explorer");
  });

  it("dedupe: in-flight map is cleared after settle so the next call re-resolves", async () => {
    // First call: positive hit, populates IDB.
    const fetchSpy = mockFetchOnce(async () =>
      new Response(
        JSON.stringify({
          message: "OK",
          result: [{ ContractName: "First", SourceCode: "contract X {}" }],
          status: "1",
        }),
        { status: 200 },
      ),
    );
    await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call should hit the IDB cache (not the deduped in-flight
    // promise — that's already settled and removed). No additional fetch.
    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });
    expect(rec.name).toBe("First");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("negative cache: unknown result honored for <1h, re-fetched after >1h", async () => {
    // Seed a negative cache entry 30 minutes old — should be honored, no fetch.
    await saveContractName(CHAIN_ID, UNKNOWN_ADDR, {
      name: null,
      verified: false,
      source: "unknown",
      fetchedAtMs: Date.now() - 30 * 60 * 1000,
    });
    const freshFetch = vi.fn();
    vi.stubGlobal("fetch", freshFetch);
    const rec1 = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });
    expect(rec1.name).toBeNull();
    expect(rec1.source).toBe("unknown");
    expect(freshFetch).not.toHaveBeenCalled();

    // Now seed a 2h-old negative entry — should be ignored (TTL is 1h) and
    // we should re-attempt the explorer.
    await saveContractName(CHAIN_ID, UNKNOWN_ADDR, {
      name: null,
      verified: false,
      source: "unknown",
      fetchedAtMs: Date.now() - 2 * 60 * 60 * 1000,
    });
    const refetchSpy = mockFetchOnce(async () =>
      new Response(
        JSON.stringify({
          message: "OK",
          result: [{ ContractName: "NowVerified", SourceCode: "contract X {}" }],
          status: "1",
        }),
        { status: 200 },
      ),
    );
    const rec2 = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });
    expect(rec2.name).toBe("NowVerified");
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });

  it("positive cache: honored well past the 1h negative TTL (uses 24h positive TTL)", async () => {
    // A 2h-old POSITIVE entry must NOT be evicted by the negative TTL.
    await saveContractName(CHAIN_ID, UNKNOWN_ADDR, {
      name: "StillFresh",
      verified: true,
      source: "explorer",
      fetchedAtMs: Date.now() - 2 * 60 * 60 * 1000,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR,
      explorerApiUrl: EXPLORER,
    });
    expect(rec.name).toBe("StillFresh");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("local-map and IDB lookups are case-insensitive on address", async () => {
    // local-map hit via uppercase address
    const local = await resolveContractName({
      chainId: CHAIN_ID,
      address: LOCAL_ADDR.toUpperCase() as Address,
    });
    expect(local.source).toBe("local");
    expect(local.name).toBe(LOCAL_NAME);

    // IDB lookup via uppercase address should hit a record saved under
    // lowercase.
    await saveContractName(CHAIN_ID, UNKNOWN_ADDR, {
      name: "CaseTest",
      verified: true,
      source: "explorer",
      fetchedAtMs: Date.now(),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const rec = await resolveContractName({
      chainId: CHAIN_ID,
      address: UNKNOWN_ADDR_UPPER,
      explorerApiUrl: EXPLORER,
    });
    expect(rec.name).toBe("CaseTest");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
