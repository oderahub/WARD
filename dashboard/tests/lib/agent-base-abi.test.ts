import { describe, it, expect } from "vitest";
import {
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  toHex,
  type Hex,
} from "viem";

import { WARD_AGENT_BASE_ABI } from "../../src/lib/agent-base-abi";

// Sample values for selector / topic derivation. The hexlification mirrors
// what an on-chain WardAgentBase tx would carry.
const NEW_POLICY = ("0x" + "11".repeat(32)) as Hex;
const OLD_POLICY = ("0x" + "22".repeat(32)) as Hex;
const CALLER = "0x000000000000000000000000000000000000B055";

describe("WARD_AGENT_BASE_ABI", () => {
  it("encodes setPolicyId(bytes32) with the canonical 0x30658feb selector", () => {
    // 0x30658feb == keccak256("setPolicyId(bytes32)")[0:4]. If this selector
    // ever drifts, every dashboard call against an on-chain WardAgentBase
    // will silently target the wrong function, so we pin the byte sequence.
    const calldata = encodeFunctionData({
      abi: WARD_AGENT_BASE_ABI,
      functionName: "setPolicyId",
      args: [NEW_POLICY],
    });
    expect(calldata.slice(0, 10)).toBe("0x30658feb");
    // 32-byte argument right-padded after the selector.
    expect(calldata.length).toBe(2 + 8 + 64);
  });

  it("decodes a PolicyBound event back into the (newPolicyId, oldPolicyId, by) shape", () => {
    const topics = encodeEventTopics({
      abi: WARD_AGENT_BASE_ABI,
      eventName: "PolicyBound",
      args: { newPolicyId: NEW_POLICY, oldPolicyId: OLD_POLICY, by: CALLER },
    });
    const parsed = decodeEventLog({
      abi: WARD_AGENT_BASE_ABI,
      topics: topics as [Hex, ...Hex[]],
      data: "0x",
    });
    expect(parsed.eventName).toBe("PolicyBound");
    const args = parsed.args as {
      newPolicyId: Hex;
      oldPolicyId: Hex;
      by: string;
    };
    expect(args.newPolicyId.toLowerCase()).toBe(NEW_POLICY.toLowerCase());
    expect(args.oldPolicyId.toLowerCase()).toBe(OLD_POLICY.toLowerCase());
    expect(args.by.toLowerCase()).toBe(CALLER.toLowerCase());
  });

  it("includes the NotOwner custom error so viem can resolve revert names", () => {
    // We assert by name rather than by selector because the humanizer keys on
    // revertError.data.errorName, not raw selector bytes.
    const hasNotOwner = WARD_AGENT_BASE_ABI.some(
      (item) => item.type === "error" && item.name === "NotOwner",
    );
    expect(hasNotOwner).toBe(true);
  });

  it("does not export any precomputed selector constants (design-review nit)", async () => {
    // Re-import the module namespace and confirm only the documented exports
    // are present — guards against the NOT_OWNER_SELECTOR / OWNER_SELECTOR
    // constants creeping back in.
    const mod = await import("../../src/lib/agent-base-abi");
    const exportNames = Object.keys(mod).sort();
    expect(exportNames).toEqual(["WARD_AGENT_BASE_ABI"]);
  });

  // Reference to `toHex` so eslint --no-unused-vars stays quiet when the
  // surrounding tests evolve; toHex is part of the canonical viem encode
  // surface and is intentionally kept available for future assertions.
  it("smoke: viem hex encoding round-trips", () => {
    expect(toHex(1n, { size: 32 })).toMatch(/^0x0+1$/);
  });
});
