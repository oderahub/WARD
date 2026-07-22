import { describe, it, expect } from "vitest";
import type { Address } from "viem";

import {
  serializeDeploymentParams,
  DEFAULT_RPC,
  DEFAULT_ORACLE,
  DEFAULT_QUEUE,
} from "../../src/hooks/useUrlState";

const NON_DEFAULT_RPC = "https://example.test/rpc";
const NON_DEFAULT_ORACLE = "0x9999999999999999999999999999999999999999" as Address;
const NON_DEFAULT_QUEUE = "0x8888888888888888888888888888888888888888" as Address;

describe("serializeDeploymentParams", () => {
  it("returns empty string when every value matches the default", () => {
    expect(
      serializeDeploymentParams({
        rpc: DEFAULT_RPC,
        oracle: DEFAULT_ORACLE,
        queue: DEFAULT_QUEUE,
        mode: "enforce",
      }),
    ).toBe("");
  });

  it("emits only the rpc fragment when rpc differs", () => {
    expect(
      serializeDeploymentParams({
        rpc: NON_DEFAULT_RPC,
        oracle: DEFAULT_ORACLE,
        queue: DEFAULT_QUEUE,
        mode: "enforce",
      }),
    ).toBe(`&rpc=${encodeURIComponent(NON_DEFAULT_RPC)}`);
  });

  it("emits only the oracle fragment when oracle differs", () => {
    expect(
      serializeDeploymentParams({
        rpc: DEFAULT_RPC,
        oracle: NON_DEFAULT_ORACLE,
        queue: DEFAULT_QUEUE,
        mode: "enforce",
      }),
    ).toBe(`&oracle=${NON_DEFAULT_ORACLE}`);
  });

  it("emits only the queue fragment when queue differs", () => {
    expect(
      serializeDeploymentParams({
        rpc: DEFAULT_RPC,
        oracle: DEFAULT_ORACLE,
        queue: NON_DEFAULT_QUEUE,
        mode: "enforce",
      }),
    ).toBe(`&queue=${NON_DEFAULT_QUEUE}`);
  });

  it("emits mode=watch when mode is watch, never enforce", () => {
    expect(
      serializeDeploymentParams({
        rpc: DEFAULT_RPC,
        oracle: DEFAULT_ORACLE,
        queue: DEFAULT_QUEUE,
        mode: "watch",
      }),
    ).toBe("&mode=watch");
  });

  it("concatenates all non-defaults with single ampersand joiners", () => {
    const out = serializeDeploymentParams({
      rpc: NON_DEFAULT_RPC,
      oracle: NON_DEFAULT_ORACLE,
      queue: NON_DEFAULT_QUEUE,
      mode: "watch",
    });
    expect(out).toBe(
      `&rpc=${encodeURIComponent(NON_DEFAULT_RPC)}&oracle=${NON_DEFAULT_ORACLE}&queue=${NON_DEFAULT_QUEUE}&mode=watch`,
    );
  });

  it("treats oracle case-insensitively when comparing to default", () => {
    // Same address but upper-cased — should still register as default.
    const upper = DEFAULT_ORACLE.toUpperCase() as unknown as Address;
    expect(
      serializeDeploymentParams({
        rpc: DEFAULT_RPC,
        oracle: upper,
        queue: DEFAULT_QUEUE,
        mode: "enforce",
      }),
    ).toBe("");
  });
});
