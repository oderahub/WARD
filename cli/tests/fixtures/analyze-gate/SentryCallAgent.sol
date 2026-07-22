// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Stand-in declarations so the fixture is self-contained for the AST analyzer.
// (the file does not need to compile)
interface SentryOracle {}

library SentryCall {
    function check(
        SentryOracle oracle,
        bytes32 policyId,
        address target,
        bytes memory data,
        uint256 value,
        uint256 spentToday
    ) internal returns (bool ok, bytes32 reason) {}
}

contract SentryCallAgent {
    SentryOracle public oracle;
    bytes32 public POLICY_ID;
    address public target;

    function dispatch(bytes calldata intentData) external {
        (bool ok, bytes32 reason) = SentryCall.check(oracle, POLICY_ID, target, intentData, 0, 0);
        require(ok, string(abi.encodePacked("sentry: ", reason)));
        (bool success,) = target.call(intentData);
        require(success, "fail");
    }
}
