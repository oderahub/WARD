/**
 * Pure-function tests for discoverAgentTargets. The under-the-hood ABI
 * fetch is mocked at the module boundary so each test only exercises the
 * dedup / classify / filter pipeline, not whatsabi.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Address } from "viem";

const fetchAddressViewsMock = vi.fn();

vi.mock("../../src/lib/abi-fetch", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/abi-fetch")>(
    "../../src/lib/abi-fetch",
  );
  return {
    ...actual,
    fetchContractAddressViews: (...args: unknown[]) => fetchAddressViewsMock(...args),
  };
});

import { discoverAgentTargets } from "../../src/lib/agent-target-discovery";

const AGENT = "0x000000000000000000000000000000000000beef" as Address;
const COUNTER = "0x000000000000000000000000000000000000c0de" as Address;
const ROUTER = "0x000000000000000000000000000000000000aaaa" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

type DiscoverOpts = Parameters<typeof discoverAgentTargets>[1];

function makeClient(
  responses: Record<string, Address | Error>,
): DiscoverOpts["publicClient"] {
  return {
    chain: { id: 50312 },
    readContract: vi.fn().mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        const r = responses[functionName];
        if (r === undefined) throw new Error("unmocked fn " + functionName);
        if (r instanceof Error) throw r;
        return r;
      },
    ),
  } as unknown as DiscoverOpts["publicClient"];
}

function viewsOk(views: Array<{ name: string; selector?: `0x${string}` }>) {
  return {
    ok: true as const,
    source: "verified" as const,
    views: views.map((v) => ({
      name: v.name,
      selector: v.selector ?? ("0x12345678" as `0x${string}`),
      source: "verified" as const,
    })),
  };
}

beforeEach(() => {
  fetchAddressViewsMock.mockReset();
});

describe("discoverAgentTargets", () => {
  it("returns ok+empty when the agent ABI has no address-returning views", async () => {
    fetchAddressViewsMock.mockResolvedValueOnce(viewsOk([]));
    const client = makeClient({});
    const r = await discoverAgentTargets(AGENT, { publicClient: client, chainId: 50312 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("propagates abi-fetch failure as { ok: false }", async () => {
    fetchAddressViewsMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    const client = makeClient({});
    const r = await discoverAgentTargets(AGENT, { publicClient: client, chainId: 50312 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("boom");
  });

  it("surfaces a single target from counter()", async () => {
    fetchAddressViewsMock.mockResolvedValueOnce(viewsOk([{ name: "counter" }]));
    const client = makeClient({ counter: COUNTER });
    const r = await discoverAgentTargets(AGENT, { publicClient: client, chainId: 50312 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].address).toBe(COUNTER.toLowerCase());
    expect(r.targets[0].sourceViewNames).toEqual(["counter"]);
    expect(r.targets[0].suspicious).toBe(false);
  });

  it("filters out the zero address (uninitialized slot)", async () => {
    fetchAddressViewsMock.mockResolvedValueOnce(
      viewsOk([{ name: "counter" }, { name: "router" }]),
    );
    const client = makeClient({ counter: ZERO, router: ROUTER });
    const r = await discoverAgentTargets(AGENT, { publicClient: client, chainId: 50312 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].address).toBe(ROUTER.toLowerCase());
  });

  it("filters out a self-referencing target (agent === returned address)", async () => {
    fetchAddressViewsMock.mockResolvedValueOnce(
      viewsOk([{ name: "self" }, { name: "router" }]),
    );
    const client = makeClient({ self: AGENT, router: ROUTER });
    const r = await discoverAgentTargets(AGENT, { publicClient: client, chainId: 50312 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].address).toBe(ROUTER.toLowerCase());
  });

  it("filters out RESERVED_TARGETS (oracle/queue addresses)", async () => {
    // Pick an oracle from the live NETWORKS map by importing the same set
    // policy-draft uses, so this test stays correct if the address changes.
    const { RESERVED_TARGETS } = await import("../../src/lib/policy-draft");
    const reserved = Array.from(RESERVED_TARGETS).find(
      (a) => !/^0x0+1?$/i.test(a),
    ) as Address;
    fetchAddressViewsMock.mockResolvedValueOnce(
      viewsOk([{ name: "oracle" }, { name: "router" }]),
    );
    const client = makeClient({ oracle: reserved, router: ROUTER });
    const r = await discoverAgentTargets(AGENT, { publicClient: client, chainId: 50312 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets.map((t) => t.address)).toEqual([ROUTER.toLowerCase()]);
  });

  it("dedupes by lowercase address and preserves every source view name", async () => {
    fetchAddressViewsMock.mockResolvedValueOnce(
      viewsOk([{ name: "router" }, { name: "weth" }]),
    );
    const client = makeClient({ router: ROUTER, weth: ROUTER });
    const r = await discoverAgentTargets(AGENT, { publicClient: client, chainId: 50312 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].sourceViewNames.sort()).toEqual(["router", "weth"]);
  });

  it("tolerates per-view reverts and records them as warnings", async () => {
    fetchAddressViewsMock.mockResolvedValueOnce(
      viewsOk([{ name: "router" }, { name: "factory" }]),
    );
    const client = makeClient({
      router: ROUTER,
      factory: new Error("factory() reverted"),
    });
    const r = await discoverAgentTargets(AGENT, { publicClient: client, chainId: 50312 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].address).toBe(ROUTER.toLowerCase());
    expect(r.warnings.some((w) => w.includes("factory()"))).toBe(true);
  });

  it("tags targets resolved from suspicious view names (owner/admin/etc.)", async () => {
    fetchAddressViewsMock.mockResolvedValueOnce(
      viewsOk([{ name: "owner" }, { name: "router" }]),
    );
    const client = makeClient({ owner: COUNTER, router: ROUTER });
    const r = await discoverAgentTargets(AGENT, { publicClient: client, chainId: 50312 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ownerTarget = r.targets.find((t) => t.sourceViewNames.includes("owner"));
    expect(ownerTarget?.suspicious).toBe(true);
    const routerTarget = r.targets.find((t) => t.sourceViewNames.includes("router"));
    expect(routerTarget?.suspicious).toBe(false);
  });

  it("returns ok:false with 'aborted' when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = makeClient({});
    const r = await discoverAgentTargets(AGENT, {
      publicClient: client,
      chainId: 50312,
      signal: controller.signal,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("aborted");
    expect(fetchAddressViewsMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with 'aborted' when the signal fires mid-flight", async () => {
    fetchAddressViewsMock.mockImplementationOnce(async () => {
      controller.abort();
      return viewsOk([{ name: "router" }]);
    });
    const controller = new AbortController();
    const client = makeClient({ router: ROUTER });
    const r = await discoverAgentTargets(AGENT, {
      publicClient: client,
      chainId: 50312,
      signal: controller.signal,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("aborted");
  });
});
