// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./PolicyTypes.sol";
import "./PolicyLib.sol";
import "./PolicyNormalizer.sol";

/// @notice On-chain policy registry with synchronous checks.
/// @dev `checkIntent` only approves immediate selectors; queued tiers return `REQUIRES_*`.
contract WardOracle {
    using PolicyNormalizer for Policy;
    using PolicyLib for Policy;

    mapping(bytes32 => Policy) private policies;
    mapping(bytes32 => address) public policyOwner;
    mapping(bytes32 => address) public pendingPolicyOwner;
    mapping(bytes32 => uint64) public policyVersion;

    event PolicyPublished(bytes32 indexed policyId, address indexed owner, bytes32 label);
    event PolicyUpdated(bytes32 indexed policyId, address indexed owner);
    event PolicyOwnershipTransferStarted(
        bytes32 indexed policyId, address indexed currentOwner, address indexed pendingOwner
    );
    event PolicyOwnershipTransferred(bytes32 indexed policyId, address indexed previousOwner, address indexed newOwner);
    event PolicyOwnershipTransferCancelled(
        bytes32 indexed policyId, address indexed currentOwner, address indexed cancelledPendingOwner
    );

    error NotPolicyOwner();
    error NotPendingOwner();
    error NoPendingTransfer();
    error PolicyExists();
    error PolicyNotFound();
    error ZeroAddress();

    function publishPolicy(bytes32 label, PolicyInput calldata input) external returns (bytes32 policyId) {
        policyId = keccak256(abi.encode(msg.sender, label));
        if (policyOwner[policyId] != address(0)) revert PolicyExists();
        policyOwner[policyId] = msg.sender;
        policies[policyId].copy(input);
        policyVersion[policyId] = 1;
        emit PolicyPublished(policyId, msg.sender, label);
    }

    function updatePolicy(bytes32 policyId, PolicyInput calldata input) external {
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner();
        policies[policyId].copy(input);
        policyVersion[policyId] += 1;
        emit PolicyUpdated(policyId, msg.sender);
    }

    function transferPolicyOwnership(bytes32 policyId, address newOwner) external {
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        pendingPolicyOwner[policyId] = newOwner;
        emit PolicyOwnershipTransferStarted(policyId, msg.sender, newOwner);
    }

    function acceptPolicyOwnership(bytes32 policyId) external {
        address pending = pendingPolicyOwner[policyId];
        if (pending != msg.sender) revert NotPendingOwner();
        address previous = policyOwner[policyId];
        policyOwner[policyId] = pending;
        delete pendingPolicyOwner[policyId];
        emit PolicyOwnershipTransferred(policyId, previous, pending);
    }

    function cancelPolicyOwnershipTransfer(bytes32 policyId) external {
        if (policyOwner[policyId] != msg.sender) revert NotPolicyOwner();
        address cancelled = pendingPolicyOwner[policyId];
        if (cancelled == address(0)) revert NoPendingTransfer();
        delete pendingPolicyOwner[policyId];
        emit PolicyOwnershipTransferCancelled(policyId, msg.sender, cancelled);
    }

    /// @notice Immediate-dispatch check; queued tiers return `REQUIRES_*`.
    /// @dev Unknown policies revert so misconfigured references do not look like denials.
    function checkIntent(bytes32 policyId, Intent calldata intent, uint256 spentToday)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        if (policyOwner[policyId] == address(0)) revert PolicyNotFound();
        (ok, reason) = policies[policyId].validate(intent, spentToday);
        if (!ok) return (ok, reason);
        uint8 tier = policies[policyId].tierOf(intent.target, intent.selector);
        if (tier == TIER_DELAYED) return (false, bytes32("REQUIRES_DELAY"));
        if (tier == TIER_VETO_REQUIRED) return (false, bytes32("REQUIRES_VETO"));
        return (true, bytes32(0));
    }

    /// @notice Selector-only variant of `checkIntent`; queued tiers still return `REQUIRES_*`.
    function checkSelector(bytes32 policyId, address target, bytes4 selector, uint256 value, uint256 spentToday)
        external
        view
        returns (bool ok, bytes32 reason)
    {
        if (policyOwner[policyId] == address(0)) revert PolicyNotFound();
        Intent memory intent = Intent({
            agentId: 0,
            requestId: 0,
            target: target,
            selector: selector,
            data: abi.encodePacked(selector),
            value: value,
            promptHash: bytes32(0),
            taskClass: 0
        });
        (ok, reason) = policies[policyId].validate(intent, spentToday);
        if (!ok) return (ok, reason);
        uint8 tier = policies[policyId].tierOf(target, selector);
        if (tier == TIER_DELAYED) return (false, bytes32("REQUIRES_DELAY"));
        if (tier == TIER_VETO_REQUIRED) return (false, bytes32("REQUIRES_VETO"));
        return (true, bytes32(0));
    }

    /// @notice Inspect queue metadata for a selector.
    function tierAndDelay(bytes32 policyId, address target, bytes4 selector)
        external
        view
        returns (uint8 tier, uint32 delaySeconds)
    {
        if (policyOwner[policyId] == address(0)) revert PolicyNotFound();
        tier = policies[policyId].tierOf(target, selector);
        delaySeconds = policies[policyId].delayFor(target, selector);
    }

    function policyIdFor(address publisher, bytes32 label) external pure returns (bytes32) {
        return keccak256(abi.encode(publisher, label));
    }

    /// @notice Kill-switch fields used by queue dispatch revalidation.
    function policyHealth(bytes32 policyId) external view returns (bool paused, uint64 expiresAt) {
        if (policyOwner[policyId] == address(0)) revert PolicyNotFound();
        Policy storage p = policies[policyId];
        return (p.paused, p.expiresAt);
    }
}
