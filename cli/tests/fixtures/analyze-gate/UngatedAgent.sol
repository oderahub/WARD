// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract UngatedAgent {
    address public target;

    function dispatch(bytes calldata intentData) external {
        (bool ok,) = target.call(intentData);
        require(ok, "fail");
    }
}
