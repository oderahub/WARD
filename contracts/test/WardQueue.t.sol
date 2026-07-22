// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/PolicyTypes.sol";
import "../src/WardOracle.sol";
import "../src/WardQueue.sol";
import "./mocks/MockTarget.sol";

/// @notice Unit coverage for WardQueue. Each test pins one invariant.
contract WardQueueTest is Test {
    WardOracle internal oracle;
    WardQueue internal queue;
    MockTarget internal target;

    address internal alice = address(0xA11CE); // policy publisher / owner
    address internal asker = address(0xB0B); // asking agent
    address internal stranger = address(0xCAFE); // unrelated EOA

    bytes32 internal constant LABEL = bytes32("queue-test");

    bytes4 internal constant SEL_PING = MockTarget.ping.selector;
    bytes4 internal constant SEL_PONG = MockTarget.pong.selector;

    // policyId derived from (alice, LABEL)
    bytes32 internal policyId;

    function setUp() public {
        oracle = new WardOracle();
        queue = new WardQueue(oracle);
        target = new MockTarget();

        // Publish a policy with two selectors:
        //   ping → DELAYED, 60s
        //   pong → VETO_REQUIRED, 0s (per PolicyNormalizer rule: VETO_REQUIRED has delaySeconds=0)
        SelectorRule[] memory sels = new SelectorRule[](2);
        sels[0] = SelectorRule({selector: SEL_PING, valueCapPerCall: 0, tier: TIER_DELAYED, delaySeconds: 60});
        sels[1] = SelectorRule({selector: SEL_PONG, valueCapPerCall: 0, tier: TIER_VETO_REQUIRED, delaySeconds: 0});
        TargetRule[] memory targets = new TargetRule[](1);
        targets[0] = TargetRule({target: address(target), selectors: sels});
        PolicyInput memory pi = PolicyInput({
            targets: targets,
            dailySpendWeiCap: 0,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 365 days),
            paused: false
        });
        vm.prank(alice);
        policyId = oracle.publishPolicy(LABEL, pi);
    }

    // ---------- enqueue ----------

    function test_enqueue_rejects_immediate_intent() public {
        // Publish a 2nd policy with an IMMEDIATE selector and try to enqueue against it.
        SelectorRule[] memory s = new SelectorRule[](1);
        s[0] = SelectorRule({selector: SEL_PING, valueCapPerCall: 0, tier: TIER_IMMEDIATE, delaySeconds: 0});
        TargetRule[] memory t = new TargetRule[](1);
        t[0] = TargetRule({target: address(target), selectors: s});
        PolicyInput memory pi = PolicyInput({
            targets: t,
            dailySpendWeiCap: 0,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 1 days),
            paused: false
        });
        vm.prank(alice);
        bytes32 immId = oracle.publishPolicy(bytes32("immediate"), pi);

        vm.prank(asker);
        vm.expectRevert(abi.encodeWithSelector(WardQueue.NotQueueable.selector, bytes32("IMMEDIATE_NO_QUEUE_NEEDED")));
        queue.enqueue(immId, _intent(address(target), SEL_PING), 0);
    }

    function test_enqueue_rejects_illegal_intent() public {
        // Intent targets an address not in the policy → TARGET_NOT_ALLOWED, NOT a queueable reason.
        vm.prank(asker);
        vm.expectRevert(abi.encodeWithSelector(WardQueue.NotQueueable.selector, bytes32("TARGET_NOT_ALLOWED")));
        queue.enqueue(policyId, _intent(address(0xDEAD), SEL_PING), 0);
    }

    function test_enqueue_DELAYED_happy_path() public {
        Intent memory intent = _intent(address(target), SEL_PING);
        uint64 expectedEarliest = uint64(block.timestamp) + 60;
        uint64 expectedDeadline = expectedEarliest + queue.COMMIT_WINDOW_SECONDS();
        bytes32 expectedCalldataHash = keccak256(intent.data);

        vm.expectEmit(true, true, true, true, address(queue));
        emit WardQueue.Enqueued(
            1, policyId, asker, TIER_DELAYED, expectedEarliest, expectedDeadline, expectedCalldataHash
        );

        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, intent, 0);
        assertEq(execId, 1);

        WardQueue.QueuedIntent memory q = queue.getRecord(execId);
        assertEq(q.policyId, policyId);
        assertEq(q.asker, asker);
        assertEq(q.tier, TIER_DELAYED);
        assertEq(q.earliestCommitAt, expectedEarliest);
        assertEq(q.deadline, expectedDeadline);
        assertEq(uint8(q.state), uint8(WardQueue.State.Pending));
    }

    function test_enqueue_VETO_REQUIRED_happy_path() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PONG), 0);
        WardQueue.QueuedIntent memory q = queue.getRecord(execId);
        assertEq(q.tier, TIER_VETO_REQUIRED);
        assertEq(q.earliestCommitAt, uint64(block.timestamp));
        assertEq(uint8(q.state), uint8(WardQueue.State.Pending));
    }

    // ---------- dispatch (DELAYED) ----------

    function test_dispatch_DELAYED_reverts_TooEarly_before_delay() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        vm.prank(asker);
        vm.expectRevert(WardQueue.TooEarly.selector);
        queue.dispatch(execId);
    }

    function test_dispatch_DELAYED_reverts_when_caller_is_not_asker() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        skip(61);
        vm.prank(stranger);
        vm.expectRevert(WardQueue.NotAuthorizedDispatcher.selector);
        queue.dispatch(execId);
    }

    function test_dispatch_DELAYED_happy_path_marks_committed_and_returns_intent() public {
        Intent memory intent = _intent(address(target), SEL_PING);
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, intent, 0);
        skip(61);

        bytes32 expectedIntentHash = keccak256(abi.encode(intent));
        vm.expectEmit(true, true, true, true, address(queue));
        emit WardQueue.Dispatched(execId, asker, policyId, expectedIntentHash);

        vm.prank(asker);
        Intent memory got = queue.dispatch(execId);
        assertEq(got.target, address(target));
        assertEq(got.selector, SEL_PING);
        assertEq(uint8(queue.getRecord(execId).state), uint8(WardQueue.State.Committed));
    }

    function test_dispatch_reverts_PastDeadline() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        skip(60 + uint256(queue.COMMIT_WINDOW_SECONDS()) + 1);
        vm.prank(asker);
        vm.expectRevert(WardQueue.PastDeadline.selector);
        queue.dispatch(execId);
    }

    function test_dispatch_reverts_NotPending_after_committed() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        skip(61);
        vm.prank(asker);
        queue.dispatch(execId);
        // Second dispatch
        vm.prank(asker);
        vm.expectRevert(WardQueue.NotPending.selector);
        queue.dispatch(execId);
    }

    // ---------- dispatch (VETO_REQUIRED) ----------

    function test_dispatch_VETO_REQUIRED_reverts_when_caller_is_not_policyOwner() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PONG), 0);
        vm.prank(asker); // asker tries to dispatch their own VETO_REQUIRED intent
        vm.expectRevert(WardQueue.NotPolicyOwner.selector);
        queue.dispatch(execId);
    }

    function test_dispatch_VETO_REQUIRED_happy_path_with_policyOwner() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PONG), 0);
        vm.prank(alice); // alice is the policy owner
        Intent memory got = queue.dispatch(execId);
        assertEq(got.selector, SEL_PONG);
        assertEq(uint8(queue.getRecord(execId).state), uint8(WardQueue.State.Committed));
    }

    // ---------- dispatch policy revalidation ----------

    function test_dispatch_reverts_PolicyChanged_PAUSED() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        // Owner pauses the policy mid-window
        PolicyInput memory paused = _basePolicy();
        paused.paused = true;
        vm.prank(alice);
        oracle.updatePolicy(policyId, paused);
        skip(61);
        vm.prank(asker);
        vm.expectRevert(abi.encodeWithSelector(WardQueue.PolicyChanged.selector, bytes32("PAUSED")));
        queue.dispatch(execId);
    }

    function test_dispatch_reverts_PolicyChanged_EXPIRED() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        // Owner shortens the expiry to right now
        PolicyInput memory updated = _basePolicy();
        updated.expiresAt = uint64(block.timestamp + 30); // < the 61-second wait we're about to do
        vm.prank(alice);
        oracle.updatePolicy(policyId, updated);
        skip(61);
        vm.prank(asker);
        vm.expectRevert(abi.encodeWithSelector(WardQueue.PolicyChanged.selector, bytes32("EXPIRED")));
        queue.dispatch(execId);
    }

    // ---------- veto ----------

    function test_veto_reverts_when_caller_is_not_policyOwner() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        vm.prank(stranger);
        vm.expectRevert(WardQueue.NotPolicyOwner.selector);
        queue.veto(execId, bytes32("OOPS"));
    }

    function test_veto_happy_path_marks_vetoed() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        vm.prank(alice);
        queue.veto(execId, bytes32("RUG_SMELL"));
        assertEq(uint8(queue.getRecord(execId).state), uint8(WardQueue.State.Vetoed));
    }

    function test_veto_reverts_NotPending_when_terminal() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        vm.prank(alice);
        queue.veto(execId, bytes32("X"));
        vm.prank(alice);
        vm.expectRevert(WardQueue.NotPending.selector);
        queue.veto(execId, bytes32("Y"));
    }

    // ---------- expireIfStale ----------

    function test_expireIfStale_reverts_TooEarly_before_deadline() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        // still inside the window
        skip(60);
        vm.expectRevert(WardQueue.TooEarly.selector);
        queue.expireIfStale(execId);
    }

    function test_expireIfStale_happy_path_anyone_can_call() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        skip(60 + uint256(queue.COMMIT_WINDOW_SECONDS()) + 1);
        vm.prank(stranger);
        queue.expireIfStale(execId);
        assertEq(uint8(queue.getRecord(execId).state), uint8(WardQueue.State.Expired));
    }

    function test_expireIfStale_reverts_NotPending_when_terminal() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        vm.prank(alice);
        queue.veto(execId, bytes32("X"));
        skip(60 + uint256(queue.COMMIT_WINDOW_SECONDS()) + 1);
        vm.expectRevert(WardQueue.NotPending.selector);
        queue.expireIfStale(execId);
    }

    // ---------- getRecordHeader ----------

    function test_getRecordHeader_omits_intent_data_keeps_fixed_intent_fields() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        WardQueue.RecordHeader memory h = queue.getRecordHeader(execId);
        assertEq(h.policyId, policyId);
        assertEq(h.asker, asker);
        assertEq(h.tier, TIER_DELAYED);
        assertEq(uint8(h.state), uint8(WardQueue.State.Pending));
        // Fixed-size intent fields surfaced for cheap filtering:
        assertEq(h.target, address(target));
        assertEq(h.selector, SEL_PING);
        assertEq(h.value, 0);
        assertEq(h.requestId, 1);
    }

    // ---------- approve + asker dispatch ----------

    function test_veto_approve_then_asker_can_dispatch() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PONG), 0);
        vm.prank(alice);
        queue.approve(execId);
        assertEq(queue.approvedBy(execId), alice);
        vm.prank(asker);
        Intent memory got = queue.dispatch(execId);
        assertEq(got.selector, SEL_PONG);
        assertEq(uint8(queue.getRecord(execId).state), uint8(WardQueue.State.Committed));
    }

    function test_veto_approval_voided_by_ownership_transfer() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PONG), 0);
        vm.prank(alice); // old owner approves
        queue.approve(execId);
        // transfer policy ownership alice -> carol (two-step)
        address carol = address(0xCccc);
        vm.prank(alice);
        oracle.transferPolicyOwnership(policyId, carol);
        vm.prank(carol);
        oracle.acceptPolicyOwnership(policyId);
        // stale approval (by alice) is now void: asker cannot dispatch
        vm.prank(asker);
        vm.expectRevert(WardQueue.NotPolicyOwner.selector);
        queue.dispatch(execId);
        // new owner can re-approve, then asker can dispatch
        vm.prank(carol);
        queue.approve(execId);
        vm.prank(asker);
        queue.dispatch(execId);
        assertEq(uint8(queue.getRecord(execId).state), uint8(WardQueue.State.Committed));
    }

    function test_veto_asker_dispatch_without_approval_reverts() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PONG), 0);
        vm.prank(asker);
        vm.expectRevert(WardQueue.NotPolicyOwner.selector);
        queue.dispatch(execId);
    }

    function test_veto_owner_direct_dispatch_still_works() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, _intent(address(target), SEL_PONG), 0);
        vm.prank(alice);
        queue.dispatch(execId);
        assertEq(uint8(queue.getRecord(execId).state), uint8(WardQueue.State.Committed));
    }

    function test_approve_rejects_non_owner_and_non_veto_tier() public {
        vm.prank(asker);
        uint256 vetoId = queue.enqueue(policyId, _intent(address(target), SEL_PONG), 0);
        vm.prank(stranger);
        vm.expectRevert(WardQueue.NotPolicyOwner.selector);
        queue.approve(vetoId);

        vm.prank(asker);
        uint256 delayedId = queue.enqueue(policyId, _intent(address(target), SEL_PING), 0);
        vm.prank(alice);
        vm.expectRevert(WardQueue.NotVetoTier.selector);
        queue.approve(delayedId);
    }

    // ---------- helpers ----------

    function _intent(address t, bytes4 selector) internal pure returns (Intent memory) {
        return Intent({
            agentId: 1,
            requestId: 1,
            target: t,
            selector: selector,
            data: abi.encodeWithSelector(selector),
            value: 0,
            promptHash: bytes32(0),
            taskClass: 0
        });
    }

    function _basePolicy() internal view returns (PolicyInput memory pi) {
        SelectorRule[] memory sels = new SelectorRule[](2);
        sels[0] = SelectorRule({selector: SEL_PING, valueCapPerCall: 0, tier: TIER_DELAYED, delaySeconds: 60});
        sels[1] = SelectorRule({selector: SEL_PONG, valueCapPerCall: 0, tier: TIER_VETO_REQUIRED, delaySeconds: 0});
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
}
