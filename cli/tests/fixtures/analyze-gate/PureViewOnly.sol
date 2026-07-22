// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract PureViewOnly {
    uint256 public total;

    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }

    function getTotal() external view returns (uint256) {
        return total;
    }
}
