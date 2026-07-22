import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { preflightCmd } from "../src/cmd/preflight.js";

// We never want to make a real network call in unit tests. Stub viem's public
// client by intercepting the `publicClient` factory in env.ts via a vi.mock.
vi.mock("../src/lib/env.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/env.js")>("../src/lib/env.js");
  return {
    ...actual,
    publicClient: (_rpc?: string) => ({
      getChainId: async () => (globalThis as any).__MOCK_CHAIN_ID__ ?? 50312,
      getBalance: async (_args: { address: string }) =>
        (globalThis as any).__MOCK_BALANCE__ ?? 1_000_000_000_000_000_000n, // 1 STT
    }),
  };
});

const VALID_PK = ("0x" + "11".repeat(32)) as `0x${string}`;
const OTHER_PK = ("0x" + "22".repeat(32)) as `0x${string}`;
const REAL_PLATFORM = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const REAL_AGENT_ID = "12847293847561029384";

function clearEnv() {
  delete process.env.PRIVATE_KEY;
  delete process.env.DEPLOYER_PK;
  delete process.env.SOMNIA_AGENT_PLATFORM;
  delete process.env.LLM_INFERENCE_AGENT_ID;
  delete process.env.SOMNIA_TESTNET_RPC;
  delete process.env.WARD_ORACLE;
  delete (globalThis as any).__MOCK_BALANCE__;
  delete (globalThis as any).__MOCK_CHAIN_ID__;
}

describe("ward preflight", () => {
  beforeEach(() => {
    clearEnv();
  });
  afterEach(() => {
    clearEnv();
  });

  it("errors out when PRIVATE_KEY is missing", async () => {
    const r = await preflightCmd({}, false);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/PRIVATE_KEY/);
  });

  it("errors out on a malformed PRIVATE_KEY", async () => {
    process.env.PRIVATE_KEY = "0xdeadbeef";
    const r = await preflightCmd({}, false);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/32-byte hex/);
  });

  it("warns when PRIVATE_KEY and DEPLOYER_PK differ", async () => {
    process.env.PRIVATE_KEY = VALID_PK;
    process.env.DEPLOYER_PK = OTHER_PK;
    process.env.SOMNIA_AGENT_PLATFORM = REAL_PLATFORM;
    process.env.LLM_INFERENCE_AGENT_ID = REAL_AGENT_ID;
    const r = await preflightCmd({}, false);
    expect(r.warnings.join(" ")).toMatch(/differ/);
  });

  it("warns when balance is below the minimum", async () => {
    process.env.PRIVATE_KEY = VALID_PK;
    process.env.SOMNIA_AGENT_PLATFORM = REAL_PLATFORM;
    process.env.LLM_INFERENCE_AGENT_ID = REAL_AGENT_ID;
    (globalThis as any).__MOCK_BALANCE__ = 1n; // 1 wei
    const r = await preflightCmd({}, false);
    expect(r.ok).toBe(true); // not an error — just a warning
    expect(r.warnings.join(" ")).toMatch(/below the recommended/);
    expect(r.balanceWei).toBe(1n);
  });

  it("warns on a non-canonical platform / agent id", async () => {
    process.env.PRIVATE_KEY = VALID_PK;
    process.env.SOMNIA_AGENT_PLATFORM = "0x0000000000000000000000000000000000000001";
    process.env.LLM_INFERENCE_AGENT_ID = "999";
    const r = await preflightCmd({}, false);
    const joined = r.warnings.join(" ");
    expect(joined).toMatch(/differs from the canonical testnet platform/);
    expect(joined).toMatch(/differs from the canonical id/);
  });

  it("warns when chainId does not match Somnia testnet", async () => {
    process.env.PRIVATE_KEY = VALID_PK;
    process.env.SOMNIA_AGENT_PLATFORM = REAL_PLATFORM;
    process.env.LLM_INFERENCE_AGENT_ID = REAL_AGENT_ID;
    (globalThis as any).__MOCK_CHAIN_ID__ = 1; // mainnet
    const r = await preflightCmd({}, false);
    expect(r.warnings.join(" ")).toMatch(/expected 50312/);
  });

  it("errors on a malformed WARD_ORACLE address", async () => {
    process.env.PRIVATE_KEY = VALID_PK;
    process.env.WARD_ORACLE = "not-an-address";
    const r = await preflightCmd({}, false);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/WARD_ORACLE=not-an-address/);
  });

  it("returns ok with derived address when env is well-formed and balance is healthy", async () => {
    process.env.PRIVATE_KEY = VALID_PK;
    process.env.SOMNIA_AGENT_PLATFORM = REAL_PLATFORM;
    process.env.LLM_INFERENCE_AGENT_ID = REAL_AGENT_ID;
    (globalThis as any).__MOCK_BALANCE__ = 1_000_000_000_000_000_000n; // 1 STT
    const r = await preflightCmd({}, false);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(r.chainId).toBe(50312);
  });
});
