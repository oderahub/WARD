// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../../src/PolicyTypes.sol";

/// @notice Test helper that implements the SentryOracle checkIntent surface and tracks gate-before-call ordering.
contract MockSentryOracle {
    struct ObservedCheck {
        address target;
        bytes4 selector;
        uint256 order;
    }

    struct ObservedCall {
        address target;
        bytes4 selector;
        uint256 order;
    }

    ObservedCheck[] private observedChecks;
    ObservedCall[] private observedCalls;

    address public expectedTarget;
    bytes4 public expectedSelector;
    bool public nextOk = true;
    bytes32 public nextReason;
    uint256 private order;

    event ExpectedCheckSet(address indexed target, bytes4 indexed selector);
    event CheckObserved(address indexed target, bytes4 indexed selector, uint256 order);
    event ExternalCallObserved(address indexed target, bytes4 indexed selector, uint256 order);

    error ExpectedCheckNotObserved();
    error ExternalCallNotObserved();
    error CheckDidNotPrecedeCall();
    error UnexpectedCheck(address target, bytes4 selector);

    function expectCheck(address target, bytes4 selector) external {
        expectedTarget = target;
        expectedSelector = selector;
        delete observedChecks;
        delete observedCalls;
        order = 0;
        emit ExpectedCheckSet(target, selector);
    }

    function setNextResult(bool ok, bytes32 reason) external {
        nextOk = ok;
        nextReason = reason;
    }

    function checkIntent(bytes32, Intent calldata intent, uint256) external returns (bool ok, bytes32 reason) {
        order += 1;
        observedChecks.push(ObservedCheck({target: intent.target, selector: intent.selector, order: order}));
        emit CheckObserved(intent.target, intent.selector, order);

        if (expectedTarget != address(0) && (intent.target != expectedTarget || intent.selector != expectedSelector)) {
            revert UnexpectedCheck(intent.target, intent.selector);
        }

        return (nextOk, nextReason);
    }

    function recordExternalCall(address target, bytes4 selector) external {
        order += 1;
        observedCalls.push(ObservedCall({target: target, selector: selector, order: order}));
        emit ExternalCallObserved(target, selector, order);
    }

    function assertCheckedBeforeCall() external view {
        uint256 checkOrder;
        uint256 callOrder;

        for (uint256 i = 0; i < observedChecks.length; i++) {
            if (observedChecks[i].target == expectedTarget && observedChecks[i].selector == expectedSelector) {
                checkOrder = observedChecks[i].order;
                break;
            }
        }
        if (checkOrder == 0) revert ExpectedCheckNotObserved();

        for (uint256 i = 0; i < observedCalls.length; i++) {
            if (observedCalls[i].target == expectedTarget && observedCalls[i].selector == expectedSelector) {
                callOrder = observedCalls[i].order;
                break;
            }
        }
        if (callOrder == 0) revert ExternalCallNotObserved();
        if (checkOrder >= callOrder) revert CheckDidNotPrecedeCall();
    }
}
