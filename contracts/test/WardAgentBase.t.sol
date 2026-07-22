// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/PolicyTypes.sol";
import "../src/WardOracle.sol";
import "../src/integration/WardAgentBase.sol";
import "../src/integration/WardCall.sol";
import "./mocks/MockWardOracle.sol";
import "./mocks/MockTarget.sol";

contract WardCallHarness {
    function check(
        WardOracle oracle,
        bytes32 policyId,
        address target,
        bytes memory data,
        uint256 value,
        uint256 spentToday
    ) external returns (bool ok, bytes32 reason) {
        return WardCall.check(oracle, policyId, target, data, value, spentToday);
    }
}

contract WardAgentHarness is WardAgentBase {
    constructor(WardOracle oracle_, address owner_) WardAgentBase(oracle_, owner_) {}

    receive() external payable {}

    function guardedPing(address target, uint256 value) external payable returns (bytes memory) {
        bytes memory data = abi.encodeWithSelector(MockTarget.ping.selector);
        _wardCheck(target, data, value, _wardSpentToday());
        return _call(target, data, value);
    }

    function guardedPong(address target, uint256 value, uint256 nonce) external payable returns (bytes memory) {
        bytes memory data = abi.encodeWithSelector(MockTarget.pong.selector, nonce);
        _wardCheck(target, data, value, _wardSpentToday());
        return _call(target, data, value);
    }

    /// @notice One-shot variant using the `wardGuarded` modifier (entrypoint-policy
    ///         model). The modifier checks the agent's OWN selector against a policy
    ///         that targets `address(this)`; the body then performs the downstream call
    ///         directly because the modifier already pre-reserved spend (routing through
    ///         `_call` would double-count).
    function modifierPing(address target, uint256 value)
        external
        payable
        wardGuarded(this.modifierPing.selector, value)
        returns (bool success)
    {
        (success,) = target.call{value: value}(abi.encodeWithSelector(MockTarget.ping.selector));
        require(success, "ping failed");
    }

    function modifierPong(address target, uint256 value, uint256 nonce)
        external
        payable
        wardGuarded(this.modifierPong.selector, value)
        returns (bool success)
    {
        (success,) = target.call{value: value}(abi.encodeWithSelector(MockTarget.pong.selector, nonce));
        require(success, "pong failed");
    }

    function spentToday() external view returns (uint256) {
        return _wardSpentToday();
    }
}

contract TrackingTarget {
    MockWardOracle public immutable observer;
    uint256 public pings;
    uint256 public lastValue;

    constructor(MockWardOracle observer_) {
        observer = observer_;
    }

    function ping() external payable {
        pings += 1;
        lastValue = msg.value;
        observer.recordExternalCall(address(this), this.ping.selector);
    }
}

contract WardAgentBaseTest is Test {
    WardOracle internal oracle;
    MockTarget internal target;
    WardAgentHarness internal agent;

    address internal owner = address(0xA11CE);
    address internal stranger = address(0xB0B);
    bytes32 internal constant LABEL = bytes32("agent-policy");

    event PolicyBound(bytes32 indexed newPolicyId, bytes32 indexed oldPolicyId, address indexed by);

    function setUp() public {
        oracle = new WardOracle();
        target = new MockTarget();
        agent = new WardAgentHarness(oracle, owner);
    }

    function test_lateBindingPolicyAllowsAfterSetPolicyId() public {
        bytes32 policyId = _publishPolicy(MockTarget.ping.selector, 1 ether, 10 ether);

        vm.prank(owner);
        agent.setPolicyId(policyId);

        agent.guardedPing(address(target), 0);
        assertEq(target.pings(), 1, "target call should execute after binding");
    }

    function test_killSwitchPolicyZeroRunsUngated() public {
        bytes32 policyId = _publishPolicy(MockTarget.pong.selector, 1 ether, 10 ether);

        vm.prank(owner);
        agent.setPolicyId(policyId);
        vm.prank(owner);
        agent.setPolicyId(bytes32(0));

        agent.guardedPing(address(target), 0);
        assertEq(target.pings(), 1, "policy id zero should skip oracle gating");
    }

    function test_wardCheckGatesRejectedSelector() public {
        bytes32 policyId = _publishPolicy(MockTarget.ping.selector, 1 ether, 10 ether);

        vm.prank(owner);
        agent.setPolicyId(policyId);

        vm.expectRevert(abi.encodeWithSelector(WardAgentBase.WardRejected.selector, bytes32("SELECTOR_NOT_ALLOWED")));
        agent.guardedPong(address(target), 0, 7);
    }

    function test_callForwardsValueAndTracksSpend() public {
        bytes32 policyId = _publishPolicy(MockTarget.ping.selector, 2 ether, 10 ether);

        vm.prank(owner);
        agent.setPolicyId(policyId);

        agent.guardedPing{value: 1 ether}(address(target), 1 ether);

        assertEq(target.pings(), 1, "call should land");
        assertEq(target.lastValue(), 1 ether, "value should be forwarded");
        assertEq(agent.spentToday(), 1 ether, "successful call should increment daily spend");
    }

    function test_dailySpendBucketRollsAtUtcMidnight() public {
        bytes32 policyId = _publishPolicy(MockTarget.ping.selector, 2 ether, 10 ether);

        vm.prank(owner);
        agent.setPolicyId(policyId);

        vm.warp(1 days - 1);
        agent.guardedPing{value: 1 ether}(address(target), 1 ether);
        assertEq(agent.spentToday(), 1 ether, "spend counted before midnight");

        vm.warp(1 days);
        assertEq(agent.spentToday(), 0, "new UTC day has a fresh bucket");
    }

    function test_policyBoundEventFires() public {
        bytes32 policyId = bytes32("new-policy");

        vm.expectEmit(true, true, true, true, address(agent));
        emit PolicyBound(policyId, bytes32(0), owner);

        vm.prank(owner);
        agent.setPolicyId(policyId);
    }

    function test_onlyOwnerCanSetPolicyId() public {
        vm.prank(stranger);
        vm.expectRevert(WardAgentBase.NotOwner.selector);
        agent.setPolicyId(bytes32("nope"));
    }

    function test_gateCoverageHelperAssertsCheckBeforeCall() public {
        MockWardOracle mockOracle = new MockWardOracle();
        TrackingTarget trackingTarget = new TrackingTarget(mockOracle);
        WardAgentHarness mockAgent = new WardAgentHarness(WardOracle(address(mockOracle)), owner);

        mockOracle.expectCheck(address(trackingTarget), TrackingTarget.ping.selector);
        vm.prank(owner);
        mockAgent.setPolicyId(bytes32("instrumented"));

        mockAgent.guardedPing(address(trackingTarget), 0);

        mockOracle.assertCheckedBeforeCall();
        assertEq(trackingTarget.pings(), 1, "instrumented target call should execute");
    }

    function test_wardCallDerivesSelectorForEncodeWithSelector() public {
        bytes32 policyId = _publishPolicy(MockTarget.pong.selector, 1 ether, 10 ether);
        WardCallHarness harness = new WardCallHarness();
        bytes memory data = abi.encodeWithSelector(MockTarget.pong.selector, uint256(123));

        (bool ok, bytes32 reason) = harness.check(oracle, policyId, address(target), data, 0, 0);

        assertTrue(ok, "selector derived from calldata should match policy");
        assertEq(reason, bytes32(0));
    }

    function test_wardCallDerivesSelectorForEncodeCall() public {
        bytes32 policyId = _publishPolicy(MockTarget.pong.selector, 1 ether, 10 ether);
        WardCallHarness harness = new WardCallHarness();
        bytes memory data = abi.encodeCall(MockTarget.pong, (uint256(456)));

        (bool ok, bytes32 reason) = harness.check(oracle, policyId, address(target), data, 0, 0);

        assertTrue(ok, "selector derived from abi.encodeCall data should match policy");
        assertEq(reason, bytes32(0));
    }

    // ---------- wardGuarded modifier ----------

    function test_wardGuarded_allowsCallUnderLegalImmediatePolicy() public {
        bytes32 policyId = _publishAgentPolicy(agent.modifierPing.selector, 1 ether, 10 ether);

        vm.prank(owner);
        agent.setPolicyId(policyId);

        agent.modifierPing(address(target), 0);
        assertEq(target.pings(), 1, "modifier-guarded target call should execute");
    }

    function test_wardGuarded_revertsWhenSelectorNotAllowed() public {
        bytes32 policyId = _publishAgentPolicy(agent.modifierPing.selector, 1 ether, 10 ether);

        vm.prank(owner);
        agent.setPolicyId(policyId);

        vm.expectRevert(abi.encodeWithSelector(WardAgentBase.WardRejected.selector, bytes32("SELECTOR_NOT_ALLOWED")));
        agent.modifierPong(address(target), 0, 7);
    }

    function test_wardGuarded_revertsWhenTierIsDelayed() public {
        // DELAYED tier must NOT be reachable via the synchronous modifier path.
        PolicyInput memory input;
        input.targets = new TargetRule[](1);
        input.targets[0].target = address(agent);
        input.targets[0].selectors = new SelectorRule[](1);
        input.targets[0].selectors[0] = SelectorRule({
            selector: agent.modifierPing.selector,
            valueCapPerCall: 1 ether,
            tier: TIER_DELAYED,
            delaySeconds: 60
        });
        input.dailySpendWeiCap = 10 ether;
        input.expiresAt = uint64(block.timestamp + 30 days);
        bytes32 policyId = oracle.publishPolicy(LABEL, input);

        vm.prank(owner);
        agent.setPolicyId(policyId);

        vm.expectRevert(abi.encodeWithSelector(WardAgentBase.WardRejected.selector, bytes32("REQUIRES_DELAY")));
        agent.modifierPing(address(target), 0);
        assertEq(target.pings(), 0, "DELAYED tier must short-circuit before the body runs");
    }

    function test_wardGuarded_killSwitchPolicyZeroRunsUngated() public {
        // POLICY_ID == 0 → modifier skips oracle and skips pre-reservation (value=0).
        agent.modifierPing(address(target), 0);
        assertEq(target.pings(), 1, "policy id zero should skip oracle gating in modifier");
    }

    function test_wardGuarded_preReservesSpendBeforeBody() public {
        // Spend must be booked BEFORE the body's external call so a reentrant call can
        // never see a pre-spend daily budget. We assert spend is counted post-call as a
        // proxy: the modifier increments daily spend exactly once per successful call.
        bytes32 policyId = _publishAgentPolicy(agent.modifierPing.selector, 2 ether, 10 ether);
        vm.prank(owner);
        agent.setPolicyId(policyId);

        vm.deal(address(agent), 1 ether);
        agent.modifierPing{value: 0}(address(target), 1 ether);

        assertEq(target.lastValue(), 1 ether, "value forwarded by body");
        assertEq(agent.spentToday(), 1 ether, "modifier reserved spend exactly once");
    }

    function test_wardGuarded_dailyCapEnforcedAgainstReservedSpend() public {
        // Pre-spending in the modifier means a second call within the same bucket sees the
        // freshly reserved spend and the oracle rejects DAILY_CAP, not VALUE_CAP.
        bytes32 policyId = _publishAgentPolicy(agent.modifierPing.selector, 1 ether, 1 ether);
        vm.prank(owner);
        agent.setPolicyId(policyId);

        vm.deal(address(agent), 2 ether);
        agent.modifierPing{value: 0}(address(target), 1 ether);

        vm.expectRevert(abi.encodeWithSelector(WardAgentBase.WardRejected.selector, bytes32("DAILY_CAP")));
        agent.modifierPing{value: 0}(address(target), 1);
    }

    // ---------- _call pre-reservation ----------

    function test_call_preReservesSpendBeforeExternalCall() public {
        // `_call` now reserves spend BEFORE invoking the target; combined with the existing
        // _wardCheck guard, this closes the read-then-write TOCTOU on dailySpend.
        bytes32 policyId = _publishPolicy(MockTarget.ping.selector, 2 ether, 10 ether);
        vm.prank(owner);
        agent.setPolicyId(policyId);

        vm.deal(address(agent), 1 ether);
        agent.guardedPing{value: 0}(address(target), 1 ether);

        assertEq(agent.spentToday(), 1 ether, "_call should reserve spend once on success");
        assertEq(target.lastValue(), 1 ether, "value still forwarded to target");
    }

    function test_call_spendRollsBackOnRevert() public {
        // If the target reverts, the whole transaction reverts and the pre-reservation
        // unwinds with it — daily spend stays at zero.
        bytes32 policyId = _publishPolicy(MockTarget.ping.selector, 2 ether, 10 ether);
        vm.prank(owner);
        agent.setPolicyId(policyId);

        target.setShouldRevert(true);
        vm.deal(address(agent), 1 ether);
        vm.expectRevert();
        agent.guardedPing{value: 0}(address(target), 1 ether);

        assertEq(agent.spentToday(), 0, "reverted call must not leak spend");
    }

    function _publishPolicy(bytes4 selector, uint256 valueCap, uint256 dailyCap) private returns (bytes32) {
        PolicyInput memory input;
        input.targets = new TargetRule[](1);
        input.targets[0].target = address(target);
        input.targets[0].selectors = new SelectorRule[](1);
        input.targets[0].selectors[0] = SelectorRule({
            selector: selector,
            valueCapPerCall: valueCap,
            tier: TIER_IMMEDIATE,
            delaySeconds: 0
        });
        input.dailySpendWeiCap = dailyCap;
        input.maxSlippageBps = 0;
        input.expiresAt = uint64(block.timestamp + 30 days);
        input.paused = false;

        return oracle.publishPolicy(LABEL, input);
    }

    /// @notice Entrypoint-policy variant: targets the AGENT address itself with one of
    ///         the agent's own entrypoint selectors. Used by the `wardGuarded` modifier
    ///         tests, which now check `address(this)` instead of the downstream target.
    ///         Uses a distinct label to avoid collision with `_publishPolicy`'s LABEL.
    function _publishAgentPolicy(bytes4 selector, uint256 valueCap, uint256 dailyCap) private returns (bytes32) {
        PolicyInput memory input;
        input.targets = new TargetRule[](1);
        input.targets[0].target = address(agent);
        input.targets[0].selectors = new SelectorRule[](1);
        input.targets[0].selectors[0] = SelectorRule({
            selector: selector,
            valueCapPerCall: valueCap,
            tier: TIER_IMMEDIATE,
            delaySeconds: 0
        });
        input.dailySpendWeiCap = dailyCap;
        input.maxSlippageBps = 0;
        input.expiresAt = uint64(block.timestamp + 30 days);
        input.paused = false;

        return oracle.publishPolicy(bytes32("agent-entrypoint-policy"), input);
    }
}
