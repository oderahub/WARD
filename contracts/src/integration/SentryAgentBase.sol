// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../SentryOracle.sol";
import "./SentryCall.sol";

/// @notice Base for agents that synchronously gate target calls through SentryOracle.
abstract contract SentryAgentBase {
    using SentryCall for SentryOracle;

    SentryOracle public immutable oracle;
    bytes32 public POLICY_ID;
    address public owner;

    mapping(uint256 dayBucket => uint256 spentWei) private sentrySpentByDay;

    /// @dev Tracks queued-intent spend reserved at enqueue against its enqueue-day bucket.
    ///      status: 0 none, 1 active, 2 settled (consumed on dispatch or released on veto/expire).
    struct QueuedReservation {
        uint64 dayBucket;
        uint8 status;
        uint256 value;
    }

    mapping(uint256 execId => QueuedReservation) private sentryReservations;

    event PolicyBound(bytes32 indexed newPolicyId, bytes32 indexed oldPolicyId, address indexed by);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroOwner();
    error SentryRejected(bytes32 reason);
    error SentryCallFailed(bytes returndata);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Entrypoint-policy guard for the agent's own selector.
    /// @dev Spend is reserved before the body to close reentrancy against the daily cap.
    ///      POLICY_ID == 0 keeps ungated mode; use `_sentryCheck` + `_call` for downstream-call policies.
    modifier sentryGuarded(bytes4 selector, uint256 value) {
        if (POLICY_ID != bytes32(0)) {
            (bool ok, bytes32 reason) =
                oracle.checkSelector(POLICY_ID, address(this), selector, value, _sentrySpentToday());
            if (!ok) revert SentryRejected(reason);
        }
        if (value != 0) {
            sentrySpentByDay[_sentryDayBucket(block.timestamp)] += value;
        }
        _;
    }

    constructor(SentryOracle _oracle, address _owner) {
        if (_owner == address(0)) revert ZeroOwner();
        oracle = _oracle;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    /// @notice Bind a policy, rebind to a new one, or pass bytes32(0) as an emergency ungated mode.
    function setPolicyId(bytes32 newPolicyId) external onlyOwner {
        bytes32 oldPolicyId = POLICY_ID;
        POLICY_ID = newPolicyId;
        emit PolicyBound(newPolicyId, oldPolicyId, msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroOwner();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function _sentryCheck(address target, bytes memory data, uint256 value, uint256 spentToday) internal {
        if (POLICY_ID == bytes32(0)) return;
        (bool ok, bytes32 reason) = oracle.check(POLICY_ID, target, data, value, spentToday);
        if (!ok) revert SentryRejected(reason);
    }

    function _call(address target, bytes memory data, uint256 value) internal returns (bytes memory returndata) {
        // Reserve before the external call so reentrancy cannot reuse the daily cap.
        // A revert unwinds the reservation.
        if (value != 0) {
            sentrySpentByDay[_sentryDayBucket(block.timestamp)] += value;
        }
        (bool success, bytes memory out) = target.call{value: value}(data);
        if (!success) revert SentryCallFailed(out);
        return out;
    }

    /// @dev Reserve queued value into the enqueue-day bucket. No-op for zero value.
    function _sentryReserveQueued(uint256 execId, uint256 value) internal {
        if (value == 0) return;
        uint64 bucket = uint64(_sentryDayBucket(block.timestamp));
        sentrySpentByDay[bucket] += value;
        sentryReservations[execId] = QueuedReservation({dayBucket: bucket, status: 1, value: value});
    }

    /// @dev Mark a reservation consumed (kept counted) once its intent dispatches.
    function _sentryConsumeQueued(uint256 execId) internal {
        QueuedReservation storage r = sentryReservations[execId];
        if (r.status == 1) r.status = 2;
    }

    /// @dev Release a reservation (subtract from its original bucket) for a dead intent.
    function _sentryReleaseQueued(uint256 execId) internal {
        QueuedReservation storage r = sentryReservations[execId];
        if (r.status == 1) {
            sentrySpentByDay[r.dayBucket] -= r.value;
            r.status = 2;
        }
    }

    /// @dev Execute an already-reserved queued intent WITHOUT re-reserving its value.
    function _executeReserved(address target, bytes memory data, uint256 value)
        internal
        returns (bytes memory returndata)
    {
        (bool success, bytes memory out) = target.call{value: value}(data);
        if (!success) revert SentryCallFailed(out);
        return out;
    }

    function _sentrySpentToday() internal view returns (uint256) {
        return sentrySpentByDay[_sentryDayBucket(block.timestamp)];
    }

    function _sentryDayBucket(uint256 timestamp) private pure returns (uint256) {
        return timestamp / 1 days;
    }
}
