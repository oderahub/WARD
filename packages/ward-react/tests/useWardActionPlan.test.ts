import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { planWardAction } from "../src/useWardActionPlan.js";
import type { EvalIntent, EvalPolicy } from "@ward/sdk";

vi.mock("@ward/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ward/sdk")>();
  return {
    ...actual,
    preflight: vi.fn(),
  };
});

const { preflight, REASON_CODES } = await import("@ward/sdk");

const TARGET: Address = "0x1111111111111111111111111111111111111111";
const SELECTOR: Hex = "0x60fe47b1";
const HASH: Hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const intent: EvalIntent = {
  agentId: 1n,
  requestId: 2n,
  target: TARGET,
  selector: SELECTOR,
  data: `${SELECTOR}00`,
  value: 0n,
  promptHash: HASH,
  taskClass: 0,
};

function policyWithTier(tier: number, delaySeconds: number): EvalPolicy {
  const target = TARGET.toLowerCase();
  const selector = SELECTOR.toLowerCase();
  return {
    isTargetAllowed: { [target]: true },
    isSelectorAllowed: { [target]: { [selector]: true } },
    valueCapPerCall: { [target]: { [selector]: 0n } },
    tier: { [target]: { [selector]: tier } },
    delaySeconds: { [target]: { [selector]: delaySeconds } },
    dailySpendWeiCap: 0n,
    expiresAt: 4_102_444_800n,
    paused: false,
  };
}

function localSource(tier = 0, delaySeconds = 0) {
  return { kind: "local", policy: policyWithTier(tier, delaySeconds) } as const;
}

function mockDecision(ok: boolean, reason: Hex, reasonText = "decision") {
  vi.mocked(preflight).mockResolvedValue({
    ok,
    reason,
    reasonText,
    source: "local",
  });
}

describe("planWardAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns write-now when preflight allows", async () => {
    mockDecision(true, REASON_CODES.OK, "ok");

    await expect(
      planWardAction({ source: localSource(), intent, spentTodayWei: 0n }),
    ).resolves.toMatchObject({ kind: "write-now", intent });
  });

  it.each([
    REASON_CODES.PAUSED,
    REASON_CODES.EXPIRED,
    REASON_CODES.BAD_CALLDATA,
    REASON_CODES.SELECTOR_MISMATCH,
    REASON_CODES.TARGET_NOT_ALLOWED,
    REASON_CODES.SELECTOR_NOT_ALLOWED,
    REASON_CODES.VALUE_CAP,
    REASON_CODES.DAILY_CAP,
  ])("returns reject for non-queue reason %s", async (reason) => {
    mockDecision(false, reason, "blocked");

    const result = await planWardAction({ source: localSource(), intent, spentTodayWei: 0n });

    expect(result).toMatchObject({ kind: "reject", reason });
    if (result.kind !== "reject") throw new Error("expected reject plan");
    expect(result.reasonText).not.toBe("blocked");
    expect(result.reasonText.length).toBeGreaterThan(0);
  });

  it("returns DELAYED queue plan with delaySeconds parsed from local policy", async () => {
    mockDecision(false, REASON_CODES.REQUIRES_DELAY);

    await expect(
      planWardAction({ source: localSource(1, 900), intent, spentTodayWei: 0n }),
    ).resolves.toMatchObject({
      kind: "queue",
      tier: "DELAYED",
      delaySeconds: 900,
      intent,
    });
  });

  it("returns VETO_REQUIRED queue plan with delaySeconds parsed from local policy", async () => {
    mockDecision(false, REASON_CODES.REQUIRES_VETO);

    await expect(
      planWardAction({ source: localSource(2, 3600), intent, spentTodayWei: 0n }),
    ).resolves.toMatchObject({
      kind: "queue",
      tier: "VETO_REQUIRED",
      delaySeconds: 3600,
      intent,
    });
  });

  it("parses queue tier from spec source", async () => {
    mockDecision(false, REASON_CODES.REQUIRES_DELAY);
    const yaml = `
\`\`\`policy
version: "0.1"
targets:
  - target: "${TARGET}"
    selectors:
      - selector: "set(uint256)"
        tier: DELAYED
        delaySeconds: 123
        valueCapPerCall: "0"
dailySpendWeiCap: "0"
expiresAt: "2030-01-01T00:00:00Z"
\`\`\`
`;

    await expect(
      planWardAction({ source: { kind: "spec", yaml }, intent, spentTodayWei: 0n }),
    ).resolves.toMatchObject({ kind: "queue", tier: "DELAYED", delaySeconds: 123 });
  });

  it("awaits lazy spentTodayWei before preflight", async () => {
    mockDecision(true, REASON_CODES.OK);
    const spentTodayWei = vi.fn(async () => 42n);

    await planWardAction({ source: localSource(), intent, spentTodayWei });

    expect(spentTodayWei).toHaveBeenCalledTimes(1);
    expect(vi.mocked(preflight).mock.calls[0]![0].spentTodayWei).toBe(42n);
  });

  it("refresh-style repeated calls rerun preflight", async () => {
    mockDecision(true, REASON_CODES.OK);
    const args = { source: localSource(), intent, spentTodayWei: 0n };

    await planWardAction(args);
    await planWardAction(args);

    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it("propagates preflight errors", async () => {
    vi.mocked(preflight).mockRejectedValue(new Error("rpc unavailable"));

    await expect(
      planWardAction({ source: localSource(), intent, spentTodayWei: 0n }),
    ).rejects.toThrow("rpc unavailable");
  });

  it("does not guess queue delay for chain-only source", async () => {
    mockDecision(false, REASON_CODES.REQUIRES_DELAY);

    await expect(
      planWardAction({
        source: {
          kind: "chain",
          publicClient: {} as never,
          oracleAddress: TARGET,
          policyId: HASH,
        },
        intent,
        spentTodayWei: 0n,
      }),
    ).rejects.toThrow(/requires local or spec policy data/);
  });
});
