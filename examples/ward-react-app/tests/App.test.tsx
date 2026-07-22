import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { writeContractMock } = vi.hoisted(() => {
  return {
    writeContractMock: vi.fn(async () => "0xdeadbeef" as const),
  };
});

const { preflightMock } = vi.hoisted(() => {
  return {
    preflightMock: vi.fn(),
  };
});

vi.mock("wagmi/actions", () => ({
  writeContract: writeContractMock,
}));

vi.mock("wagmi", async () => {
  const fakePublicClient = { transport: { type: "fake" } };
  return {
    useAccount: () => ({
      address: "0x1111111111111111111111111111111111111111",
      isConnected: true,
    }),
    useChainId: () => 43113,
    useConnect: () => ({
      connect: vi.fn(),
      connectors: [],
      status: "idle",
    }),
    useDisconnect: () => ({ disconnect: vi.fn() }),
    usePublicClient: () => fakePublicClient,
    useSwitchChain: () => ({ switchChain: vi.fn() }),
    useConfig: () => ({}),
    WagmiProvider: ({ children }: { children: React.ReactNode }) => children,
    createConfig: () => ({}),
    http: () => () => ({}),
  };
});

vi.mock("wagmi/connectors", () => ({
  injected: () => () => ({}),
}));

vi.mock("@ward/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ward/sdk")>();
  return {
    ...actual,
    preflight: preflightMock,
  };
});

import App from "../src/App.js";

describe("Ward React demo app", () => {
  beforeEach(() => {
    writeContractMock.mockClear();
    preflightMock.mockReset();
  });

  it("surfaces the decision reason and does not call writeContract on reject", async () => {
    preflightMock.mockResolvedValue({
      ok: false,
      reason:
        "0x53454c4543544f525f4e4f545f414c4c4f5745440000000000000000000000",
      reasonText: "The selector is not allowed by this policy.",
      source: "chain",
    });

    render(<App />);

    const bumpButton = await screen.findByRole("button", {
      name: /bump counter/i,
    });
    fireEvent.click(bumpButton);

    await waitFor(() => {
      expect(screen.getByTestId("decision-reason")).toHaveTextContent(
        "The selector is not allowed by this policy.",
      );
    });

    expect(screen.getByTestId("decision-ok")).toHaveTextContent("no");
    expect(writeContractMock).not.toHaveBeenCalled();

    expect(preflightMock).toHaveBeenCalled();
    const firstCall = preflightMock.mock.calls[0]?.[0] as {
      source: { kind: string };
    };
    expect(firstCall.source.kind).toBe("chain");
  });
});
