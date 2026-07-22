// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./PolicyTypes.sol";

error ZeroTarget();
error ZeroSelector(address target);
error DuplicateTarget(address target);
error DuplicateSelector(address target, bytes4 selector);
error InvalidTier(address target, bytes4 selector, uint8 tier);
error InvalidDelay(address target, bytes4 selector, uint8 tier, uint32 delaySeconds);
error TooManyTargets(uint256 count, uint256 max);
error TooManySelectors(address target, uint256 count, uint256 max);

uint256 constant MAX_TARGETS = 20;
uint256 constant MAX_SELECTORS_PER_TARGET = 10;

/// @notice Copies `PolicyInput` into storage while enforcing structural invariants.
library PolicyNormalizer {
    function copy(Policy storage p, PolicyInput memory input) internal {
        for (uint256 i; i < p.targets.length; ++i) {
            address t = p.targets[i];
            bytes4[] storage sels = p.selectors[t];
            for (uint256 j; j < sels.length; ++j) {
                bytes4 s = sels[j];
                delete p.isSelectorAllowed[t][s];
                delete p.valueCapPerCall[t][s];
                delete p.tier[t][s];
                delete p.delaySeconds[t][s];
            }
            delete p.selectors[t];
            delete p.isTargetAllowed[t];
        }
        delete p.targets;

        if (input.targets.length > MAX_TARGETS) revert TooManyTargets(input.targets.length, MAX_TARGETS);
        for (uint256 i; i < input.targets.length; ++i) {
            TargetRule memory tr = input.targets[i];
            if (tr.target == address(0)) revert ZeroTarget();
            if (tr.selectors.length > MAX_SELECTORS_PER_TARGET) {
                revert TooManySelectors(tr.target, tr.selectors.length, MAX_SELECTORS_PER_TARGET);
            }
            if (p.isTargetAllowed[tr.target]) revert DuplicateTarget(tr.target);
            p.isTargetAllowed[tr.target] = true;
            p.targets.push(tr.target);

            for (uint256 j; j < tr.selectors.length; ++j) {
                SelectorRule memory sr = tr.selectors[j];
                if (sr.selector == bytes4(0)) revert ZeroSelector(tr.target);
                if (p.isSelectorAllowed[tr.target][sr.selector]) {
                    revert DuplicateSelector(tr.target, sr.selector);
                }
                if (sr.tier > TIER_VETO_REQUIRED) {
                    revert InvalidTier(tr.target, sr.selector, sr.tier);
                }
                if (sr.tier != TIER_DELAYED && sr.delaySeconds != 0) {
                    revert InvalidDelay(tr.target, sr.selector, sr.tier, sr.delaySeconds);
                }

                p.isSelectorAllowed[tr.target][sr.selector] = true;
                p.selectors[tr.target].push(sr.selector);
                p.valueCapPerCall[tr.target][sr.selector] = sr.valueCapPerCall;
                p.tier[tr.target][sr.selector] = sr.tier;
                p.delaySeconds[tr.target][sr.selector] = sr.delaySeconds;
            }
        }

        p.dailySpendWeiCap = input.dailySpendWeiCap;
        p.maxSlippageBps = input.maxSlippageBps;
        p.expiresAt = input.expiresAt;
        p.paused = input.paused;
    }
}
