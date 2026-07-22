// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "sentry-somnia/PolicyTypes.sol";
import "sentry-somnia/SentryOracle.sol";
import "sentry-somnia/integration/SentryAgentBase.sol";
import {Counter} from "../src/Counter.sol";
import {CounterAgent} from "../src/CounterAgent.sol";

/// @notice Coverage for the late-binding pattern on CounterAgent:
///         - ungated when POLICY_ID == 0x0
///         - gated correctly after setPolicyId(valid)
///         - re-ungated after setPolicyId(0x0) (emergency kill-switch)
///         - setPolicyId access control + PolicyBound event
///         - transferOwnership semantics
contract CounterAgentLateBindingTest is Test {
    SentryOracle internal oracle;
    Counter internal counter;
    CounterAgent internal agent;

    address internal deployer = address(0xD3);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal constant LABEL = bytes32("counter-demo");

    // Selectors are the AGENT's own entrypoints (entrypoint-policy model)
    // — not the downstream Counter's selectors. The policy authorizes the
    // agent address with these selectors directly.
    bytes4 internal constant BUMP_SELECTOR = bytes4(keccak256("bump(uint256)"));

    function setUp() public {
        oracle = new SentryOracle();
        counter = new Counter();
        // deployer becomes owner of the agent
        vm.prank(deployer);
        agent = new CounterAgent(oracle, counter, deployer);
    }

    // ---------- ungated path (POLICY_ID == 0x0) ----------

    function test_bump_succeeds_when_policyId_unset() public {
        assertEq(agent.POLICY_ID(), bytes32(0), "starts unbound");
        // deployer is the constructor-bootstrapped operator; the
        // sentryGuarded layer short-circuits while unbound.
        vm.prank(deployer);
        agent.bump(7);
        assertEq(counter.value(), 7, "bumped despite no policy");
    }

    function test_reset_succeeds_when_policyId_unset() public {
        vm.prank(deployer);
        agent.bump(9);
        vm.prank(deployer);
        agent.reset();
        assertEq(counter.value(), 0, "reset went through ungated");
    }

    // ---------- gated path ----------

    function test_reset_reverts_with_SentryRejected_when_policy_authorizes_only_bump() public {
        bytes32 pid = _publishBumpOnlyPolicy(deployer);

        vm.prank(deployer);
        agent.setPolicyId(pid);

        // bump is allowed by policy → succeeds (deployer is operator)
        vm.prank(deployer);
        agent.bump(3);
        assertEq(counter.value(), 3);

        // reset is NOT in the policy → the sentryGuarded modifier surfaces
        // the oracle denial as the typed SentryRejected error. The revert
        // IS the deny-path proof — no in-contract catch-and-emit needed.
        vm.prank(deployer);
        vm.expectRevert(
            abi.encodeWithSelector(SentryAgentBase.SentryRejected.selector, bytes32("SELECTOR_NOT_ALLOWED"))
        );
        agent.reset();
        assertEq(counter.value(), 3, "reset blocked by policy");
    }

    function test_bump_reverts_with_SentryRejected_when_target_not_allowed() public {
        // Publish a policy that allows bump on a DIFFERENT target.
        PolicyInput memory input = _policyForTarget(address(0xDEAD), BUMP_SELECTOR);
        vm.prank(deployer);
        bytes32 pid = oracle.publishPolicy(LABEL, input);

        vm.prank(deployer);
        agent.setPolicyId(pid);

        // The sentryGuarded modifier surfaces oracle denials as the typed
        // SentryRejected error from SentryAgentBase.
        vm.prank(deployer);
        vm.expectRevert(
            abi.encodeWithSelector(SentryAgentBase.SentryRejected.selector, bytes32("TARGET_NOT_ALLOWED"))
        );
        agent.bump(1);
    }

    // ---------- emergency kill-switch ----------

    function test_setPolicyId_zero_returns_agent_to_ungated() public {
        bytes32 pid = _publishBumpOnlyPolicy(deployer);
        vm.prank(deployer);
        agent.setPolicyId(pid);
        assertTrue(agent.POLICY_ID() != bytes32(0));

        // Now unbind.
        vm.prank(deployer);
        agent.setPolicyId(bytes32(0));
        assertEq(agent.POLICY_ID(), bytes32(0));

        // Reset would have been rejected when gated; now it goes through.
        vm.prank(deployer);
        agent.bump(2);
        vm.prank(deployer);
        agent.reset();
        assertEq(counter.value(), 0);
    }

    // ---------- access control ----------

    function test_setPolicyId_from_non_owner_reverts() public {
        vm.prank(alice);
        vm.expectRevert(SentryAgentBase.NotOwner.selector);
        agent.setPolicyId(bytes32(uint256(1)));
    }

    function test_PolicyBound_event_emitted_on_every_set() public {
        bytes32 newId = bytes32(uint256(0x1234));

        vm.expectEmit(true, true, true, true, address(agent));
        emit SentryAgentBase.PolicyBound(newId, bytes32(0), deployer);
        vm.prank(deployer);
        agent.setPolicyId(newId);

        bytes32 nextId = bytes32(uint256(0x5678));
        vm.expectEmit(true, true, true, true, address(agent));
        emit SentryAgentBase.PolicyBound(nextId, newId, deployer);
        vm.prank(deployer);
        agent.setPolicyId(nextId);

        // unbind also emits with the previous id as oldPolicyId
        vm.expectEmit(true, true, true, true, address(agent));
        emit SentryAgentBase.PolicyBound(bytes32(0), nextId, deployer);
        vm.prank(deployer);
        agent.setPolicyId(bytes32(0));
    }

    // ---------- ownership transfer ----------

    function test_transferOwnership_swaps_authority() public {
        vm.prank(deployer);
        agent.transferOwnership(alice);
        assertEq(agent.owner(), alice);

        // old owner can no longer setPolicyId
        vm.prank(deployer);
        vm.expectRevert(SentryAgentBase.NotOwner.selector);
        agent.setPolicyId(bytes32(uint256(1)));

        // new owner can
        vm.prank(alice);
        agent.setPolicyId(bytes32(uint256(0xabc)));
        assertEq(agent.POLICY_ID(), bytes32(uint256(0xabc)));
    }

    function test_transferOwnership_from_non_owner_reverts() public {
        vm.prank(bob);
        vm.expectRevert(SentryAgentBase.NotOwner.selector);
        agent.transferOwnership(bob);
    }

    function test_constructor_rejects_zero_owner() public {
        vm.expectRevert(SentryAgentBase.ZeroOwner.selector);
        new CounterAgent(oracle, counter, address(0));
    }

    // ---------- operator allow-list (Solidity layer, on TOP of Sentry) ----------

    function test_constructor_sets_owner_as_initial_operator() public view {
        // Deployer was passed as owner in setUp; constructor bootstraps the
        // owner as the initial operator so the deploy-time wallet can bump
        // immediately without a separate addOperator tx.
        assertTrue(agent.isOperator(deployer), "deployer bootstrapped as operator");
        assertFalse(agent.isOperator(alice), "alice not seeded");
        assertFalse(agent.isOperator(bob), "bob not seeded");
    }

    function test_bump_reverts_with_NotOperator_for_unauthorized_caller() public {
        // alice is not an operator → onlyOperator rejects BEFORE the
        // sentryGuarded layer can run. POLICY_ID is still 0x0 here so this
        // test alone does not pin modifier order — the ungated short-circuit
        // would also revert NotOperator. See
        // test_modifier_order_caller_check_runs_before_oracle for the
        // load-bearing pin.
        vm.prank(alice);
        vm.expectRevert(CounterAgent.NotOperator.selector);
        agent.bump(1);
    }

    function test_reset_reverts_with_NotOperator_for_unauthorized_caller() public {
        vm.prank(alice);
        vm.expectRevert(CounterAgent.NotOperator.selector);
        agent.reset();
    }

    function test_addOperator_by_owner_lets_grantee_bump() public {
        vm.prank(deployer);
        agent.addOperator(bob);
        assertTrue(agent.isOperator(bob));

        // bob can now bump; passes the Sentry layer because POLICY_ID is unset.
        vm.prank(bob);
        agent.bump(4);
        assertEq(counter.value(), 4);
    }

    function test_removeOperator_by_owner_revokes_bump_rights() public {
        vm.startPrank(deployer);
        agent.addOperator(bob);
        agent.removeOperator(bob);
        vm.stopPrank();
        assertFalse(agent.isOperator(bob));

        vm.prank(bob);
        vm.expectRevert(CounterAgent.NotOperator.selector);
        agent.bump(1);
    }

    function test_addOperator_reverts_for_non_owner() public {
        // alice has neither owner nor operator privileges; addOperator is
        // owner-gated via the inherited onlyOwner.
        vm.prank(alice);
        vm.expectRevert(SentryAgentBase.NotOwner.selector);
        agent.addOperator(bob);
    }

    function test_modifier_order_caller_check_runs_before_oracle() public {
        // LOAD-BEARING modifier-order pin. Bind the bump-only policy, then
        // have alice (non-operator) call `reset` — which the policy ALSO
        // rejects (SELECTOR_NOT_ALLOWED). Under the correct order
        // `onlyOperator sentryGuarded(...)`, the cheap Solidity check fires
        // first and the revert is `NotOperator`. If a regression reorders to
        // `sentryGuarded(...) onlyOperator`, the oracle's
        // `SELECTOR_NOT_ALLOWED` would fire first instead. Asserting
        // NotOperator on the bound+unauthorized path is what actually pins
        // the order.
        bytes32 pid = _publishBumpOnlyPolicy(deployer);
        vm.prank(deployer);
        agent.setPolicyId(pid);

        vm.prank(alice);
        vm.expectRevert(CounterAgent.NotOperator.selector);
        agent.reset();
    }

    // ---------- helpers ----------

    function _publishBumpOnlyPolicy(address publisher) internal returns (bytes32) {
        // Entrypoint-policy model: target is the AGENT, selector is the
        // agent's own bump entrypoint (NOT the downstream Counter.bump).
        PolicyInput memory input = _policyForTarget(address(agent), BUMP_SELECTOR);
        vm.prank(publisher);
        return oracle.publishPolicy(LABEL, input);
    }

    function _policyForTarget(address t, bytes4 sel) internal view returns (PolicyInput memory input) {
        SelectorRule[] memory sels = new SelectorRule[](1);
        sels[0] = SelectorRule({
            selector: sel,
            valueCapPerCall: 0,
            tier: TIER_IMMEDIATE,
            delaySeconds: 0
        });
        TargetRule[] memory targets = new TargetRule[](1);
        targets[0] = TargetRule({target: t, selectors: sels});
        input = PolicyInput({
            targets: targets,
            dailySpendWeiCap: 0,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 365 days),
            paused: false
        });
    }
}
