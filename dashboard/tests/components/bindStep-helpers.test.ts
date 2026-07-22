/**
 * Pure-helper tests for BindStep — the React component itself stays untested
 * here (the dashboard suite deliberately avoids @testing-library/react, see
 * postPublishChecklistState.test.ts header). Instead the two transition
 * rules introduced by w69m09qtu's REVISE pass are extracted as pure
 * functions and exercised below:
 *
 *   - `canShowSkip(probe, alreadyBoundToThisPolicy, ownerMismatch)`
 *     covers the orphan-path fix: when the probe resolves to
 *     `no-set-policy-id`, BindStep already calls onAgentResolved, but the
 *     original UI gate hid Skip — leaving the operator with no way to
 *     advance Step 1 to "skipped".
 *
 *   - `classifyBindVerification({ readback, expected, sawPolicyBoundEvent })`
 *     covers the post-mine POLICY_ID() readback: we trust the on-chain
 *     view over the (possibly-suppressed) PolicyBound event and degrade
 *     gracefully when the view itself reverts.
 */
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";

import {
  canShowSkip,
  classifyBindVerification,
} from "../../src/components/publish/BindStep";

const POLICY_NEW = ("0x" + "11".repeat(32)) as Hex;
const POLICY_OLD = ("0x" + "22".repeat(32)) as Hex;
const OWNER_A = "0x000000000000000000000000000000000000beef" as Address;

describe("canShowSkip — orphan-path fix for the Skip button gate", () => {
  it("renders Skip for no-set-policy-id probes so the operator can advance to Step 2", () => {
    // The bug we're fixing: probe resolves to no-set-policy-id, onAgentResolved
    // fires, the orchestrator now has boundAgentAddress set, but the Skip
    // affordance was hidden — Step 1 was stuck in "pending" forever.
    expect(canShowSkip({ kind: "no-set-policy-id" }, false, false)).toBe(true);
  });

  it("renders Skip for probe-error so a flaky RPC doesn't strand the user", () => {
    // RPC failures don't clear the validated address (see BindStep effect),
    // so the orchestrator has an agent to register but Step 1 can't bind.
    expect(canShowSkip({ kind: "probe-error", message: "RPC down" }, false, false)).toBe(true);
  });

  it("hides Skip for EOA — registering an address with no code makes no sense", () => {
    // Registering an EOA against SentryAgentRegistry would write a row that
    // discovers nothing — the user should fix the input, not skip.
    expect(canShowSkip({ kind: "eoa" }, false, false)).toBe(false);
  });

  it("hides Skip while the probe is in flight (idle/probing) — defer the choice", () => {
    expect(canShowSkip({ kind: "idle" }, false, false)).toBe(false);
    expect(canShowSkip({ kind: "probing" }, false, false)).toBe(false);
  });

  it("keeps the original sentry-agent branch: Skip shown except when already-bound and owner matches", () => {
    expect(
      canShowSkip(
        { kind: "sentry-agent", currentPolicyId: null, owner: OWNER_A },
        false,
        false,
      ),
    ).toBe(true);
    // Already bound + owner matches: nothing useful to skip TO, so hide.
    expect(
      canShowSkip(
        { kind: "sentry-agent", currentPolicyId: POLICY_NEW, owner: OWNER_A },
        true,
        false,
      ),
    ).toBe(false);
    // Even when already-bound, an owner mismatch means this wallet can't
    // re-bind anyway — Skip is the only forward, so show it.
    expect(
      canShowSkip(
        { kind: "sentry-agent", currentPolicyId: POLICY_NEW, owner: OWNER_A },
        true,
        true,
      ),
    ).toBe(true);
  });
});

describe("classifyBindVerification — POLICY_ID readback after a mined receipt", () => {
  it("returns 'verified' when readback matches expected (case-insensitive)", () => {
    const v = classifyBindVerification({
      readback: POLICY_NEW,
      expected: POLICY_NEW,
      sawPolicyBoundEvent: true,
    });
    expect(v.kind).toBe("verified");
    if (v.kind === "verified") expect(v.readback).toBe(POLICY_NEW);
  });

  it("compares case-insensitively so checksummed vs lowercase hashes still verify", () => {
    const upper = ("0x" + "AA".repeat(32)) as Hex;
    const lower = ("0x" + "aa".repeat(32)) as Hex;
    const v = classifyBindVerification({
      readback: upper,
      expected: lower,
      sawPolicyBoundEvent: false,
    });
    expect(v.kind).toBe("verified");
  });

  it("returns 'mismatch' when the on-chain view disagrees with the expected policyId, and threads sawPolicyBoundEvent through", () => {
    // This is the dangerous case the readback was added for: the tx mined
    // OK, the event may or may not have been emitted, but POLICY_ID() now
    // returns something OTHER than what we expected. The toast must shout —
    // and it differentiates copy based on whether the event was emitted at
    // all (event + diverged view = "PolicyBound was emitted, but…") so the
    // sawPolicyBoundEvent flag must survive into the mismatch branch.
    const vWithEvent = classifyBindVerification({
      readback: POLICY_OLD,
      expected: POLICY_NEW,
      sawPolicyBoundEvent: true,
    });
    expect(vWithEvent.kind).toBe("mismatch");
    if (vWithEvent.kind === "mismatch") {
      expect(vWithEvent.readback).toBe(POLICY_OLD);
      expect(vWithEvent.expected).toBe(POLICY_NEW);
      expect(vWithEvent.sawPolicyBoundEvent).toBe(true);
    }
    const vNoEvent = classifyBindVerification({
      readback: POLICY_OLD,
      expected: POLICY_NEW,
      sawPolicyBoundEvent: false,
    });
    if (vNoEvent.kind === "mismatch") {
      expect(vNoEvent.sawPolicyBoundEvent).toBe(false);
    }
  });

  it("returns 'fallback' when the readback is null — caller leans on the event", () => {
    // The agent might not have POLICY_ID() callable (rare override case);
    // the BindStep already catches that and passes null. The classifier
    // surfaces fallback so the toast says "verify on the explorer".
    const v = classifyBindVerification({
      readback: null,
      expected: POLICY_NEW,
      sawPolicyBoundEvent: true,
    });
    expect(v.kind).toBe("fallback");
    if (v.kind === "fallback") expect(v.sawPolicyBoundEvent).toBe(true);
  });

  it("threads sawPolicyBoundEvent verbatim through the fallback branch", () => {
    const v = classifyBindVerification({
      readback: null,
      expected: POLICY_NEW,
      sawPolicyBoundEvent: false,
    });
    expect(v.kind).toBe("fallback");
    if (v.kind === "fallback") expect(v.sawPolicyBoundEvent).toBe(false);
  });
});
