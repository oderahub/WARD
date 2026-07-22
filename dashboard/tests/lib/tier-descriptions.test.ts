import { describe, it, expect } from "vitest";
import { TIER_DESCRIPTIONS } from "../../src/components/publish/SelectorRow";
import { TIER_VALUES } from "../../src/lib/policy-draft";

/**
 * Pinning regression test for the inline tier-subtitle wording. The
 * dispatch authorization split in WardQueue.dispatch is the only source of
 * truth — passive timeout does NOT dispatch VETO_REQUIRED, and IMMEDIATE
 * never touches the queue. If a contributor softens the VETO_REQUIRED copy
 * back to "until the veto window passes without intervention" this test
 * should catch it before the inaccurate string ships to the form.
 */
describe("publish/SelectorRow.TIER_DESCRIPTIONS", () => {
  it("has a description for every tier value", () => {
    for (const tier of TIER_VALUES) {
      expect(TIER_DESCRIPTIONS[tier]).toBeTruthy();
    }
  });

  it("IMMEDIATE wording reflects no-queue passthrough (matches Oracle.checkIntent ALLOW path)", () => {
    const text = TIER_DESCRIPTIONS.IMMEDIATE.toLowerCase();
    expect(text).toMatch(/immediately|passes through/);
  });

  it("DELAYED wording reflects asker-dispatchable timer + commit-window deadline (matches WardQueue._checkDispatchAuthorized else-branch and PastDeadline guard)", () => {
    const text = TIER_DESCRIPTIONS.DELAYED.toLowerCase();
    expect(text).toMatch(/delayseconds/);
    expect(text).toMatch(/dispatch/);
    // Commit window: WardQueue.COMMIT_WINDOW_SECONDS = 7 days. The copy
    // must surface that the queue entry is NOT held indefinitely — dispatch
    // reverts with PastDeadline once `block.timestamp > deadline`.
    expect(text).toMatch(/expires?/);
    expect(text).toMatch(/7 days/);
  });

  it("VETO_REQUIRED wording reflects owner-only active dispatch + commit-window deadline (matches WardQueue._checkDispatchAuthorized VETO branch and PastDeadline guard)", () => {
    const text = TIER_DESCRIPTIONS.VETO_REQUIRED.toLowerCase();
    // Must name the policy owner as the only actor that can dispatch.
    expect(text).toMatch(/policy owner|owner/);
    expect(text).toMatch(/dispatch/);
    // Must NOT promise passive auto-execute — the contract requires an
    // active dispatch transaction from policyOwner, NOT timeout expiry.
    expect(text).toMatch(/no auto-execute|owner.*dispatch/);
    expect(text).not.toMatch(/without intervention/);
    expect(text).not.toMatch(/passes? without/);
    // Must NOT promise indefinite hold — WardQueue.COMMIT_WINDOW_SECONDS
    // = 7 days and `expireIfStale` can mark the entry expired afterwards.
    expect(text).not.toMatch(/indefinitely|indefinite/);
    expect(text).toMatch(/expires?/);
    expect(text).toMatch(/7 days/);
  });
});
