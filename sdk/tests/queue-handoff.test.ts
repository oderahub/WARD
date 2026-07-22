import { describe, expect, it } from "vitest";
import {
  abiExposesDispatchQueued,
  buildQueueHandoffRecommendation,
  castSendCommand,
  extractAbi,
} from "../src/queue-handoff.js";

const QUEUE = "0x000000000000000000000000000000000000beef";
const AGENT = "0x1111111111111111111111111111111111111111";
const ASKER = "0x2222222222222222222222222222222222222222";
const TARGET = "0x3333333333333333333333333333333333333333";
const OWNER = "0x4444444444444444444444444444444444444444";

describe("queue handoff helpers", () => {
  it.each([
    { tier: 0, hasAgent: false, hasDispatchQueued: false, expected: "IMMEDIATE requests should not be sitting" },
    { tier: 1, hasAgent: false, hasDispatchQueued: false, expected: "Dispatch directly through SentryQueue" },
    { tier: 1, hasAgent: true, hasDispatchQueued: false, expected: "Dispatch directly through SentryQueue" },
    { tier: 1, hasAgent: true, hasDispatchQueued: true, expected: "Use the integrator agent dispatch flow" },
    { tier: 2, hasAgent: true, hasDispatchQueued: true, expected: "Policy owner only" },
  ])("maps tier=$tier agent=$hasAgent dispatchQueued=$hasDispatchQueued", (c) => {
    const rec = buildQueueHandoffRecommendation({
      execId: 42n,
      queueAddress: QUEUE,
      tier: c.tier,
      asker: ASKER,
      target: TARGET,
      agentAddress: c.hasAgent ? AGENT : undefined,
      agentHasDispatchQueued: c.hasDispatchQueued,
      policyOwner: c.tier === 2 ? OWNER : undefined,
    });

    expect(rec.summary).toContain(c.expected);
    if (c.tier === 1 && c.hasAgent && c.hasDispatchQueued) {
      expect(rec.command).toContain(`${AGENT} "dispatchQueued(uint256)" 42`);
    }
    if (c.tier === 1 && (!c.hasAgent || !c.hasDispatchQueued)) {
      expect(rec.command).toContain(`${QUEUE} "dispatch(uint256)" 42`);
      expect(rec.warning).toMatch(/agent/i);
    }
    if (c.tier === 2) {
      expect(rec.command).toContain(`${QUEUE} "dispatch(uint256)" 42`);
      expect(rec.policyOwner).toBe(OWNER);
    }
  });

  it("castSendCommand uses --account keystore form, not --private-key", () => {
    const cmd = castSendCommand(QUEUE, "dispatch(uint256)", 42n);
    expect(cmd).toContain(`--account "$CAST_ACCOUNT"`);
    expect(cmd).not.toContain("--private-key");
    expect(cmd).not.toContain("$DEPLOYER_PK");
    expect(cmd).toContain(`${QUEUE} "dispatch(uint256)" 42`);
    expect(cmd).toContain("--rpc-url $SOMNIA_TESTNET_RPC");
  });

  it("detects dispatchQueued(uint256) in raw ABIs and artifact JSON", () => {
    const abi = [
      {
        type: "function",
        name: "dispatchQueued",
        inputs: [{ type: "uint256" }],
        outputs: [],
      },
    ];
    expect(abiExposesDispatchQueued(abi)).toBe(true);
    expect(abiExposesDispatchQueued(extractAbi({ abi }))).toBe(true);
    expect(abiExposesDispatchQueued([{ type: "function", name: "dispatchQueued", inputs: [{ type: "bytes32" }] }])).toBe(false);
  });
});
