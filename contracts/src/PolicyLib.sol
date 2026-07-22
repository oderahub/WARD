// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./PolicyTypes.sol";

/// @notice Storage-bound policy validation; the executor owns spend tracking.
library PolicyLib {
    function validate(Policy storage p, Intent memory i, uint256 spentToday)
        internal
        view
        returns (bool ok, bytes32 reason)
    {
        if (p.paused) return (false, bytes32("PAUSED"));
        if (block.timestamp > p.expiresAt) return (false, bytes32("EXPIRED"));
        if (i.data.length < 4) return (false, bytes32("BAD_CALLDATA"));
        if (_selectorOf(i.data) != i.selector) return (false, bytes32("SELECTOR_MISMATCH"));
        if (!p.isTargetAllowed[i.target]) return (false, bytes32("TARGET_NOT_ALLOWED"));
        if (!p.isSelectorAllowed[i.target][i.selector]) return (false, bytes32("SELECTOR_NOT_ALLOWED"));
        if (i.value > p.valueCapPerCall[i.target][i.selector]) return (false, bytes32("VALUE_CAP"));
        if (spentToday > p.dailySpendWeiCap || i.value > p.dailySpendWeiCap - spentToday) {
            return (false, bytes32("DAILY_CAP"));
        }

        return (true, bytes32(0));
    }

    function tierOf(Policy storage p, address target, bytes4 selector) internal view returns (uint8) {
        return p.tier[target][selector];
    }

    function delayFor(Policy storage p, address target, bytes4 selector) internal view returns (uint32) {
        return p.delaySeconds[target][selector];
    }

    function _selectorOf(bytes memory data) private pure returns (bytes4 selector) {
        assembly {
            selector := mload(add(data, 32))
        }
    }
}
