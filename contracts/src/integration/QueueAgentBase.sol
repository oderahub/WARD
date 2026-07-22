// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../PolicyTypes.sol";
import "../SentryQueue.sol";
import "./SentryAgentBase.sol";

/// @notice Base for agents that route queued tiers through SentryQueue.
/// @dev Queue expiry does not imply refunds; custody integrations override `_onQueueExpire`.
abstract contract QueueAgentBase is SentryAgentBase {
    SentryQueue public immutable queue;

    error QueueDispatchDidNotCommit(uint256 execId);

    constructor(SentryOracle _oracle, SentryQueue _queue, address _owner) SentryAgentBase(_oracle, _owner) {
        queue = _queue;
    }

    /// @dev `SentryQueue.enqueue` remains the source of truth for queueability.
    function _sentryEnqueueDelayed(address target, bytes memory data, uint256 value, uint256 reqId)
        internal
        returns (uint256 execId)
    {
        Intent memory intent = _buildQueueIntent(target, data, value, reqId);
        _precheckQueueIntent(intent);
        execId = queue.enqueue(POLICY_ID, intent, _sentrySpentToday());
        // Reserve the value against the enqueue-day cap so a second over-cap enqueue is
        // rejected. The cap check inside `queue.enqueue` ran against the pre-reservation
        // spend, which is correct for this intent.
        _sentryReserveQueued(execId, value);
    }

    function _sentryDispatchAndExecute(uint256 execId) internal returns (bytes memory) {
        Intent memory intent;
        try queue.dispatch(execId) returns (Intent memory dispatched) {
            intent = dispatched;
        } catch (bytes memory err) {
            if (_isPastDeadline(err)) {
                SentryQueue.QueuedIntent memory record = queue.getRecord(execId);
                queue.expireIfStale(execId); // mark Expired so retries cannot re-fire the hook
                _sentryReleaseQueued(execId); // free the enqueue-day reservation for the dead intent
                _onQueueExpire(execId, record.intent.target, record.intent.value);
                return "";
            }
            assembly {
                revert(add(err, 32), mload(err))
            }
        }

        SentryQueue.QueuedIntent memory afterDispatch = queue.getRecord(execId);
        if (afterDispatch.state != SentryQueue.State.Committed) revert QueueDispatchDidNotCommit(execId);

        // Consume (do not re-reserve): the value was already booked at enqueue, so execute
        // via `_executeReserved` to forward it exactly once without double-counting the cap.
        _sentryConsumeQueued(execId);
        return _executeReserved(intent.target, intent.data, intent.value);
    }

    function dispatchQueued(uint256 execId) external onlyOwner returns (bytes memory) {
        return _sentryDispatchAndExecute(execId);
    }

    /// @notice Release a reservation for an intent vetoed or expired OFF the dispatch path.
    /// @dev Permissionless but inert unless the queue record is already terminal.
    function settleQueued(uint256 execId) external {
        SentryQueue.QueuedIntent memory r = queue.getRecord(execId);
        if (
            r.state == SentryQueue.State.Vetoed || r.state == SentryQueue.State.Expired
                || r.state == SentryQueue.State.Committed
        ) {
            _sentryReleaseQueued(execId);
        }
    }

    /// @dev Override if enqueue reserved funds that expiry should release.
    function _onQueueExpire(uint256 execId, address target, uint256 value) internal virtual {
        execId;
        target;
        value;
    }

    function _buildQueueIntent(address target, bytes memory data, uint256 value, uint256 reqId)
        private
        pure
        returns (Intent memory)
    {
        bytes4 selector;
        if (data.length >= 4) {
            assembly {
                selector := mload(add(data, 32))
            }
        }

        return Intent({
            agentId: 0,
            requestId: reqId,
            target: target,
            selector: selector,
            data: data,
            value: value,
            promptHash: bytes32(0),
            taskClass: 0
        });
    }

    function _precheckQueueIntent(Intent memory intent) private {
        (bool success, bytes memory returndata) =
            address(oracle).call(abi.encodeCall(SentryOracle.checkIntent, (POLICY_ID, intent, _sentrySpentToday())));
        if (!success) {
            assembly {
                revert(add(returndata, 32), mload(returndata))
            }
        }
        abi.decode(returndata, (bool, bytes32));
    }

    function _isPastDeadline(bytes memory err) private pure returns (bool) {
        if (err.length < 4) return false;
        bytes4 selector;
        assembly {
            selector := mload(add(err, 32))
        }
        return selector == SentryQueue.PastDeadline.selector;
    }
}
