import { describe, it, expect, vi } from "vitest";
import type { Address, Hex, PublicClient } from "viem";

const ACTIVE_CHAIN_ID = 43113;
// All-lowercase address — viem.isAddress accepts uniform-case forms
// without a checksum challenge.
const AGENT = "0x000000000000000000000000000000000000beef" as Address;
const REGISTRY = "0x97F743A9AAa5AcAA73075C1B8F1921274755CF70" as Address;

// `discoverAgent` refuses to run against a network with no deployed
// WardAgentRegistry, which is the real state of Avalanche until one is
// deployed. Pin a configured network here so these tests exercise discovery
// itself rather than that (separately correct) precondition.
vi.mock("../../src/lib/networks", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/lib/networks")>("../../src/lib/networks");
  const configured = {
    ...actual.NETWORKS[ACTIVE_CHAIN_ID],
    oracleAddress: "0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf" as Address,
    queueAddress: "0x2222222222222222222222222222222222222222" as Address,
    registryAddress: REGISTRY,
  };
  return {
    ...actual,
    NETWORKS: { ...actual.NETWORKS, [ACTIVE_CHAIN_ID]: configured },
    getNetwork: (chainId: number) =>
      chainId === ACTIVE_CHAIN_ID ? configured : actual.getNetwork(chainId),
    getActiveNetwork: () => configured,
  };
});

const { discoverAgent } = await import("../../src/lib/discovery");
const ORACLE = "0x68d4B045B24F8d1012974b9d34684cA5aeD11DDf" as Address;
const REGISTRAR = "0x1111111111111111111111111111111111111111" as Address;
const POLICY_ID = ("0x" + "ab".repeat(32)) as Hex;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_POLICY = ("0x" + "00".repeat(32)) as Hex;

interface ClientOpts {
  /** Bytecode returned by getCode. '0x' = EOA. */
  code?: string;
  /** Tx-count returned by getTransactionCount. */
  nonce?: number;
  /** Balance returned by getBalance. */
  balance?: bigint;
  /** Head block returned by getBlockNumber. If omitted, throws (skips Ward-aware probes). */
  headBlock?: bigint;
  /** Per-functionName behaviour for readContract. */
  readContract?: (args: { functionName: string; args?: readonly unknown[] }) => unknown;
  /** getLogs implementation; receives the args including `address`. */
  getLogs?: (args: { address: Address }) => unknown[];
}

function makeClient(opts: ClientOpts): PublicClient {
  const client = {
    chain: { id: ACTIVE_CHAIN_ID },
    getCode: vi.fn(async () => opts.code ?? "0x"),
    getTransactionCount: vi.fn(async () => opts.nonce ?? 0),
    getBalance: vi.fn(async () => opts.balance ?? 0n),
    getBlockNumber: vi.fn(async () => {
      if (opts.headBlock === undefined) throw new Error("head fetch failed");
      return opts.headBlock;
    }),
    getLogs: vi.fn(async (args: { address: Address }) =>
      opts.getLogs ? opts.getLogs(args) : [],
    ),
    readContract: vi.fn(async (args: { functionName: string; args?: readonly unknown[] }) => {
      if (opts.readContract) return opts.readContract(args);
      throw new Error("readContract not configured");
    }),
  } as unknown as PublicClient;
  return client;
}

describe("discoverAgent", () => {
  it("classifies an EOA with nonce 0 and reports wardAware=false", async () => {
    const client = makeClient({
      code: "0x",
      nonce: 0,
      balance: 0n,
      headBlock: 1000n,
      // Empty registry row.
      readContract: ({ functionName }) => {
        if (functionName === "getAgent") {
          return {
            agent: ZERO_ADDRESS,
            registrar: ZERO_ADDRESS,
            oracle: ZERO_ADDRESS,
            policyId: ZERO_POLICY,
            name: "",
            metadataURI: "",
            tags: [] as readonly string[],
            updatedAt: 0n,
            active: false,
          };
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      getLogs: () => [],
    });

    const report = await discoverAgent({ publicClient: client, address: AGENT });

    expect(report.kind).toBe("eoa");
    expect(report.hasCode).toBe(false);
    expect(report.codeSize).toBe(0);
    expect(report.nonce).toBe(0);
    expect(report.tokenFingerprint).toBeNull();
    expect(report.wardAware.wardAware).toBe(false);
    expect(report.alreadyRegistered.registered).toBe(false);
    expect(report.rpcCallsUsed).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
  });

  it("classifies an ERC20 from supportsInterface=revert + symbol + decimals", async () => {
    const client = makeClient({
      code: "0x6080604052",
      nonce: 1,
      balance: 0n,
      headBlock: 1000n,
      readContract: ({ functionName, args }) => {
        if (functionName === "supportsInterface") {
          // ERC-721 interface probe — ERC-20 reverts because it has no ERC-165.
          throw new Error("execution reverted");
        }
        if (functionName === "symbol") return "TEST";
        if (functionName === "decimals") return 18;
        if (functionName === "getAgent") {
          return {
            agent: ZERO_ADDRESS,
            registrar: ZERO_ADDRESS,
            oracle: ZERO_ADDRESS,
            policyId: ZERO_POLICY,
            name: "",
            metadataURI: "",
            tags: [] as readonly string[],
            updatedAt: 0n,
            active: false,
          };
        }
        throw new Error(`unexpected readContract: ${functionName} ${JSON.stringify(args)}`);
      },
      getLogs: () => [],
    });

    const report = await discoverAgent({ publicClient: client, address: AGENT });

    expect(report.kind).toBe("erc20");
    expect(report.hasCode).toBe(true);
    expect(report.tokenFingerprint).toMatchObject({
      symbol: "TEST",
      decimals: 18,
      supports721: false,
    });
    expect(report.rpcCallsUsed).toBeGreaterThan(0);
    // supportsInterface revert is structural (no-code path) for an EOA;
    // for a contract with code it COULD surface as an error. The probe
    // suppresses synthetic "no-code" rejections but a real revert lands
    // in errors[] — assert we did not throw and that errors trail is well-formed.
    for (const err of report.errors) {
      expect(typeof err.probe).toBe("string");
      expect(typeof err.message).toBe("string");
    }
  });

  it("detects a Ward-aware registry hit via getLogs + populates the canonical row from getAgent", async () => {
    const registeredRow = {
      agent: AGENT,
      registrar: REGISTRAR,
      oracle: ORACLE,
      policyId: POLICY_ID,
      name: "live-agent",
      metadataURI: "ipfs://x",
      tags: ["alpha"] as readonly string[],
      updatedAt: 12345n,
      active: true,
    };

    const client = makeClient({
      code: "0x6080604052",
      nonce: 5,
      balance: 10n,
      headBlock: 5000n,
      readContract: ({ functionName }) => {
        if (functionName === "supportsInterface") {
          throw new Error("not ERC-165");
        }
        if (functionName === "symbol") throw new Error("not ERC-20");
        if (functionName === "decimals") throw new Error("not ERC-20");
        if (functionName === "getAgent") return registeredRow;
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      getLogs: ({ address }) => {
        if (address === REGISTRY) {
          // Only return a hit on registry getLogs; queue probe gets [].
          return [
            {
              args: {
                agent: AGENT,
                registrar: REGISTRAR,
                oracle: ORACLE,
                policyId: POLICY_ID,
                name: "live-agent",
                metadataURI: "ipfs://x",
                tags: ["alpha"] as readonly string[],
              },
              blockNumber: 4999n,
            },
          ];
        }
        return [];
      },
    });

    const report = await discoverAgent({ publicClient: client, address: AGENT });

    expect(report.wardAware.wardAware).toBe(true);
    if (report.wardAware.wardAware) {
      expect(report.wardAware.evidence.kind).toBe("registry");
      if (report.wardAware.evidence.kind === "registry") {
        expect(report.wardAware.evidence.policyId).toBe(POLICY_ID);
        expect(report.wardAware.evidence.oracle).toBe(ORACLE);
      }
    }
    expect(report.alreadyRegistered.registered).toBe(true);
    if (report.alreadyRegistered.registered) {
      expect(report.alreadyRegistered.entry.policyId).toBe(POLICY_ID);
      expect(report.alreadyRegistered.entry.active).toBe(true);
    }
    expect(report.rpcCallsUsed).toBeGreaterThan(0);
  });

  it("never throws on probe failure — failures accumulate in warnings[] and errors[]", async () => {
    // Every probe fails (or returns empty); discoverAgent must still produce
    // a Report with warnings populated.
    const client = makeClient({
      code: "0x6080604052",
      nonce: 1,
      balance: 0n,
      headBlock: 1000n,
      readContract: ({ functionName }) => {
        if (functionName === "supportsInterface") throw new Error("revert: probe failure");
        if (functionName === "symbol") throw new Error("revert: probe failure");
        if (functionName === "decimals") throw new Error("revert: probe failure");
        if (functionName === "getAgent") throw new Error("rpc-down: getAgent");
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      getLogs: () => {
        throw new Error("rpc-down: getLogs");
      },
    });

    const report = await discoverAgent({ publicClient: client, address: AGENT });

    // No throw, real report.
    expect(report.agent).toBeDefined();
    expect(report.kind).toBe("unknown-contract");
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.errors.length).toBeGreaterThan(0);
    // getAgent failure must be surfaced.
    expect(report.errors.some((e) => e.probe === "registry-getAgent")).toBe(true);
    expect(report.rpcCallsUsed).toBeGreaterThan(0);
  });

  it("late-binding: surfaces POLICY_ID when the view returns non-zero", async () => {
    const client = makeClient({
      code: "0x6080604052",
      nonce: 1,
      balance: 0n,
      headBlock: 1000n,
      readContract: ({ functionName }) => {
        if (functionName === "supportsInterface") throw new Error("not ERC-165");
        if (functionName === "symbol") throw new Error("not ERC-20");
        if (functionName === "decimals") throw new Error("not ERC-20");
        if (functionName === "POLICY_ID") return POLICY_ID;
        if (functionName === "getAgent") {
          return {
            agent: ZERO_ADDRESS,
            registrar: ZERO_ADDRESS,
            oracle: ZERO_ADDRESS,
            policyId: ZERO_POLICY,
            name: "",
            metadataURI: "",
            tags: [] as readonly string[],
            updatedAt: 0n,
            active: false,
          };
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      getLogs: () => [],
    });

    const report = await discoverAgent({ publicClient: client, address: AGENT });
    expect(report.lateBinding).not.toBeNull();
    if (report.lateBinding) {
      expect(report.lateBinding.exposed).toBe(true);
      expect(report.lateBinding.policyId).toBe(POLICY_ID);
    }
  });

  it("late-binding: surfaces zero policyId as the ungated state (still exposed=true)", async () => {
    const client = makeClient({
      code: "0x6080604052",
      nonce: 1,
      balance: 0n,
      headBlock: 1000n,
      readContract: ({ functionName }) => {
        if (functionName === "supportsInterface") throw new Error("not ERC-165");
        if (functionName === "symbol") throw new Error("not ERC-20");
        if (functionName === "decimals") throw new Error("not ERC-20");
        if (functionName === "POLICY_ID") return ZERO_POLICY;
        if (functionName === "getAgent") {
          return {
            agent: ZERO_ADDRESS,
            registrar: ZERO_ADDRESS,
            oracle: ZERO_ADDRESS,
            policyId: ZERO_POLICY,
            name: "",
            metadataURI: "",
            tags: [] as readonly string[],
            updatedAt: 0n,
            active: false,
          };
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      getLogs: () => [],
    });

    const report = await discoverAgent({ publicClient: client, address: AGENT });
    expect(report.lateBinding).not.toBeNull();
    if (report.lateBinding) {
      expect(report.lateBinding.policyId).toBe(ZERO_POLICY);
    }
  });

  it("late-binding: null when POLICY_ID() reverts (agent isn't a late-binding agent)", async () => {
    const client = makeClient({
      code: "0x6080604052",
      nonce: 1,
      balance: 0n,
      headBlock: 1000n,
      readContract: ({ functionName }) => {
        if (functionName === "supportsInterface") throw new Error("not ERC-165");
        if (functionName === "symbol") throw new Error("not ERC-20");
        if (functionName === "decimals") throw new Error("not ERC-20");
        if (functionName === "POLICY_ID") throw new Error("execution reverted");
        if (functionName === "getAgent") {
          return {
            agent: ZERO_ADDRESS,
            registrar: ZERO_ADDRESS,
            oracle: ZERO_ADDRESS,
            policyId: ZERO_POLICY,
            name: "",
            metadataURI: "",
            tags: [] as readonly string[],
            updatedAt: 0n,
            active: false,
          };
        }
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      getLogs: () => [],
    });

    const report = await discoverAgent({ publicClient: client, address: AGENT });
    expect(report.lateBinding).toBeNull();
    // Probe revert is NOT a probe error — surfaces nothing in errors[].
    expect(report.errors.some((e) => e.probe === "registry-getAgent")).toBe(false);
  });

  it("throws on wrong chain (programmer-error guard, NOT a runtime fallback)", async () => {
    const wrongChain = {
      chain: { id: 1 },
      getCode: vi.fn(),
      getTransactionCount: vi.fn(),
      getBalance: vi.fn(),
      getBlockNumber: vi.fn(),
      getLogs: vi.fn(),
      readContract: vi.fn(),
    } as unknown as PublicClient;

    await expect(
      discoverAgent({ publicClient: wrongChain, address: AGENT }),
    ).rejects.toThrow(/chain mismatch/);
  });
});
