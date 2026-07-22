// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/PolicyTypes.sol";
import "../src/WardOracle.sol";
import "../src/WardQueue.sol";
import "../src/integration/QueueAgentBase.sol";
import "./mocks/MockTarget.sol";

/// @notice Real-wired harness (WardOracle + WardQueue) exposing a value-bearing
///         DELAYED enqueue plus a spend accessor so spend-reservation can be asserted.
contract QueueSpendHarness is QueueAgentBase {
    constructor(WardOracle oracle_, WardQueue queue_, address owner_) QueueAgentBase(oracle_, queue_, owner_) {}

    receive() external payable {}

    function enqueueValued(address target, uint256 value, uint256 reqId) external returns (uint256) {
        return _wardEnqueueDelayed(target, abi.encodeWithSelector(MockTarget.ping.selector), value, reqId);
    }

    function enqueueVetoValued(address target, uint256 value, uint256 reqId) external returns (uint256) {
        return _wardEnqueueDelayed(target, abi.encodeWithSelector(MockTarget.pong.selector), value, reqId);
    }

    function spentToday() external view returns (uint256) {
        return _wardSpentToday();
    }
}

/// @notice Reproduces the daily-cap over-reservation HIGH: queued DELAYED value intents
///         must reserve against the enqueue-day bucket so the cap cannot be exceeded by
///         enqueuing several intents while spentToday is low, then dispatching them all.
contract QueueAgentSpendTest is Test {
    WardOracle internal oracle;
    WardQueue internal queue;
    MockTarget internal target;
    QueueSpendHarness internal agent;

    address internal owner = address(0xA11CE); // agent owner (triggers dispatch)
    address internal policyOwner = address(0xB0B); // policy publisher / owner (vetoes)
    bytes32 internal constant LABEL = bytes32("spend-policy");

    bytes4 internal constant SEL_PING = MockTarget.ping.selector;

    function setUp() public {
        oracle = new WardOracle();
        queue = new WardQueue(oracle);
        target = new MockTarget();
        agent = new QueueSpendHarness(oracle, queue, owner);

        // Policy: ping is DELAYED, 60s delay, per-call cap 1 ether, daily cap 1 ether.
        //         pong is VETO_REQUIRED, 0s delay, per-call cap 1 ether (for the owner-direct path).
        SelectorRule[] memory sels = new SelectorRule[](2);
        sels[0] = SelectorRule({selector: SEL_PING, valueCapPerCall: 1 ether, tier: TIER_DELAYED, delaySeconds: 60});
        sels[1] =
            SelectorRule({selector: MockTarget.pong.selector, valueCapPerCall: 1 ether, tier: TIER_VETO_REQUIRED, delaySeconds: 0});
        TargetRule[] memory targets = new TargetRule[](1);
        targets[0] = TargetRule({target: address(target), selectors: sels});
        PolicyInput memory pi = PolicyInput({
            targets: targets,
            dailySpendWeiCap: 1 ether,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 365 days),
            paused: false
        });
        vm.prank(policyOwner);
        bytes32 policyId = oracle.publishPolicy(LABEL, pi);

        vm.prank(owner);
        agent.setPolicyId(policyId);

        vm.deal(address(agent), 5 ether);
    }

    function test_second_overcap_enqueue_is_rejected() public {
        vm.prank(owner);
        agent.enqueueValued(address(target), 1 ether, 1); // reserves 1 ether
        assertEq(agent.spentToday(), 1 ether, "enqueue reserves against the daily cap");

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(WardQueue.NotQueueable.selector, bytes32("DAILY_CAP")));
        agent.enqueueValued(address(target), 1 ether, 2);
    }

    function test_dispatch_consumes_reservation_without_double_count() public {
        vm.prank(owner);
        uint256 execId = agent.enqueueValued(address(target), 1 ether, 1);
        skip(61);
        vm.prank(owner);
        agent.dispatchQueued(execId);
        assertEq(agent.spentToday(), 1 ether, "dispatch does not double-count");
        assertEq(target.lastValue(), 1 ether, "value forwarded once");
    }

    function test_settle_releases_reservation_after_veto() public {
        vm.prank(owner);
        uint256 execId = agent.enqueueValued(address(target), 1 ether, 1);
        vm.prank(policyOwner); // the policy owner vetoes on the real queue
        queue.veto(execId, bytes32("NO"));
        agent.settleQueued(execId);
        assertEq(agent.spentToday(), 0, "veto + settle releases the reservation");
    }

    function test_settleQueued_releases_owner_direct_dispatched_veto_reservation() public {
        vm.prank(owner);
        uint256 execId = agent.enqueueVetoValued(address(target), 1 ether, 1); // reserves 1 ether (same day; VETO delay 0)
        assertEq(agent.spentToday(), 1 ether, "veto enqueue reserves");
        // policy owner directly dispatches via the queue (backward-compat path); agent never consumes
        vm.prank(policyOwner);
        queue.dispatch(execId);
        assertEq(uint8(queue.getRecord(execId).state), uint8(WardQueue.State.Committed));
        // before the fix settleQueued is a no-op here (state Committed); after, it releases the stuck reservation
        agent.settleQueued(execId);
        assertEq(agent.spentToday(), 0, "owner-direct-dispatched reservation released");
    }

    function test_settle_after_expire_runs_release_idempotently() public {
        vm.prank(owner);
        uint256 execId = agent.enqueueValued(address(target), 1 ether, 1);
        // Expiry needs the commit window to lapse, which crosses a UTC-day
        // boundary, so spentToday() (current-day bucket) is already 0 here and is
        // not a useful observable. This exercises the Expired branch of
        // settleQueued: it must release the original-day reservation without
        // reverting (e.g. no underflow) and be idempotent on a second call.
        skip(60 + uint256(queue.COMMIT_WINDOW_SECONDS()) + 1);
        queue.expireIfStale(execId);
        assertEq(uint8(queue.getRecord(execId).state), uint8(WardQueue.State.Expired));
        agent.settleQueued(execId);
        agent.settleQueued(execId); // idempotent no-op, must not revert
    }
}
