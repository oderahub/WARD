// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../PolicyTypes.sol";
import "../WardOracle.sol";

/// @notice Selector-safe helper for consulting WardOracle before an external call.
library WardCall {
    function check(
        WardOracle oracle,
        bytes32 policyId,
        address target,
        bytes memory data,
        uint256 value,
        uint256 spentToday
    ) internal returns (bool ok, bytes32 reason) {
        bytes4 selector;
        if (data.length >= 4) {
            assembly {
                selector := mload(add(data, 32))
            }
        }

        Intent memory intent = Intent({
            agentId: 0,
            requestId: 0,
            target: target,
            selector: selector,
            data: data,
            value: value,
            promptHash: bytes32(0),
            taskClass: 0
        });

        (bool success, bytes memory returndata) =
            address(oracle).call(abi.encodeCall(WardOracle.checkIntent, (policyId, intent, spentToday)));
        if (!success) {
            assembly {
                revert(add(returndata, 32), mload(returndata))
            }
        }
        return abi.decode(returndata, (bool, bytes32));
    }
}
