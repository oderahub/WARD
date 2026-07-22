// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/PolicyTypes.sol";
import "../src/WardOracle.sol";
import "./mocks/MockTarget.sol";

/// @notice Unit + property coverage for WardOracle. Each case asserts ONE invariant.
contract WardOracleTest is Test {
    WardOracle internal oracle;
    MockTarget internal target;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal constant LABEL_A = bytes32("policy-a");
    bytes32 internal constant LABEL_B = bytes32("policy-b");

    bytes4 internal constant SEL_PING = MockTarget.ping.selector;
    bytes4 internal constant SEL_PONG = MockTarget.pong.selector;

    function setUp() public {
        oracle = new WardOracle();
        target = new MockTarget();
    }

    // ---------- publish / update ----------

    function test_publishPolicy_assigns_owner_and_emits_event() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);

        bytes32 expectedId = oracle.policyIdFor(alice, LABEL_A);
        vm.expectEmit(true, true, false, true, address(oracle));
        emit WardOracle.PolicyPublished(expectedId, alice, LABEL_A);

        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        assertEq(id, expectedId, "policyId mirrors policyIdFor");
        assertEq(oracle.policyOwner(id), alice);
    }

    function test_publishPolicy_reverts_on_collision_with_same_publisher_and_label() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        oracle.publishPolicy(LABEL_A, input);

        vm.prank(alice);
        vm.expectRevert(WardOracle.PolicyExists.selector);
        oracle.publishPolicy(LABEL_A, input);
    }

    function test_different_publishers_get_distinct_policyIds_for_same_label() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);

        vm.prank(alice);
        bytes32 aliceId = oracle.publishPolicy(LABEL_A, input);
        vm.prank(bob);
        bytes32 bobId = oracle.publishPolicy(LABEL_A, input);

        assertTrue(aliceId != bobId, "namespacing by msg.sender prevents collision");
        assertEq(oracle.policyOwner(aliceId), alice);
        assertEq(oracle.policyOwner(bobId), bob);
    }

    function test_updatePolicy_only_callable_by_publisher() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        PolicyInput memory updated = _basicPolicy(SEL_PING, TIER_VETO_REQUIRED, 0);

        vm.prank(bob);
        vm.expectRevert(WardOracle.NotPolicyOwner.selector);
        oracle.updatePolicy(id, updated);

        // owner can update; emits event; policyId stable
        vm.expectEmit(true, true, false, true, address(oracle));
        emit WardOracle.PolicyUpdated(id, alice);
        vm.prank(alice);
        oracle.updatePolicy(id, updated);
    }

    function test_updatePolicy_changes_tier_visible_via_tierAndDelay() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        (uint8 tier0,) = oracle.tierAndDelay(id, address(target), SEL_PING);
        assertEq(tier0, TIER_IMMEDIATE);

        PolicyInput memory updated = _basicPolicy(SEL_PING, TIER_DELAYED, 60);
        vm.prank(alice);
        oracle.updatePolicy(id, updated);

        (uint8 tier1, uint32 delay) = oracle.tierAndDelay(id, address(target), SEL_PING);
        assertEq(tier1, TIER_DELAYED);
        assertEq(delay, uint32(60));
    }

    // ---------- transferPolicyOwnership (two-step) ----------

    function test_transferPolicyOwnership_happyPath_emitsEvent_updatesMapping() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        // Step 1: alice nominates bob — Started event, pending mapping set, owner unchanged.
        vm.expectEmit(true, true, true, false, address(oracle));
        emit WardOracle.PolicyOwnershipTransferStarted(id, alice, bob);
        vm.prank(alice);
        oracle.transferPolicyOwnership(id, bob);

        assertEq(oracle.policyOwner(id), alice, "owner unchanged until accept");
        assertEq(oracle.pendingPolicyOwner(id), bob, "pending set to nominee");

        // Step 2: bob accepts — Transferred event, owner flipped, pending cleared.
        vm.expectEmit(true, true, true, false, address(oracle));
        emit WardOracle.PolicyOwnershipTransferred(id, alice, bob);
        vm.prank(bob);
        oracle.acceptPolicyOwnership(id);

        assertEq(oracle.policyOwner(id), bob, "owner mapping updated to newOwner");
        assertEq(oracle.pendingPolicyOwner(id), address(0), "pending cleared after accept");
    }

    function test_transferPolicyOwnership_revertsIfNotOwner() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        vm.prank(bob);
        vm.expectRevert(WardOracle.NotPolicyOwner.selector);
        oracle.transferPolicyOwnership(id, bob);
    }

    function test_transferPolicyOwnership_revertsOnZeroAddress() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        vm.prank(alice);
        vm.expectRevert(WardOracle.ZeroAddress.selector);
        oracle.transferPolicyOwnership(id, address(0));
    }

    function test_transferPolicyOwnership_newOwnerCanUpdatePolicy_oldOwnerCannot() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        vm.prank(alice);
        oracle.transferPolicyOwnership(id, bob);
        vm.prank(bob);
        oracle.acceptPolicyOwnership(id);

        PolicyInput memory updated = _basicPolicy(SEL_PING, TIER_VETO_REQUIRED, 0);

        // Old owner can no longer update.
        vm.prank(alice);
        vm.expectRevert(WardOracle.NotPolicyOwner.selector);
        oracle.updatePolicy(id, updated);

        // New owner can update; tier flips to VETO_REQUIRED.
        vm.prank(bob);
        oracle.updatePolicy(id, updated);
        (uint8 tier,) = oracle.tierAndDelay(id, address(target), SEL_PING);
        assertEq(tier, TIER_VETO_REQUIRED, "newOwner update took effect");
    }

    function test_acceptPolicyOwnership_revertsIfNotPending() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        // No pending nominee yet — any caller (including bob) must revert.
        vm.prank(bob);
        vm.expectRevert(WardOracle.NotPendingOwner.selector);
        oracle.acceptPolicyOwnership(id);

        // After alice nominates bob, a different address (alice herself) must still revert.
        vm.prank(alice);
        oracle.transferPolicyOwnership(id, bob);
        vm.prank(alice);
        vm.expectRevert(WardOracle.NotPendingOwner.selector);
        oracle.acceptPolicyOwnership(id);
    }

    function test_cancelPolicyOwnershipTransfer_happyPath_emitsEvent_clearsPending() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        vm.prank(alice);
        oracle.transferPolicyOwnership(id, bob);

        vm.expectEmit(true, true, true, false, address(oracle));
        emit WardOracle.PolicyOwnershipTransferCancelled(id, alice, bob);
        vm.prank(alice);
        oracle.cancelPolicyOwnershipTransfer(id);

        assertEq(oracle.pendingPolicyOwner(id), address(0), "pending cleared after cancel");
        assertEq(oracle.policyOwner(id), alice, "owner unchanged after cancel");

        // After cancel, bob can no longer accept.
        vm.prank(bob);
        vm.expectRevert(WardOracle.NotPendingOwner.selector);
        oracle.acceptPolicyOwnership(id);
    }

    function test_cancelPolicyOwnershipTransfer_revertsIfNotOwner() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        vm.prank(alice);
        oracle.transferPolicyOwnership(id, bob);

        // bob (the pending nominee) is not the current owner and cannot cancel.
        vm.prank(bob);
        vm.expectRevert(WardOracle.NotPolicyOwner.selector);
        oracle.cancelPolicyOwnershipTransfer(id);
    }

    function test_cancelPolicyOwnershipTransfer_revertsIfNoPending() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        vm.prank(alice);
        vm.expectRevert(WardOracle.NoPendingTransfer.selector);
        oracle.cancelPolicyOwnershipTransfer(id);
    }

    function test_transferPolicyOwnership_replacesExistingPendingOwner_emitsStartedAgain() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        // First nomination: bob.
        vm.prank(alice);
        oracle.transferPolicyOwnership(id, bob);
        assertEq(oracle.pendingPolicyOwner(id), bob);

        // Re-nominate carol; Started event fires again, pending mapping replaced.
        address carol = address(0xCA401);
        vm.expectEmit(true, true, true, false, address(oracle));
        emit WardOracle.PolicyOwnershipTransferStarted(id, alice, carol);
        vm.prank(alice);
        oracle.transferPolicyOwnership(id, carol);

        assertEq(oracle.pendingPolicyOwner(id), carol, "pending replaced by latest nominee");

        // bob can no longer accept; carol can.
        vm.prank(bob);
        vm.expectRevert(WardOracle.NotPendingOwner.selector);
        oracle.acceptPolicyOwnership(id);

        vm.prank(carol);
        oracle.acceptPolicyOwnership(id);
        assertEq(oracle.policyOwner(id), carol);
    }

    // ---------- checkIntent: PolicyLib reasons ----------

    function test_checkIntent_returns_ok_true_for_legal_immediate_intent() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        Intent memory intent = _intent(address(target), SEL_PING, 0);
        (bool ok, bytes32 reason) = oracle.checkIntent(id, intent, 0);
        assertTrue(ok);
        assertEq(reason, bytes32(0));
    }

    function test_checkIntent_returns_TARGET_NOT_ALLOWED_for_unknown_target() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        // Build intent against a different target than the one in the policy.
        Intent memory intent = _intent(address(0xDEAD), SEL_PING, 0);
        (bool ok, bytes32 reason) = oracle.checkIntent(id, intent, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("TARGET_NOT_ALLOWED"));
    }

    function test_checkIntent_returns_DAILY_CAP_when_value_exceeds_remaining_budget() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        // 1 ether daily cap; caller passes spentToday=1 ether and intent.value=1 wei
        // → should hit DAILY_CAP. Per-call cap raised so DAILY_CAP fires before VALUE_CAP.
        input.dailySpendWeiCap = 1 ether;
        input.targets[0].selectors[0].valueCapPerCall = 2 ether;
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        Intent memory intent = _intent(address(target), SEL_PING, 1);
        (bool ok, bytes32 reason) = oracle.checkIntent(id, intent, 1 ether);
        assertFalse(ok);
        assertEq(reason, bytes32("DAILY_CAP"));
    }

    function test_checkIntent_returns_ok_at_exact_daily_cap_boundary() public {
        // value exactly equal to remaining budget must pass (boundary check pair to
        // the DAILY_CAP exceeded test above — guards against off-by-one regressions).
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        input.dailySpendWeiCap = 1 ether;
        input.targets[0].selectors[0].valueCapPerCall = 2 ether;
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        Intent memory intent = _intent(address(target), SEL_PING, 0.4 ether);
        (bool ok, bytes32 reason) = oracle.checkIntent(id, intent, 0.6 ether);
        assertTrue(ok, "value == cap - spentToday must pass");
        assertEq(reason, bytes32(0));
    }

    function test_checkIntent_returns_VALUE_CAP_passthrough() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        input.targets[0].selectors[0].valueCapPerCall = 1 ether;
        input.dailySpendWeiCap = 100 ether; // raised so DAILY_CAP isn't the first failure
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        Intent memory intent = _intent(address(target), SEL_PING, 1 ether + 1);
        (bool ok, bytes32 reason) = oracle.checkIntent(id, intent, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("VALUE_CAP"));
    }

    function test_checkIntent_returns_BAD_CALLDATA_passthrough() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        Intent memory intent = _intent(address(target), SEL_PING, 0);
        intent.data = hex""; // length < 4
        (bool ok, bytes32 reason) = oracle.checkIntent(id, intent, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("BAD_CALLDATA"));
    }

    // ---------- checkIntent: tier safety ----------

    function test_checkIntent_returns_REQUIRES_DELAY_for_DELAYED_tier_even_if_legal() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_DELAYED, 60);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        Intent memory intent = _intent(address(target), SEL_PING, 0);
        (bool ok, bytes32 reason) = oracle.checkIntent(id, intent, 0);
        assertFalse(ok, "DELAYED tier must NOT return ok=true from sync check");
        assertEq(reason, bytes32("REQUIRES_DELAY"));
    }

    function test_checkIntent_returns_REQUIRES_VETO_for_VETO_REQUIRED_tier_even_if_legal() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_VETO_REQUIRED, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        Intent memory intent = _intent(address(target), SEL_PING, 0);
        (bool ok, bytes32 reason) = oracle.checkIntent(id, intent, 0);
        assertFalse(ok, "VETO_REQUIRED tier must NOT return ok=true from sync check");
        assertEq(reason, bytes32("REQUIRES_VETO"));
    }

    function test_checkIntent_legality_failure_takes_precedence_over_tier() public {
        // Setup: DELAYED tier policy. Intent has wrong selector for the calldata.
        // PolicyLib should reject for SELECTOR_MISMATCH BEFORE the tier branch runs.
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_DELAYED, 60);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        Intent memory intent = _intent(address(target), SEL_PING, 0);
        intent.data = abi.encodeWithSelector(SEL_PONG); // calldata selector ≠ intent.selector
        (bool ok, bytes32 reason) = oracle.checkIntent(id, intent, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("SELECTOR_MISMATCH"), "legality reason wins over REQUIRES_DELAY");
    }

    // ---------- checkIntent / tierAndDelay: PolicyNotFound ----------

    function test_checkIntent_reverts_on_unknown_policyId() public {
        Intent memory intent = _intent(address(target), SEL_PING, 0);
        vm.expectRevert(WardOracle.PolicyNotFound.selector);
        oracle.checkIntent(bytes32(uint256(0x999)), intent, 0);
    }

    function test_tierAndDelay_reverts_on_unknown_policyId() public {
        vm.expectRevert(WardOracle.PolicyNotFound.selector);
        oracle.tierAndDelay(bytes32(uint256(0x999)), address(target), SEL_PING);
    }

    // ---------- checkSelector ----------

    function test_checkSelector_returns_ok_true_for_legal_immediate_call() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        (bool ok, bytes32 reason) = oracle.checkSelector(id, address(target), SEL_PING, 0, 0);
        assertTrue(ok, "IMMEDIATE selector under a legal policy must return ok=true");
        assertEq(reason, bytes32(0));
    }

    function test_checkSelector_returns_REQUIRES_DELAY_for_DELAYED_tier() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_DELAYED, 60);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        (bool ok, bytes32 reason) = oracle.checkSelector(id, address(target), SEL_PING, 0, 0);
        assertFalse(ok, "DELAYED tier must NOT return ok=true from selector-only check");
        assertEq(reason, bytes32("REQUIRES_DELAY"));
    }

    function test_checkSelector_returns_REQUIRES_VETO_for_VETO_REQUIRED_tier() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_VETO_REQUIRED, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        (bool ok, bytes32 reason) = oracle.checkSelector(id, address(target), SEL_PING, 0, 0);
        assertFalse(ok, "VETO_REQUIRED tier must NOT return ok=true from selector-only check");
        assertEq(reason, bytes32("REQUIRES_VETO"));
    }

    function test_checkSelector_returns_TARGET_NOT_ALLOWED_for_unknown_target() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        (bool ok, bytes32 reason) = oracle.checkSelector(id, address(0xDEAD), SEL_PING, 0, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("TARGET_NOT_ALLOWED"));
    }

    function test_checkSelector_returns_VALUE_CAP_when_value_exceeds_per_call_cap() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        input.targets[0].selectors[0].valueCapPerCall = 1 ether;
        input.dailySpendWeiCap = 100 ether;
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        (bool ok, bytes32 reason) = oracle.checkSelector(id, address(target), SEL_PING, 1 ether + 1, 0);
        assertFalse(ok);
        assertEq(reason, bytes32("VALUE_CAP"));
    }

    function test_checkSelector_returns_DAILY_CAP_when_value_plus_spent_exceeds_budget() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        input.dailySpendWeiCap = 1 ether;
        input.targets[0].selectors[0].valueCapPerCall = 2 ether;
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        (bool ok, bytes32 reason) = oracle.checkSelector(id, address(target), SEL_PING, 1, 1 ether);
        assertFalse(ok);
        assertEq(reason, bytes32("DAILY_CAP"));
    }

    function test_checkSelector_reverts_on_unknown_policyId() public {
        vm.expectRevert(WardOracle.PolicyNotFound.selector);
        oracle.checkSelector(bytes32(uint256(0x999)), address(target), SEL_PING, 0, 0);
    }

    // ---------- policyHealth ----------

    function test_policyHealth_returns_paused_and_expiresAt() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        uint64 expectedExpiry = uint64(block.timestamp + 365 days);
        input.expiresAt = expectedExpiry;
        input.paused = false;
        vm.prank(alice);
        bytes32 id = oracle.publishPolicy(LABEL_A, input);

        (bool paused, uint64 expiresAt) = oracle.policyHealth(id);
        assertFalse(paused);
        assertEq(expiresAt, expectedExpiry);

        // Now update with paused=true, fresh expiry
        PolicyInput memory updated = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        updated.paused = true;
        updated.expiresAt = uint64(block.timestamp + 30 days);
        vm.prank(alice);
        oracle.updatePolicy(id, updated);

        (bool paused2, uint64 expiresAt2) = oracle.policyHealth(id);
        assertTrue(paused2);
        assertEq(expiresAt2, uint64(block.timestamp + 30 days));
    }

    function test_policyHealth_reverts_on_unknown_policyId() public {
        vm.expectRevert(WardOracle.PolicyNotFound.selector);
        oracle.policyHealth(bytes32(uint256(0x999)));
    }

    // ---------- policyIdFor ----------

    function test_policyIdFor_matches_publishPolicy_return() public {
        PolicyInput memory input = _basicPolicy(SEL_PING, TIER_IMMEDIATE, 0);
        bytes32 precomputed = oracle.policyIdFor(alice, LABEL_B);
        vm.prank(alice);
        bytes32 actual = oracle.publishPolicy(LABEL_B, input);
        assertEq(actual, precomputed);
    }

    // ---------- helpers ----------

    function _basicPolicy(bytes4 selector, uint8 tier, uint32 delaySec) internal view returns (PolicyInput memory pi) {
        SelectorRule[] memory sels = new SelectorRule[](1);
        sels[0] = SelectorRule({selector: selector, valueCapPerCall: 0, tier: tier, delaySeconds: delaySec});
        TargetRule[] memory targets = new TargetRule[](1);
        targets[0] = TargetRule({target: address(target), selectors: sels});

        pi = PolicyInput({
            targets: targets,
            dailySpendWeiCap: 0,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 365 days),
            paused: false
        });
    }

    function _intent(address t, bytes4 selector, uint256 value) internal pure returns (Intent memory) {
        return Intent({
            agentId: 1,
            requestId: 1,
            target: t,
            selector: selector,
            data: abi.encodeWithSelector(selector),
            value: value,
            promptHash: bytes32(0),
            taskClass: 0
        });
    }
}
