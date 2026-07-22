// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";

import "../src/PolicyTypes.sol";
import "../src/WardOracle.sol";
import "../src/WardQueue.sol";

contract WardQueuePolicyVersionTest is Test {
    bytes4 private constant SELECTOR = 0x12345678;
    bytes32 private constant LABEL = bytes32("queue-version");
    uint32 private constant DELAY_SECONDS = 1 hours;

    WardOracle private oracle;
    WardQueue private queue;
    bytes32 private policyId;

    address private asker = address(0xA11CE);
    address private target = address(0xBEEF);

    function setUp() public {
        oracle = new WardOracle();
        queue = new WardQueue(oracle);
        policyId = oracle.publishPolicy(LABEL, policy(1 ether));
    }

    function testDispatchRejectsPolicyBodyUpdatesAfterEnqueue() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, intent(), 0);

        WardQueue.RecordHeader memory header = queue.getRecordHeader(execId);
        assertEq(header.policyVersion, 1);

        oracle.updatePolicy(policyId, policy(2 ether));
        assertEq(oracle.policyVersion(policyId), 2);

        vm.warp(block.timestamp + DELAY_SECONDS);
        vm.prank(asker);
        vm.expectRevert(abi.encodeWithSelector(WardQueue.PolicyChanged.selector, bytes32("UPDATED")));
        queue.dispatch(execId);
    }

    function testDispatchStillSucceedsWhenPolicyVersionIsUnchanged() public {
        vm.prank(asker);
        uint256 execId = queue.enqueue(policyId, intent(), 0);

        vm.warp(block.timestamp + DELAY_SECONDS);
        vm.prank(asker);
        Intent memory dispatched = queue.dispatch(execId);

        assertEq(dispatched.target, target);
        WardQueue.RecordHeader memory header = queue.getRecordHeader(execId);
        assertEq(uint256(header.state), uint256(WardQueue.State.Committed));
        assertEq(header.policyVersion, oracle.policyVersion(policyId));
    }

    function policy(uint256 perCallCap) private view returns (PolicyInput memory input) {
        input.targets = new TargetRule[](1);
        input.targets[0].target = target;
        input.targets[0].selectors = new SelectorRule[](1);
        input.targets[0].selectors[0] = SelectorRule({
            selector: SELECTOR, valueCapPerCall: perCallCap, tier: TIER_DELAYED, delaySeconds: DELAY_SECONDS
        });
        input.dailySpendWeiCap = 10 ether;
        input.maxSlippageBps = 0;
        input.expiresAt = uint64(block.timestamp + 30 days);
        input.paused = false;
    }

    function intent() private view returns (Intent memory) {
        return Intent({
            agentId: 1,
            requestId: 1,
            target: target,
            selector: SELECTOR,
            data: abi.encodeWithSelector(SELECTOR),
            value: 0,
            promptHash: bytes32("prompt"),
            taskClass: 0
        });
    }
}
