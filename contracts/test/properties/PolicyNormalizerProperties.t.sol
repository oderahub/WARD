// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Test.sol";
import "../../src/PolicyTypes.sol";
import "../../src/PolicyLib.sol";
import "../../src/PolicyNormalizer.sol";

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
}

/// @notice Property fuzz tests for PolicyNormalizer.copy.
contract PolicyNormalizerPropertiesTest is Test {
    NormalizerHarness internal h;

    function setUp() public {
        h = new NormalizerHarness();
    }

    // ---------- input builders ----------

    /// Build a valid PolicyInput with `nTargets` targets each having `nSels` selectors.
    /// Targets and selectors are derived from `seed` so each fuzz run gets a distinct set with no duplicates.
    function _buildInput(uint256 seed, uint256 nTargets, uint256 nSels) internal view returns (PolicyInput memory) {
        TargetRule[] memory targets = new TargetRule[](nTargets);
        for (uint256 t; t < nTargets; ++t) {
            SelectorRule[] memory sels = new SelectorRule[](nSels);
            for (uint256 s; s < nSels; ++s) {
                bytes4 sel = bytes4(keccak256(abi.encodePacked(seed, t, s, "selector")));
                if (sel == bytes4(0)) {
                    sel = bytes4(uint32(1));
                }
                // tier=IMMEDIATE so delay=0 is the only legal choice; avoids InvalidDelay revert in the
                // property tests, which is checked separately.
                sels[s] = SelectorRule({selector: sel, valueCapPerCall: 1 ether, tier: TIER_IMMEDIATE, delaySeconds: 0});
            }
            // derive unique non-zero target from seed and index
            address tgt = address(uint160(uint256(keccak256(abi.encodePacked(seed, t, "target")))) | uint160(0x1000));
            targets[t] = TargetRule({target: tgt, selectors: sels});
        }
        return PolicyInput({
            targets: targets,
            dailySpendWeiCap: 10 ether,
            maxSlippageBps: 0,
            expiresAt: uint64(block.timestamp + 1 days),
            paused: false
        });
    }

    /// Detect whether the constructed input happens to have collisions (low probability but possible
    /// with adversarial fuzz seeds). In those cases we skip the assertion.
    function _hasCollisions(PolicyInput memory input) internal pure returns (bool) {
        for (uint256 i; i < input.targets.length; ++i) {
            for (uint256 j = i + 1; j < input.targets.length; ++j) {
                if (input.targets[i].target == input.targets[j].target) return true;
            }
            SelectorRule[] memory sels = input.targets[i].selectors;
            for (uint256 a; a < sels.length; ++a) {
                if (sels[a].selector == bytes4(0)) return true;
                for (uint256 b = a + 1; b < sels.length; ++b) {
                    if (sels[a].selector == sels[b].selector) return true;
                }
            }
        }
        return false;
    }

    // ---------- Property 1: Round-trip queryability ----------

    /// Every (target, selector) in input is queryable after copy.
    function testProperty_roundtrip_every_pair_queryable(uint256 seed, uint8 nT, uint8 nS) public {
        uint256 nTargets = bound(uint256(nT), 1, MAX_TARGETS);
        uint256 nSels = bound(uint256(nS), 1, MAX_SELECTORS_PER_TARGET);
        PolicyInput memory input = _buildInput(seed, nTargets, nSels);
        if (_hasCollisions(input)) return;

        h.applyInput(input);

        assertEq(h.targetsLength(), nTargets, "target count");
        for (uint256 t; t < nTargets; ++t) {
            address tgt = input.targets[t].target;
            assertTrue(h.isTargetAllowed(tgt), "target queryable");
            SelectorRule[] memory sels = input.targets[t].selectors;
            for (uint256 s; s < sels.length; ++s) {
                bytes4 sel = sels[s].selector;
                assertTrue(h.isSelectorAllowed(tgt, sel), "selector queryable");
                assertEq(h.valueCap(tgt, sel), sels[s].valueCapPerCall);
                assertEq(h.tierOf(tgt, sel), sels[s].tier);
                assertEq(h.delayFor(tgt, sel), sels[s].delaySeconds);
            }
        }
    }

    // ---------- Property 2: Idempotence ----------

    /// Two consecutive copies of the same input produce identical observable state.
    function testProperty_idempotence_two_copies_equal_state(uint256 seed, uint8 nT, uint8 nS) public {
        uint256 nTargets = bound(uint256(nT), 0, MAX_TARGETS);
        uint256 nSels = bound(uint256(nS), 0, MAX_SELECTORS_PER_TARGET);
        // Need at least one selector if there are targets, else duplicate-target check would not exercise.
        if (nTargets > 0 && nSels == 0) nSels = 1;
        PolicyInput memory input = _buildInput(seed, nTargets, nSels);
        if (_hasCollisions(input)) return;

        h.applyInput(input);
        // snapshot via observable getters
        uint256 lenA = h.targetsLength();
        // second copy of identical input
        h.applyInput(input);

        assertEq(h.targetsLength(), lenA, "target count preserved");
        for (uint256 t; t < input.targets.length; ++t) {
            address tgt = input.targets[t].target;
            assertTrue(h.isTargetAllowed(tgt));
            SelectorRule[] memory sels = input.targets[t].selectors;
            for (uint256 s; s < sels.length; ++s) {
                bytes4 sel = sels[s].selector;
                assertTrue(h.isSelectorAllowed(tgt, sel));
                assertEq(h.valueCap(tgt, sel), sels[s].valueCapPerCall);
                assertEq(h.tierOf(tgt, sel), sels[s].tier);
                assertEq(h.delayFor(tgt, sel), sels[s].delaySeconds);
            }
        }
    }

    // ---------- Property 3: Overwrite semantics ----------

    /// copy(A) then copy(B) where A and B disjoint → none of A's pairs queryable, all of B's are.
    function testProperty_overwrite_wipes_A_keeps_B(uint256 seedA, uint256 seedB, uint8 nT, uint8 nS) public {
        // Ensure seedA != seedB so derived addresses/selectors differ
        if (seedA == seedB) seedB = seedB ^ 0xDEADBEEF;
        uint256 nTargets = bound(uint256(nT), 1, MAX_TARGETS);
        uint256 nSels = bound(uint256(nS), 1, MAX_SELECTORS_PER_TARGET);

        PolicyInput memory inputA = _buildInput(seedA, nTargets, nSels);
        PolicyInput memory inputB = _buildInput(seedB, nTargets, nSels);
        if (_hasCollisions(inputA) || _hasCollisions(inputB)) return;
        // disjointness check: no target appears in both
        for (uint256 i; i < inputA.targets.length; ++i) {
            for (uint256 j; j < inputB.targets.length; ++j) {
                if (inputA.targets[i].target == inputB.targets[j].target) {
                    return; // skip non-disjoint case
                }
            }
        }

        h.applyInput(inputA);
        h.applyInput(inputB);

        // none of A's pairs queryable
        for (uint256 t; t < inputA.targets.length; ++t) {
            address tgt = inputA.targets[t].target;
            assertFalse(h.isTargetAllowed(tgt), "A target wiped");
            SelectorRule[] memory sels = inputA.targets[t].selectors;
            for (uint256 s; s < sels.length; ++s) {
                bytes4 sel = sels[s].selector;
                assertFalse(h.isSelectorAllowed(tgt, sel), "A selector wiped");
                assertEq(h.valueCap(tgt, sel), 0, "A cap wiped");
                assertEq(h.tierOf(tgt, sel), 0, "A tier wiped");
                assertEq(h.delayFor(tgt, sel), 0, "A delay wiped");
            }
        }
        // all of B's pairs queryable
        for (uint256 t; t < inputB.targets.length; ++t) {
            address tgt = inputB.targets[t].target;
            assertTrue(h.isTargetAllowed(tgt));
            SelectorRule[] memory sels = inputB.targets[t].selectors;
            for (uint256 s; s < sels.length; ++s) {
                assertTrue(h.isSelectorAllowed(tgt, sels[s].selector));
            }
        }
    }

    // ---------- Property 4: Bounded inputs ----------

    /// Oversize target list reverts TooManyTargets.
    function testProperty_too_many_targets_reverts(uint256 seed, uint8 overBy) public {
        uint256 over = bound(uint256(overBy), 1, 20);
        uint256 nTargets = MAX_TARGETS + over;
        PolicyInput memory input = _buildInput(seed, nTargets, 1);
        if (_hasCollisions(input)) return;
        vm.expectRevert(abi.encodeWithSelector(TooManyTargets.selector, nTargets, MAX_TARGETS));
        h.applyInput(input);
    }

    /// Oversize selector list on a single target reverts TooManySelectors.
    function testProperty_too_many_selectors_reverts(uint256 seed, uint8 overBy) public {
        uint256 over = bound(uint256(overBy), 1, 20);
        uint256 nSels = MAX_SELECTORS_PER_TARGET + over;
        PolicyInput memory input = _buildInput(seed, 1, nSels);
        if (_hasCollisions(input)) return;
        vm.expectRevert(
            abi.encodeWithSelector(TooManySelectors.selector, input.targets[0].target, nSels, MAX_SELECTORS_PER_TARGET)
        );
        h.applyInput(input);
    }

    /// Boundary: exactly MAX_TARGETS × MAX_SELECTORS_PER_TARGET is accepted.
    function testProperty_at_max_bounds_accepted(uint256 seed) public {
        PolicyInput memory input = _buildInput(seed, MAX_TARGETS, MAX_SELECTORS_PER_TARGET);
        if (_hasCollisions(input)) return;
        h.applyInput(input);
        assertEq(h.targetsLength(), MAX_TARGETS);
    }
}
