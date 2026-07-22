import { describe, expect, it, vi } from "vitest";
import { parseAbi, type Address, type Hex, type WalletClient } from "viem";
import { withWardPreflight } from "../src/account-decorator.js";
import { REASON_CODES } from "../src/reason-codes.js";
import type { EvalPolicy } from "../src/policy-eval.js";

const TARGET: Address = "0x1111111111111111111111111111111111111111";
const HASH: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const abi = parseAbi(["function set(uint256 value)"]);

function policy(allowed: boolean): EvalPolicy {
  const target = TARGET.toLowerCase();
  const selector = "0x60fe47b1";
  return {
    isTargetAllowed: { [target]: true },
    isSelectorAllowed: { [target]: allowed ? { [selector]: true } : {} },
    valueCapPerCall: { [target]: { [selector]: 10n } },
    tier: { [target]: { [selector]: 0 } },
    delaySeconds: { [target]: { [selector]: 0 } },
    dailySpendWeiCap: 10n,
    expiresAt: 4_102_444_800n,
    paused: false,
  };
}

function wallet() {
  return {
    writeContract: vi.fn(async () => HASH),
    sendTransaction: vi.fn(async () => HASH),
    getChainId: vi.fn(async () => 50312),
    marker: "wallet",
  } as unknown as WalletClient & {
    writeContract: ReturnType<typeof vi.fn>;
    sendTransaction: ReturnType<typeof vi.fn>;
    getChainId: ReturnType<typeof vi.fn>;
    marker: string;
    _underlying?: unknown;
  };
}

describe("withWardPreflight", () => {
  it("gates writeContract with preflight before forwarding", async () => {
    const base = wallet();
    const decorated = withWardPreflight(base, {
      source: { kind: "local", policy: policy(true) },
      spentTodayWei: 0n,
    });

    await expect(
      decorated.writeContract({
        address: TARGET,
        abi,
        functionName: "set",
        args: [1n],
      } as never),
    ).resolves.toBe(HASH);

    expect(base.writeContract).toHaveBeenCalledTimes(1);
    expect(base.writeContract.mock.calls[0]![0]).toMatchObject({
      address: TARGET,
      functionName: "set",
    });
  });

  it("throws reasonText and does not forward rejected writeContract calls", async () => {
    const base = wallet();
    const onRejected = vi.fn();
    const decorated = withWardPreflight(base, {
      source: { kind: "local", policy: policy(false) },
      spentTodayWei: 0n,
      onRejected,
    });

    await expect(
      decorated.writeContract({
        address: TARGET,
        abi,
        functionName: "set",
        args: [1n],
      } as never),
    ).rejects.toThrow(/selector is not allowed/i);

    expect(base.writeContract).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        reason: REASON_CODES.SELECTOR_NOT_ALLOWED,
      }),
    );
  });

  it("awaits lazy spentTodayWei", async () => {
    const spentTodayWei = vi.fn(async () => 0n);
    const decorated = withWardPreflight(wallet(), {
      source: { kind: "local", policy: policy(true) },
      spentTodayWei,
    });

    await decorated.writeContract({
      address: TARGET,
      abi,
      functionName: "set",
      args: [1n],
    } as never);

    expect(spentTodayWei).toHaveBeenCalledTimes(1);
  });

  it("warns and forwards raw sendTransaction without preflight", async () => {
    const base = wallet();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const decorated = withWardPreflight(base, {
      source: { kind: "local", policy: policy(false) },
      spentTodayWei: 0n,
    });

    await expect(
      decorated.sendTransaction({
        to: TARGET,
        data: "0x60fe47b1",
        value: 0n,
      } as never),
    ).resolves.toBe(HASH);

    expect(warn).toHaveBeenCalledWith(
      "withWardPreflight: sendTransaction without ABI context skipped — preflight needs functionName+abi",
    );
    expect(base.sendTransaction).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("exposes the original wallet through _underlying", () => {
    const base = wallet();
    const decorated = withWardPreflight(base, {
      source: { kind: "local", policy: policy(true) },
      spentTodayWei: 0n,
    });

    expect((decorated as typeof decorated & { _underlying: unknown })._underlying).toBe(base);
  });

  it("leaves original properties and non-intercepted methods accessible", async () => {
    const base = wallet();
    const decorated = withWardPreflight(base, {
      source: { kind: "local", policy: policy(true) },
      spentTodayWei: 0n,
    });

    expect((decorated as typeof decorated & { marker: string }).marker).toBe("wallet");
    await expect(decorated.getChainId()).resolves.toBe(50312);
    expect(base.getChainId).toHaveBeenCalledTimes(1);
  });

  it("is a named ESM export with no setup side effects", () => {
    expect(withWardPreflight).toBeTypeOf("function");
  });
});
