// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./PolicyTypes.sol";
import "./SentryOracle.sol";

/// @notice Queue metadata for `TIER_DELAYED` and `TIER_VETO_REQUIRED` intents.
/// @dev Holds no funds and executes no calls; askers own spend tracking.
///      DELAYED dispatches by asker, VETO_REQUIRED by policy owner.
contract SentryQueue {
    SentryOracle public immutable oracle;

    enum State {
        None,
        Pending,
        Committed,
        Vetoed,
        Expired
    }

    struct QueuedIntent {
        bytes32 policyId;
        uint64 policyVersion;
        Intent intent;
        address asker;
        uint64 enqueuedAt;
        uint64 earliestCommitAt;
        uint64 deadline;
        uint8 tier;
        State state;
    }

    /// @notice Fixed-size queue metadata without `Intent.data`.
    struct RecordHeader {
        bytes32 policyId;
        uint64 policyVersion;
        address asker;
        uint64 enqueuedAt;
        uint64 earliestCommitAt;
        uint64 deadline;
        uint8 tier;
        State state;
        address target;
        bytes4 selector;
        uint256 value;
        uint256 requestId;
    }

    uint32 public constant COMMIT_WINDOW_SECONDS = 7 days;

    mapping(uint256 => QueuedIntent) private queued;
    mapping(uint256 => address) public approvedBy;
    uint256 public nextExecId = 1;

    event Enqueued(
        uint256 indexed execId,
        bytes32 indexed policyId,
        address indexed asker,
        uint8 tier,
        uint64 earliestCommitAt,
        uint64 deadline,
        bytes32 calldataHash
    );
    event Dispatched(uint256 indexed execId, address indexed dispatcher, bytes32 indexed policyId, bytes32 intentHash);
    event Vetoed(uint256 indexed execId, bytes32 indexed policyId, bytes32 reason);
    event Expired(uint256 indexed execId, bytes32 indexed policyId);
    event Approved(uint256 indexed execId, bytes32 indexed policyId);

    error NotPending();
    error TooEarly();
    error PastDeadline();
    error NotAuthorizedDispatcher();
    error NotPolicyOwner();
    error NotVetoTier();
    error NotQueueable(bytes32 reason);
    error PolicyChanged(bytes32 reason);

    constructor(SentryOracle _oracle) {
        oracle = _oracle;
    }

    /// @notice Enqueue only intents rejected by the oracle as `REQUIRES_DELAY` or `REQUIRES_VETO`.
    function enqueue(bytes32 policyId, Intent calldata intent, uint256 spentToday) external returns (uint256 execId) {
        (bool ok, bytes32 reason) = oracle.checkIntent(policyId, intent, spentToday);
        if (ok) revert NotQueueable(bytes32("IMMEDIATE_NO_QUEUE_NEEDED"));
        if (reason != bytes32("REQUIRES_DELAY") && reason != bytes32("REQUIRES_VETO")) {
            revert NotQueueable(reason);
        }

        (uint8 tier, uint32 delaySeconds) = oracle.tierAndDelay(policyId, intent.target, intent.selector);

        execId = nextExecId++;
        uint64 nowTs = uint64(block.timestamp);
        uint64 earliest = nowTs + uint64(delaySeconds);
        uint64 deadline_ = earliest + uint64(COMMIT_WINDOW_SECONDS);
        uint64 policyVersion_ = oracle.policyVersion(policyId);

        QueuedIntent storage q = queued[execId];
        q.policyId = policyId;
        q.policyVersion = policyVersion_;
        q.intent = intent;
        q.asker = msg.sender;
        q.enqueuedAt = nowTs;
        q.earliestCommitAt = earliest;
        q.deadline = deadline_;
        q.tier = tier;
        q.state = State.Pending;

        emit Enqueued(execId, policyId, msg.sender, tier, earliest, deadline_, keccak256(intent.data));
    }

    /// @notice Commit a pending intent and return it for caller-side execution.
    /// @dev Revalidates policy liveness/version, but not spend caps; askers own spend tracking.
    function dispatch(uint256 execId) external returns (Intent memory intent) {
        _checkDispatchAuthorized(execId);
        _checkPolicyStillActive(execId);
        QueuedIntent storage q = queued[execId];
        q.state = State.Committed;
        intent = q.intent;
        emit Dispatched(execId, msg.sender, q.policyId, keccak256(abi.encode(intent)));
    }

    function _checkDispatchAuthorized(uint256 execId) private view {
        QueuedIntent storage q = queued[execId];
        if (q.state != State.Pending) revert NotPending();
        if (block.timestamp < q.earliestCommitAt) revert TooEarly();
        if (block.timestamp > q.deadline) revert PastDeadline();
        if (q.tier == TIER_VETO_REQUIRED) {
            bool ownerCaller = msg.sender == oracle.policyOwner(q.policyId);
            address approver = approvedBy[execId];
            bool approvedAsker =
                approver != address(0) && approver == oracle.policyOwner(q.policyId) && msg.sender == q.asker;
            if (!ownerCaller && !approvedAsker) revert NotPolicyOwner();
        } else {
            if (msg.sender != q.asker) revert NotAuthorizedDispatcher();
        }
    }

    function _checkPolicyStillActive(uint256 execId) private view {
        QueuedIntent storage q = queued[execId];
        (bool paused, uint64 expiresAt) = oracle.policyHealth(q.policyId);
        if (paused) revert PolicyChanged(bytes32("PAUSED"));
        if (block.timestamp > expiresAt) revert PolicyChanged(bytes32("EXPIRED"));
        if (oracle.policyVersion(q.policyId) != q.policyVersion) revert PolicyChanged(bytes32("UPDATED"));
    }

    /// @notice Policy owner pre-approves a VETO_REQUIRED intent so its asker can dispatch+execute.
    function approve(uint256 execId) external {
        QueuedIntent storage q = queued[execId];
        if (q.state != State.Pending) revert NotPending();
        if (q.tier != TIER_VETO_REQUIRED) revert NotVetoTier();
        if (msg.sender != oracle.policyOwner(q.policyId)) revert NotPolicyOwner();
        approvedBy[execId] = msg.sender;
        emit Approved(execId, q.policyId);
    }

    function veto(uint256 execId, bytes32 reason) external {
        QueuedIntent storage q = queued[execId];
        if (q.state != State.Pending) revert NotPending();
        if (msg.sender != oracle.policyOwner(q.policyId)) revert NotPolicyOwner();
        q.state = State.Vetoed;
        emit Vetoed(execId, q.policyId, reason);
    }

    function expireIfStale(uint256 execId) external {
        QueuedIntent storage q = queued[execId];
        if (q.state != State.Pending) revert NotPending();
        if (block.timestamp <= q.deadline) revert TooEarly();
        q.state = State.Expired;
        emit Expired(execId, q.policyId);
    }

    function getRecord(uint256 execId) external view returns (QueuedIntent memory) {
        return queued[execId];
    }

    function getRecordHeader(uint256 execId) external view returns (RecordHeader memory) {
        QueuedIntent storage q = queued[execId];
        return RecordHeader({
            policyId: q.policyId,
            policyVersion: q.policyVersion,
            asker: q.asker,
            enqueuedAt: q.enqueuedAt,
            earliestCommitAt: q.earliestCommitAt,
            deadline: q.deadline,
            tier: q.tier,
            state: q.state,
            target: q.intent.target,
            selector: q.intent.selector,
            value: q.intent.value,
            requestId: q.intent.requestId
        });
    }
}
