// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

uint8 constant TIER_IMMEDIATE = 0;
uint8 constant TIER_DELAYED = 1;
uint8 constant TIER_VETO_REQUIRED = 2;

struct SelectorRule {
    bytes4 selector;
    uint256 valueCapPerCall;
    uint8 tier;
    uint32 delaySeconds;
}

struct TargetRule {
    address target;
    SelectorRule[] selectors;
}

struct PolicyInput {
    TargetRule[] targets;
    uint256 dailySpendWeiCap;
    uint16 maxSlippageBps;
    uint64 expiresAt;
    bool paused;
}

struct Policy {
    address[] targets;
    mapping(address => bool) isTargetAllowed;
    mapping(address => bytes4[]) selectors;
    mapping(address => mapping(bytes4 => bool)) isSelectorAllowed;
    mapping(address => mapping(bytes4 => uint256)) valueCapPerCall;
    mapping(address => mapping(bytes4 => uint8)) tier;
    mapping(address => mapping(bytes4 => uint32)) delaySeconds;
    uint256 dailySpendWeiCap;
    uint16 maxSlippageBps;
    uint64 expiresAt;
    bool paused;
}

struct Intent {
    uint256 agentId;
    uint256 requestId;
    address target;
    bytes4 selector;
    bytes data;
    uint256 value;
    bytes32 promptHash;
    uint8 taskClass;
}
