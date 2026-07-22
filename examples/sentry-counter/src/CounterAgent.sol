// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "sentry-somnia/SentryOracle.sol";
import "sentry-somnia/integration/SentryAgentBase.sol";
import {Counter} from "./Counter.sol";

/// @notice Sample with independent caller ACL and Sentry policy gates.
/// @dev Modifier order is deliberate: `onlyOperator` rejects before the oracle call.
///      Operators do not auto-rotate with ownership.
contract CounterAgent is SentryAgentBase {
    Counter public immutable counter;

    /// @notice Owner-managed caller allow-list, independent of `owner`.
    mapping(address => bool) public isOperator;

    event OperatorAdded(address indexed operator, address indexed by);
    event OperatorRemoved(address indexed operator, address indexed by);

    error NotOperator();

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    constructor(SentryOracle _oracle, Counter _counter, address _owner)
        SentryAgentBase(_oracle, _owner)
    {
        counter = _counter;
        // Bootstrap the deploy-time owner for immediate sample use.
        isOperator[_owner] = true;
        emit OperatorAdded(_owner, address(0));
    }

    /// @notice No-op when `op` is already an operator.
    function addOperator(address op) external onlyOwner {
        if (!isOperator[op]) {
            isOperator[op] = true;
            emit OperatorAdded(op, msg.sender);
        }
    }

    /// @notice No-op when `op` is not an operator.
    function removeOperator(address op) external onlyOwner {
        if (isOperator[op]) {
            isOperator[op] = false;
            emit OperatorRemoved(op, msg.sender);
        }
    }

    function bump(uint256 by) external onlyOperator sentryGuarded(this.bump.selector, 0) {
        counter.bump(by);
    }

    function reset() external onlyOperator sentryGuarded(this.reset.selector, 0) {
        counter.reset();
    }
}
