// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/PolicyTypes.sol";
import "../src/SentryOracle.sol";
import "../src/SentryQueue.sol";
import "../src/integration/QueueAgentBase.sol";
import "./mocks/MockSentryOracle.sol";
import "./mocks/MockTarget.sol";

contract MockSentryQueue {
    SentryQueue.State public nextState = SentryQueue.State.Committed;
    bool public revertImmediate;
    bool public revertTooEarly;
    bool public revertPastDeadline;
    bool public revertNotPending;
    uint256 public nextExecId = 1;
    Intent private storedIntent;
    mapping(uint256 => bool) public expireIfStaleCalled;

    event MockEnqueued(uint256 indexed execId, bytes32 indexed policyId, address indexed asker);

    function enqueue(bytes32 policyId, Intent calldata intent, uint256) external returns (uint256 execId) {
        if (revertImmediate) revert SentryQueue.NotQueueable(bytes32("IMMEDIATE_NO_QUEUE_NEEDED"));
        execId = nextExecId++;
        storedIntent = intent;
        emit MockEnqueued(execId, policyId, msg.sender);
    }

    function dispatch(uint256) external view returns (Intent memory) {
        if (revertTooEarly) revert SentryQueue.TooEarly();
        if (revertPastDeadline) revert SentryQueue.PastDeadline();
        if (revertNotPending) revert SentryQueue.NotPending();
        return storedIntent;
    }

    function getRecord(uint256) external view returns (SentryQueue.QueuedIntent memory record) {
        record.intent = storedIntent;
        record.state = nextState;
    }

    function expireIfStale(uint256 execId) external {
        expireIfStaleCalled[execId] = true;
    }

    function setStoredIntent(Intent calldata intent) external {
        storedIntent = intent;
    }

    function setRevertImmediate(bool value) external {
        revertImmediate = value;
    }

    function setRevertTooEarly(bool value) external {
        revertTooEarly = value;
    }

    function setRevertPastDeadline(bool value) external {
        revertPastDeadline = value;
    }

    function setRevertNotPending(bool value) external {
        revertNotPending = value;
    }

    function setNextState(SentryQueue.State value) external {
        nextState = value;
    }
}

contract QueueAgentHarness is QueueAgentBase {
    uint256 public expireCount;
    uint256 public lastExpiredExecId;
    address public lastExpiredTarget;
    uint256 public lastExpiredValue;

    constructor(SentryOracle oracle_, SentryQueue queue_, address owner_) QueueAgentBase(oracle_, queue_, owner_) {}

    receive() external payable {}

    function enqueuePing(address target, uint256 value, uint256 reqId) external returns (uint256) {
        return _sentryEnqueueDelayed(target, abi.encodeWithSelector(MockTarget.ping.selector), value, reqId);
    }

    function _onQueueExpire(uint256 execId, address target, uint256 value) internal override {
        expireCount += 1;
        lastExpiredExecId = execId;
        lastExpiredTarget = target;
        lastExpiredValue = value;
    }
}

contract QueueAgentBaseTest is Test {
    MockSentryOracle internal oracle;
    MockSentryQueue internal queue;
    MockTarget internal target;
    QueueAgentHarness internal agent;

    address internal owner = address(0xA11CE);
    address internal stranger = address(0xB0B);

    function setUp() public {
        oracle = new MockSentryOracle();
        queue = new MockSentryQueue();
        target = new MockTarget();
        agent = new QueueAgentHarness(SentryOracle(address(oracle)), SentryQueue(address(queue)), owner);
        vm.deal(address(agent), 10 ether);
        vm.prank(owner);
        agent.setPolicyId(bytes32("queue-policy"));
    }

    function test_sentryEnqueueDelayed_happyPathChecksThenEnqueues() public {
        oracle.expectCheck(address(target), MockTarget.ping.selector);
        oracle.setNextResult(false, bytes32("REQUIRES_DELAY"));

        vm.expectEmit(true, true, true, false, address(queue));
        emit MockSentryQueue.MockEnqueued(1, bytes32("queue-policy"), address(agent));

        uint256 execId = agent.enqueuePing(address(target), 0, 99);

        assertEq(execId, 1);
    }

    function test_enqueueImmediatePolicyPassesQueueErrorThrough() public {
        oracle.expectCheck(address(target), MockTarget.ping.selector);
        oracle.setNextResult(true, bytes32(0));
        queue.setRevertImmediate(true);

        vm.expectRevert(abi.encodeWithSelector(SentryQueue.NotQueueable.selector, bytes32("IMMEDIATE_NO_QUEUE_NEEDED")));
        agent.enqueuePing(address(target), 0, 1);
    }

    function test_dispatchQueued_happyPathOwnerDispatchesAndExecutes() public {
        _storePingIntent(0);

        vm.prank(owner);
        bytes memory returndata = agent.dispatchQueued(1);

        assertEq(returndata.length, 0);
        assertEq(target.pings(), 1);
    }

    function test_dispatchQueued_nonOwnerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(SentryAgentBase.NotOwner.selector);
        agent.dispatchQueued(1);
    }

    function test_dispatchQueuedBeforeDelayPassesQueueErrorThrough() public {
        _storePingIntent(0);
        queue.setRevertTooEarly(true);

        vm.prank(owner);
        vm.expectRevert(SentryQueue.TooEarly.selector);
        agent.dispatchQueued(1);
    }

    function test_onQueueExpireHookFiresWhenDispatchAttemptIsPastExpiry() public {
        _storePingIntent(2 ether);
        queue.setRevertPastDeadline(true);

        vm.prank(owner);
        bytes memory returndata = agent.dispatchQueued(7);

        assertEq(returndata.length, 0);
        assertEq(agent.expireCount(), 1);
        assertEq(agent.lastExpiredExecId(), 7);
        assertEq(agent.lastExpiredTarget(), address(target));
        assertEq(agent.lastExpiredValue(), 2 ether);
        assertEq(target.pings(), 0, "expired dispatch must not execute");
    }

    function test_onQueueExpire_firesOnlyOnce_andMarksExpired() public {
        _storePingIntent(0);
        queue.setRevertPastDeadline(true);

        vm.prank(owner);
        agent.dispatchQueued(1);
        assertEq(agent.expireCount(), 1, "hook fires once");
        assertTrue(queue.expireIfStaleCalled(1), "helper marked the record expired");

        // Retry: mock returns NotPending now, so dispatch rethrows instead of re-firing.
        queue.setRevertPastDeadline(false);
        queue.setRevertNotPending(true);
        vm.prank(owner);
        vm.expectRevert(SentryQueue.NotPending.selector);
        agent.dispatchQueued(1);
        assertEq(agent.expireCount(), 1, "hook not repeated on retry");
    }

    function _storePingIntent(uint256 value) private {
        Intent memory intent = Intent({
            agentId: 0,
            requestId: 1,
            target: address(target),
            selector: MockTarget.ping.selector,
            data: abi.encodeWithSelector(MockTarget.ping.selector),
            value: value,
            promptHash: bytes32(0),
            taskClass: 0
        });
        queue.setStoredIntent(intent);
    }
}
