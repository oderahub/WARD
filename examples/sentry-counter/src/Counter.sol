// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal target with one allowed and one denied sample selector.
contract Counter {
    uint256 public value;

    event Bumped(uint256 by, uint256 newValue);
    event Reset();

    function bump(uint256 by) external {
        value += by;
        emit Bumped(by, value);
    }

    function reset() external {
        value = 0;
        emit Reset();
    }
}
