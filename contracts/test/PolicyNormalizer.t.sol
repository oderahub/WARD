// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../src/PolicyTypes.sol";
import "../src/PolicyLib.sol";
import "../src/PolicyNormalizer.sol";

contract NormalizerHarness {
    Policy internal policy;

    function applyInput(PolicyInput memory input) external {
        PolicyNormalizer.copy(policy, input);
    }

    function targetsLength() external view returns (uint256) {
        return policy.targets.length;
    }

    function targetAt(uint256 i) external view returns (address) {
        return policy.targets[i];
    }

    function isTargetAllowed(address t) external view returns (bool) {
        return policy.isTargetAllowed[t];
    }

    function isSelectorAllowed(address t, bytes4 s) external view returns (bool) {
        return policy.isSelectorAllowed[t][s];
    }

    function valueCap(address t, bytes4 s) external view returns (uint256) {
        return policy.valueCapPerCall[t][s];
    }

    function tierOf(address t, bytes4 s) external view returns (uint8) {
        return policy.tier[t][s];
    }

    function delayFor(address t, bytes4 s) external view returns (uint32) {
        return policy.delaySeconds[t][s];
    }

    function dailyCap() external view returns (uint256) {
        return policy.dailySpendWeiCap;
    }

    function expiresAt() external view returns (uint64) {
        return policy.expiresAt;
    }

    function paused() external view returns (bool) {
        return policy.paused;
    }

    function validate(Intent memory i, uint256 spentToday) external view returns (bool, bytes32) {
        return PolicyLib.validate(policy, i, spentToday);
    }
}

contract PolicyNormalizerTest is Test {
    NormalizerHarness internal h;

    address internal constant TARGET_A = address(0xA000);
    address internal constant TARGET_B = address(0xB000);
    bytes4 internal constant SEL_PING = bytes4(keccak256("ping()"));
    bytes4 internal constant SEL_PONG = bytes4(keccak256("pong()"));
    bytes4 internal constant SEL_NOOP = bytes4(keccak256("noop()"));

    function setUp() public {
        h = new NormalizerHarness();
    }

    // ---------- helpers ----------

    function _input1Target1Sel(address t, bytes4 s, uint256 cap, uint8 tier_, uint32 delay)
        internal
        view
        returns (PolicyInput memory)
    {
        SelectorRule[] memory sels = new SelectorRule[](1);
        sels[0] = SelectorRule(s, cap, tier_, delay);
        TargetRule[] memory targets = new TargetRule[](1);
        targets[0] = TargetRule(t, sels);
        return PolicyInput({
            targets: targets,
            dailySpendWeiCap: 10 ether,
            maxSlippageBps: 50,
            expiresAt: uint64(block.timestamp + 1 days),
            paused: false
        });
    }

    function _emptyInput() internal view returns (PolicyInput memory) {
        TargetRule[] memory targets = new TargetRule[](0);
        return PolicyInput({
            targets: targets, dailySpendWeiCap: 0, maxSlippageBps: 0, expiresAt: uint64(block.timestamp), paused: false
        });
    }

    // ---------- behaviour ----------

    // 1. wipe on empty input
    function test_copy_empty_input_clears_everything() public {
        // seed with one target/selector
        h.applyInput(_input1Target1Sel(TARGET_A, SEL_PING, 1 ether, TIER_IMMEDIATE, 0));
        assertEq(h.targetsLength(), 1);
        // overwrite with empty
        h.applyInput(_emptyInput());
        assertEq(h.targetsLength(), 0);
        assertFalse(h.isTargetAllowed(TARGET_A));
        assertFalse(h.isSelectorAllowed(TARGET_A, SEL_PING));
    }

    // 2. overwrite targets
    function test_copy_overwrites_prior_targets() public {
        h.applyInput(_input1Target1Sel(TARGET_A, SEL_PING, 1 ether, TIER_IMMEDIATE, 0));
        h.applyInput(_input1Target1Sel(TARGET_B, SEL_PING, 2 ether, TIER_IMMEDIATE, 0));
        assertEq(h.targetsLength(), 1);
        assertEq(h.targetAt(0), TARGET_B);
        assertFalse(h.isTargetAllowed(TARGET_A));
        assertTrue(h.isTargetAllowed(TARGET_B));
        assertEq(h.valueCap(TARGET_B, SEL_PING), 2 ether);
        assertEq(h.valueCap(TARGET_A, SEL_PING), 0, "prior cap wiped");
    }

    // 3. overwrite selectors on same target
    function test_copy_overwrites_prior_selectors() public {
        // first policy: TARGET_A.PING
        h.applyInput(_input1Target1Sel(TARGET_A, SEL_PING, 1 ether, TIER_IMMEDIATE, 0));
        // second policy: TARGET_A.PONG
        h.applyInput(_input1Target1Sel(TARGET_A, SEL_PONG, 2 ether, TIER_DELAYED, 30));
        assertFalse(h.isSelectorAllowed(TARGET_A, SEL_PING), "ping selector wiped");
        assertTrue(h.isSelectorAllowed(TARGET_A, SEL_PONG));
        assertEq(h.valueCap(TARGET_A, SEL_PONG), 2 ether);
        assertEq(h.tierOf(TARGET_A, SEL_PONG), TIER_DELAYED);
        assertEq(h.delayFor(TARGET_A, SEL_PONG), 30);
    }

    // 4. reverts on duplicate target in input
    function test_reverts_duplicate_target() public {
        SelectorRule[] memory s1 = new SelectorRule[](1);
        s1[0] = SelectorRule(SEL_PING, 1 ether, TIER_IMMEDIATE, 0);
        SelectorRule[] memory s2 = new SelectorRule[](1);
        s2[0] = SelectorRule(SEL_PONG, 1 ether, TIER_IMMEDIATE, 0);
        TargetRule[] memory targets = new TargetRule[](2);
        targets[0] = TargetRule(TARGET_A, s1);
        targets[1] = TargetRule(TARGET_A, s2); // duplicate
        PolicyInput memory input = PolicyInput({
            targets: targets,
            dailySpendWeiCap: 10 ether,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 1 days),
            paused: false
        });
        vm.expectRevert(abi.encodeWithSelector(DuplicateTarget.selector, TARGET_A));
        h.applyInput(input);
    }

    // 5. reverts on duplicate selector within target
    function test_reverts_duplicate_selector() public {
        SelectorRule[] memory sels = new SelectorRule[](2);
        sels[0] = SelectorRule(SEL_PING, 1 ether, TIER_IMMEDIATE, 0);
        sels[1] = SelectorRule(SEL_PING, 2 ether, TIER_IMMEDIATE, 0); // duplicate
        TargetRule[] memory targets = new TargetRule[](1);
        targets[0] = TargetRule(TARGET_A, sels);
        PolicyInput memory input = PolicyInput({
            targets: targets,
            dailySpendWeiCap: 10 ether,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 1 days),
            paused: false
        });
        vm.expectRevert(abi.encodeWithSelector(DuplicateSelector.selector, TARGET_A, SEL_PING));
        h.applyInput(input);
    }

    // 6. scalars copied
    function test_copy_sets_scalars() public {
        PolicyInput memory input = _input1Target1Sel(TARGET_A, SEL_PING, 1 ether, TIER_IMMEDIATE, 0);
        input.dailySpendWeiCap = 7 ether;
        input.maxSlippageBps = 123;
        input.expiresAt = uint64(block.timestamp + 2 days);
        input.paused = false;
        h.applyInput(input);
        assertEq(h.dailyCap(), 7 ether);
        assertEq(h.expiresAt(), uint64(block.timestamp + 2 days));
        assertFalse(h.paused());
    }

    // 7. paused=true respected
    function test_copy_preserves_paused_when_explicitly_true() public {
        PolicyInput memory input = _input1Target1Sel(TARGET_A, SEL_PING, 1 ether, TIER_IMMEDIATE, 0);
        input.paused = true;
        h.applyInput(input);
        assertTrue(h.paused());
    }

    // 8. round trip then validate
    function test_round_trip_then_validate() public {
        h.applyInput(_input1Target1Sel(TARGET_A, SEL_PING, 1 ether, TIER_IMMEDIATE, 0));
        Intent memory i = Intent({
            agentId: 1,
            requestId: 1,
            target: TARGET_A,
            selector: SEL_PING,
            data: abi.encodeWithSelector(SEL_PING),
            value: 0,
            promptHash: bytes32(0),
            taskClass: 0
        });
        (bool ok, bytes32 reason) = h.validate(i, 0);
        assertTrue(ok);
        assertEq(reason, bytes32(0));
    }

    // 9. gas regression (loose ceiling per Codex recommendation)
    function test_gas_for_typical_policy_under_threshold() public {
        // 5 targets × 3 selectors each = 15 selector rows. Realistic for a working policy.
        TargetRule[] memory targets = new TargetRule[](5);
        for (uint8 t = 0; t < 5; ++t) {
            SelectorRule[] memory sels = new SelectorRule[](3);
            for (uint8 s = 0; s < 3; ++s) {
                sels[s] =
                    SelectorRule(bytes4(uint32(0x10000000) + (uint32(t) << 8) + uint32(s)), 1 ether, TIER_IMMEDIATE, 0);
            }
            targets[t] = TargetRule(address(uint160(0x1000 + t)), sels);
        }
        PolicyInput memory input = PolicyInput({
            targets: targets,
            dailySpendWeiCap: 10 ether,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 1 days),
            paused: false
        });
        uint256 g0 = gasleft();
        h.applyInput(input);
        uint256 used = g0 - gasleft();
        emit log_named_uint("normalizer gas (5 targets x 3 sels)", used);
        assertLt(used, 1_500_000);
    }

    // 10. zero target rejected
    function test_reverts_zero_target() public {
        PolicyInput memory input = _input1Target1Sel(address(0), SEL_PING, 1 ether, TIER_IMMEDIATE, 0);
        vm.expectRevert(ZeroTarget.selector);
        h.applyInput(input);
    }

    // 11. zero selector rejected
    function test_reverts_zero_selector() public {
        PolicyInput memory input = _input1Target1Sel(TARGET_A, bytes4(0), 0, TIER_IMMEDIATE, 0);
        vm.expectRevert(abi.encodeWithSelector(ZeroSelector.selector, TARGET_A));
        h.applyInput(input);
    }

    // 12. invalid tier rejected
    function test_reverts_invalid_tier() public {
        PolicyInput memory input = _input1Target1Sel(TARGET_A, SEL_PING, 1 ether, uint8(99), 0);
        vm.expectRevert(abi.encodeWithSelector(InvalidTier.selector, TARGET_A, SEL_PING, uint8(99)));
        h.applyInput(input);
    }

    // 13. delay on IMMEDIATE rejected
    function test_reverts_delay_on_immediate_tier() public {
        PolicyInput memory input = _input1Target1Sel(TARGET_A, SEL_PING, 1 ether, TIER_IMMEDIATE, 30);
        vm.expectRevert(abi.encodeWithSelector(InvalidDelay.selector, TARGET_A, SEL_PING, TIER_IMMEDIATE, uint32(30)));
        h.applyInput(input);
    }

    // 14. delay on VETO_REQUIRED rejected
    function test_reverts_delay_on_veto_required_tier() public {
        PolicyInput memory input = _input1Target1Sel(TARGET_A, SEL_PING, 1 ether, TIER_VETO_REQUIRED, 30);
        vm.expectRevert(
            abi.encodeWithSelector(InvalidDelay.selector, TARGET_A, SEL_PING, TIER_VETO_REQUIRED, uint32(30))
        );
        h.applyInput(input);
    }

    // 15. too many targets
    function test_reverts_too_many_targets() public {
        TargetRule[] memory targets = new TargetRule[](MAX_TARGETS + 1);
        for (uint256 t; t < targets.length; ++t) {
            SelectorRule[] memory sels = new SelectorRule[](1);
            sels[0] = SelectorRule(bytes4(uint32(0x10000000) + uint32(t)), 1 ether, TIER_IMMEDIATE, 0);
            targets[t] = TargetRule(address(uint160(0x1000 + t)), sels);
        }
        PolicyInput memory input = PolicyInput({
            targets: targets,
            dailySpendWeiCap: 10 ether,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 1 days),
            paused: false
        });
        vm.expectRevert(abi.encodeWithSelector(TooManyTargets.selector, MAX_TARGETS + 1, MAX_TARGETS));
        h.applyInput(input);
    }

    // 16. too many selectors on a single target
    function test_reverts_too_many_selectors_on_one_target() public {
        SelectorRule[] memory sels = new SelectorRule[](MAX_SELECTORS_PER_TARGET + 1);
        for (uint256 s; s < sels.length; ++s) {
            sels[s] = SelectorRule(bytes4(uint32(0x20000000) + uint32(s)), 1 ether, TIER_IMMEDIATE, 0);
        }
        TargetRule[] memory targets = new TargetRule[](1);
        targets[0] = TargetRule(TARGET_A, sels);
        PolicyInput memory input = PolicyInput({
            targets: targets,
            dailySpendWeiCap: 10 ether,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 1 days),
            paused: false
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                TooManySelectors.selector, TARGET_A, MAX_SELECTORS_PER_TARGET + 1, MAX_SELECTORS_PER_TARGET
            )
        );
        h.applyInput(input);
    }
}
