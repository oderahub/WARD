// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal callable target for Ward tests. Exposes a few selectors with distinct effects so
///         tests can assert that the right call landed with the right value and revert-on-demand.
contract MockTarget {
    uint256 public pings;
    uint256 public pongs;
    uint256 public lastValue;
    bool public shouldRevert;

    event Pinged(uint256 value, uint256 totalPings);
    event Ponged(uint256 value, uint256 totalPongs);

    function ping() external payable {
        if (shouldRevert) revert("MockTarget:REVERT");
        pings += 1;
        lastValue = msg.value;
        emit Pinged(msg.value, pings);
    }

    function pong(uint256 nonce) external payable {
        if (shouldRevert) revert("MockTarget:REVERT");
        pongs += 1;
        lastValue = msg.value;
        emit Ponged(msg.value, pongs);
        nonce;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    receive() external payable {}
}
