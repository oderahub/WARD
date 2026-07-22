import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchContractAddressViews,
  fetchContractFunctions,
  resolveProxyTarget,
} from "../../src/lib/abi-fetch";

// Mock whatsabi at the module boundary so the helper's filter/tier logic is
// the only thing under test. The SourcifyABILoader constructor records its
// config so we can assert chainId pass-through.
const autoloadMock = vi.fn();
const sourcifyCtorSpy = vi.fn();

vi.mock("@shazow/whatsabi", () => ({
  autoload: (...args: unknown[]) => autoloadMock(...args),
  loaders: {
    SourcifyABILoader: class {
      readonly name = "SourcifyABILoader";
      constructor(config?: { chainId?: number }) {
        sourcifyCtorSpy(config);
      }
    },
    OpenChainSignatureLookup: class {},
  },
}));

const ADDR = "0xA1601891Da4b60c9311B3A024e3E03C5136460e4";
const stubClient = {} as Parameters<typeof fetchContractFunctions>[1]["publicClient"];
const FUJI = 43113;

function verifiedReturn(abi: unknown[]) {
  return {
    address: ADDR,
    abi,
    abiLoadedFrom: { name: "SourcifyABILoader" },
    proxies: [],
    hasCode: true,
  };
}

beforeEach(() => {
  autoloadMock.mockReset();
  sourcifyCtorSpy.mockReset();
});

describe("fetchContractFunctions", () => {
  it("returns FunctionInfo shape with selector, signature, source", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        {
          type: "function",
          name: "bump",
          inputs: [{ type: "uint256" }],
          stateMutability: "nonpayable",
        },
      ]),
    );
    const r = await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("verified");
    expect(r.functions).toHaveLength(1);
    const f = r.functions[0];
    expect(f.signature).toBe("bump(uint256)");
    expect(f.selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(f.stateMutability).toBe("nonpayable");
    expect(f.source).toBe("verified");
  });

  it("filters out view and pure functions", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        { type: "function", name: "balanceOf", inputs: [{ type: "address" }], stateMutability: "view" },
        { type: "function", name: "decimals", inputs: [], stateMutability: "pure" },
        { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], stateMutability: "nonpayable" },
        { type: "event", name: "Transfer", inputs: [] },
      ]),
    );
    const r = await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.functions.map((f) => f.signature)).toEqual(["transfer(address,uint256)"]);
  });

  it("flags payable as VETO_REQUIRED with cap 0", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        { type: "function", name: "deposit", inputs: [], stateMutability: "payable" },
      ]),
    );
    const r = await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.functions[0].suggestedTier).toBe("VETO_REQUIRED");
    expect(r.functions[0].suggestedCapWei).toBe("0");
  });

  it("flags setX, upgrade, pause, withdraw as VETO_REQUIRED", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        { type: "function", name: "setOwner", inputs: [{ type: "address" }], stateMutability: "nonpayable" },
        { type: "function", name: "upgradeTo", inputs: [{ type: "address" }], stateMutability: "nonpayable" },
        { type: "function", name: "pause", inputs: [], stateMutability: "nonpayable" },
        { type: "function", name: "withdraw", inputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
        { type: "function", name: "renounceOwnership", inputs: [], stateMutability: "nonpayable" },
      ]),
    );
    const r = await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.functions) {
      expect(f.suggestedTier).toBe("VETO_REQUIRED");
    }
  });

  it("defaults non-privileged nonpayable functions to IMMEDIATE", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        { type: "function", name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }], stateMutability: "nonpayable" },
        { type: "function", name: "mint", inputs: [{ type: "address" }, { type: "uint256" }], stateMutability: "nonpayable" },
      ]),
    );
    const r = await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.functions) {
      expect(f.suggestedTier).toBe("IMMEDIATE");
      expect(f.suggestedCapWei).toBe("0");
    }
  });

  it("returns {ok:false} when whatsabi throws", async () => {
    autoloadMock.mockRejectedValueOnce(new Error("rpc unreachable"));
    const r = await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: FUJI });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/rpc unreachable/);
  });

  // The /^set[A-Z]/ rule must not gobble functions that merely start with
  // "set" + lowercase (settle, setup-as-noun, etc). Those are domain verbs,
  // not privileged setters, and the policy author shouldn't be nagged with a
  // veto suggestion for them.
  it("does NOT flag settle() as VETO_REQUIRED (setX regex requires UpperCase next char)", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        { type: "function", name: "settle", inputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
      ]),
    );
    const r = await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.functions[0].suggestedTier).toBe("IMMEDIATE");
  });

  it("labels source=bytecode when abi was not loaded from a verified source", async () => {
    autoloadMock.mockResolvedValueOnce({
      address: ADDR,
      abi: [
        { type: "function", name: "bump", inputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
      ],
      // No abiLoadedFrom => recovered from bytecode + sig lookup.
      proxies: [],
      hasCode: true,
    });
    const r = await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("bytecode");
    expect(r.functions[0].source).toBe("bytecode");
  });

  // BUG 2: openchain often returns multiple candidate names for the same
  // 4-byte selector (selector collisions are real — e.g. 0x70a08231 is
  // famously both balanceOf(address) and other lookalikes). whatsabi puts
  // the first hit in `sig` and any extras in `sigAlts`. The helper must
  // expose the full ambiguous set so the UI can render a warning rather
  // than silently picking the first.
  it("surfaces ambiguousCandidates when openchain returns >1 candidates", async () => {
    autoloadMock.mockResolvedValueOnce({
      address: ADDR,
      abi: [
        {
          type: "function",
          name: "transfer",
          selector: "0xa9059cbb",
          inputs: [{ type: "address" }, { type: "uint256" }],
          stateMutability: "nonpayable",
          sig: "transfer(address,uint256)",
          sigAlts: ["many_msg_babbage(bytes1)"],
        },
      ],
      proxies: [],
      hasCode: true,
    });
    const r = await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.functions[0];
    expect(f.ambiguousCandidates).toEqual([
      "transfer(address,uint256)",
      "many_msg_babbage(bytes1)",
    ]);
    // The chosen signature is still the first candidate (whatsabi's pick).
    expect(f.ambiguousCandidates?.[0]).toBe("transfer(address,uint256)");
  });

  // BUG 1: helper used to hardcode chainId 43113, so wallets on any other
  // chain queried the wrong Sourcify shard. The constructor arg must now
  // be whatever opts.chainId is.
  it("passes opts.chainId through to SourcifyABILoader (not hardcoded)", async () => {
    autoloadMock.mockResolvedValueOnce(verifiedReturn([]));
    await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: 8453 });
    expect(sourcifyCtorSpy).toHaveBeenCalledWith({ chainId: 8453 });

    autoloadMock.mockResolvedValueOnce(verifiedReturn([]));
    await fetchContractFunctions(ADDR, { publicClient: stubClient, chainId: 1 });
    expect(sourcifyCtorSpy).toHaveBeenLastCalledWith({ chainId: 1 });
  });
});

// --- proxy detection -----------------------------------------------------

const IMPL = "0x1111111111111111111111111111111111111111";
const PROXY = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC proxy

function padAddrToSlot(addr: string): `0x${string}` {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  return ("0x" + hex.padStart(64, "0")) as `0x${string}`;
}

// Empty 32-byte slot — what an RPC returns when nothing has been written.
const EMPTY_SLOT = ("0x" + "0".repeat(64)) as `0x${string}`;

type ProxyClient = Parameters<typeof resolveProxyTarget>[1];

describe("resolveProxyTarget", () => {
  it("detects EIP-1967 implementation slot", async () => {
    const client = {
      getStorageAt: vi.fn().mockResolvedValueOnce(padAddrToSlot(IMPL)),
      getCode: vi.fn(),
      readContract: vi.fn(),
    } as unknown as ProxyClient;
    const r = await resolveProxyTarget(PROXY, client);
    expect(r.proxyKind).toBe("eip1967");
    expect(r.implementation).toBe(IMPL.toLowerCase());
  });

  it("detects EIP-1167 minimal proxy from bytecode", async () => {
    // 0x363d3d373d3d3d363d73 (10 bytes) + 20-byte impl + 15-byte trailer = 45 bytes
    const trailer = "5af43d82803e903d91602b57fd5bf3";
    const bytecode =
      "0x363d3d373d3d3d363d73" + IMPL.slice(2).toLowerCase() + trailer;
    const client = {
      // Both EIP-1967 slots empty -> fall through to bytecode check.
      getStorageAt: vi.fn().mockResolvedValue(EMPTY_SLOT),
      getCode: vi.fn().mockResolvedValueOnce(bytecode),
      readContract: vi.fn(),
    } as unknown as ProxyClient;
    const r = await resolveProxyTarget(PROXY, client);
    expect(r.proxyKind).toBe("eip1167");
    expect(r.implementation).toBe(IMPL.toLowerCase());
  });

  it("detects beacon proxy (storage + readContract)", async () => {
    const BEACON = "0x2222222222222222222222222222222222222222";
    const client = {
      getStorageAt: vi
        .fn()
        // First call: EIP-1967 impl slot empty.
        .mockResolvedValueOnce(EMPTY_SLOT)
        // Second call: EIP-1967 beacon slot points at the beacon.
        .mockResolvedValueOnce(padAddrToSlot(BEACON)),
      readContract: vi.fn().mockResolvedValueOnce(IMPL),
      getCode: vi.fn(),
    } as unknown as ProxyClient;
    const r = await resolveProxyTarget(PROXY, client);
    expect(r.proxyKind).toBe("beacon");
    expect(r.implementation).toBe(IMPL.toLowerCase());
  });
});

describe("fetchContractAddressViews", () => {
  it("surfaces parameter-less view functions returning a single address", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        {
          type: "function",
          name: "counter",
          inputs: [],
          outputs: [{ type: "address" }],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "router",
          inputs: [],
          outputs: [{ type: "address" }],
          stateMutability: "view",
        },
      ]),
    );
    const r = await fetchContractAddressViews(ADDR, {
      publicClient: stubClient,
      chainId: FUJI,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.views.map((v) => v.name).sort()).toEqual(["counter", "router"]);
    for (const v of r.views) {
      expect(v.selector).toMatch(/^0x[0-9a-f]{8}$/);
      expect(v.source).toBe("verified");
    }
  });

  it("filters out non-view, non-zero-input, and non-single-address functions", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        // Wrong mutability — state-changing.
        {
          type: "function",
          name: "setOwner",
          inputs: [],
          outputs: [{ type: "address" }],
          stateMutability: "nonpayable",
        },
        // Has inputs — not a getter.
        {
          type: "function",
          name: "ownerOf",
          inputs: [{ type: "uint256" }],
          outputs: [{ type: "address" }],
          stateMutability: "view",
        },
        // Multiple outputs.
        {
          type: "function",
          name: "pair",
          inputs: [],
          outputs: [{ type: "address" }, { type: "address" }],
          stateMutability: "view",
        },
        // Wrong return type.
        {
          type: "function",
          name: "balance",
          inputs: [],
          outputs: [{ type: "uint256" }],
          stateMutability: "view",
        },
        // The keeper.
        {
          type: "function",
          name: "router",
          inputs: [],
          outputs: [{ type: "address" }],
          stateMutability: "view",
        },
      ]),
    );
    const r = await fetchContractAddressViews(ADDR, {
      publicClient: stubClient,
      chainId: FUJI,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.views.map((v) => v.name)).toEqual(["router"]);
  });

  it("returns ok:false when whatsabi throws", async () => {
    autoloadMock.mockRejectedValueOnce(new Error("rpc unreachable"));
    const r = await fetchContractAddressViews(ADDR, {
      publicClient: stubClient,
      chainId: FUJI,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/rpc unreachable/);
  });

  it("honors the abort signal after autoload returns", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        {
          type: "function",
          name: "router",
          inputs: [],
          outputs: [{ type: "address" }],
          stateMutability: "view",
        },
      ]),
    );
    const controller = new AbortController();
    controller.abort();
    const r = await fetchContractAddressViews(ADDR, {
      publicClient: stubClient,
      chainId: FUJI,
      signal: controller.signal,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("aborted");
  });

  // ---------------------------------------------------------------------------
  // Bytecode-fallback regression (Codex pre-reviewed mod to the agent-first
  // refactor). Sourcify down → whatsabi falls back to bytecode disassembly →
  // stateMutability + outputs[].type are unavailable, so the strict filter
  // drops every candidate. The fallback probes each parameter-less function
  // via eth_call and keeps the ones returning a 32-byte word with the
  // canonical address-padding shape (upper 12 bytes zero).
  // ---------------------------------------------------------------------------

  function bytecodeReturn(abi: unknown[]) {
    return {
      address: ADDR,
      abi,
      // No abiLoadedFrom → baseSource resolves to "bytecode" branch
      proxies: [],
      hasCode: true,
    };
  }

  it("bytecode fallback: keeps parameter-less functions that eth_call returns address-padded 32 bytes", async () => {
    autoloadMock.mockResolvedValueOnce(
      bytecodeReturn([
        // Bytecode-disassembled: name resolved by openchain, but no outputs / mutability info.
        { type: "function", name: "counter", inputs: [], outputs: [] },
        { type: "function", name: "value", inputs: [], outputs: [] }, // returns uint256
        { type: "function", name: "willRevert", inputs: [], outputs: [] },
      ]),
    );
    const callMock = vi.fn().mockImplementation(({ data }: { data: string }) => {
      // counter() selector = 0x61bc221a — returns address (upper 12 bytes zero)
      if (data === "0x61bc221a") return Promise.resolve({ data: "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
      // value() — returns uint256 with HIGH bytes set (e.g. supply-style number)
      // → fails the upper-12-zero check, correctly rejected. NOTE the heuristic
      // cannot distinguish small uints (0..2^160-1) from addresses; downstream
      // discoverAgentTargets layers a zero-address + RESERVED_TARGETS filter
      // and SourceAgentEntry warns on suspicious names (owner/admin/etc).
      if (data === "0x3fa4f245") return Promise.resolve({ data: "0xffff000000000000000000000000000000000000000000000000000000000000" });
      // willRevert() — reject
      return Promise.reject(new Error("execution reverted"));
    });
    const client = { call: callMock } as unknown as Parameters<typeof fetchContractAddressViews>[1]["publicClient"];

    const r = await fetchContractAddressViews(ADDR, { publicClient: client, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.views.map((v) => v.name)).toEqual(["counter"]);
    expect(r.views[0].selector).toBe("0x61bc221a");
    expect(r.views[0].source).toBe("bytecode");
    // Probe pass made eth_calls (one per candidate).
    expect(callMock).toHaveBeenCalledTimes(3);
  });

  it("bytecode fallback: skipped when verified source returned any matches (no extra eth_calls)", async () => {
    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        {
          type: "function",
          name: "router",
          inputs: [],
          outputs: [{ type: "address" }],
          stateMutability: "view",
        },
      ]),
    );
    const callMock = vi.fn();
    const client = { call: callMock } as unknown as Parameters<typeof fetchContractAddressViews>[1]["publicClient"];

    const r = await fetchContractAddressViews(ADDR, { publicClient: client, chainId: FUJI });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.views.map((v) => v.name)).toEqual(["router"]);
    // No probe pass because views.length > 0 AND source was verified.
    expect(callMock).not.toHaveBeenCalled();
  });

  it("bytecode-via-proxy fallback: probe targets the ORIGINAL pasted address, not the implementation", async () => {
    // EIP-1967 proxy: storage slot returns IMPL. autoload runs against IMPL,
    // but the fallback probe MUST hit the proxy (PROXY) because storage +
    // delegatecall context live at the proxy, not the implementation.
    const proxyStorageClient = {
      getStorageAt: vi.fn().mockResolvedValueOnce(padAddrToSlot(IMPL)),
      getCode: vi.fn(),
      readContract: vi.fn(),
      call: vi.fn().mockResolvedValue({
        data: "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    } as unknown as Parameters<typeof fetchContractAddressViews>[1]["publicClient"];

    autoloadMock.mockResolvedValueOnce(
      bytecodeReturn([
        { type: "function", name: "counter", inputs: [], outputs: [] },
      ]),
    );

    const r = await fetchContractAddressViews(PROXY, { publicClient: proxyStorageClient, chainId: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // autoload was called against IMPL (proxy-aware ABI lookup) ...
    expect(autoloadMock).toHaveBeenCalledWith(IMPL.toLowerCase(), expect.any(Object));
    // ... but the probe eth_call hit PROXY (proxy storage / delegatecall context).
    const callArgs = (proxyStorageClient.call as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.to).toBe(PROXY);
    expect(r.views[0].name).toBe("counter");
    expect(r.views[0].source).toBe("bytecode-via-proxy");
  });
});

describe("fetchContractFunctions with proxy", () => {
  it("scans the implementation when given a proxy and labels source via-proxy", async () => {
    const client = {
      getStorageAt: vi.fn().mockResolvedValueOnce(padAddrToSlot(IMPL)),
      getCode: vi.fn(),
      readContract: vi.fn(),
    } as unknown as Parameters<typeof fetchContractFunctions>[1]["publicClient"];

    autoloadMock.mockResolvedValueOnce(
      verifiedReturn([
        {
          type: "function",
          name: "transfer",
          inputs: [{ type: "address" }, { type: "uint256" }],
          stateMutability: "nonpayable",
        },
      ]),
    );

    const r = await fetchContractFunctions(PROXY, { publicClient: client, chainId: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // autoload was called against the implementation, not the proxy shell.
    expect(autoloadMock).toHaveBeenCalledWith(IMPL.toLowerCase(), expect.any(Object));
    expect(r.source).toBe("verified-via-proxy");
    expect(r.functions[0].source).toBe("verified-via-proxy");
    expect(r.proxyInfo).toEqual({
      kind: "eip1967",
      implementation: IMPL.toLowerCase(),
      original: PROXY,
    });
  });
});
