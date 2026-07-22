// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IOwnable {
    function owner() external view returns (address);
}

/// @title SentryAgentRegistry
/// @notice Ownerless discovery registry for Sentry-gated agents.
/// @dev First registrar owns updates, which prevents spam-overwrites without custody.
contract SentryAgentRegistry {
    struct Agent {
        address agent;
        address registrar;
        address oracle;
        bytes32 policyId;
        string name;
        string metadataURI;
        string[] tags;
        uint64 updatedAt;
        bool active;
    }

    mapping(address => Agent) public agents;
    mapping(address => bool) public agentVerified;
    address[] public agentList;

    event AgentRegistered(
        address indexed agent,
        address indexed registrar,
        address indexed oracle,
        bytes32 policyId,
        string name,
        string metadataURI,
        string[] tags
    );
    event AgentUpdated(
        address indexed agent,
        address indexed registrar,
        address oracle,
        bytes32 policyId,
        string metadataURI,
        string[] tags
    );
    event AgentStatusChanged(address indexed agent, address indexed registrar, bool active);
    event AgentClaimed(address indexed agent, address indexed controller);

    error NotRegistrar();
    error InvalidAgent();
    error NotAgentController();

    function register(
        address agent,
        address oracle,
        bytes32 policyId,
        string calldata name,
        string calldata metadataURI,
        string[] calldata tags
    ) external {
        if (agent == address(0)) revert InvalidAgent();
        Agent storage entry = agents[agent];
        if (entry.registrar == address(0)) {
            entry.agent = agent;
            entry.registrar = msg.sender;
            entry.name = name;
            agentList.push(agent);
        } else if (entry.registrar != msg.sender) {
            revert NotRegistrar();
        } else {
            entry.name = name;
        }
        entry.oracle = oracle;
        entry.policyId = policyId;
        entry.metadataURI = metadataURI;
        entry.tags = tags;
        entry.updatedAt = uint64(block.timestamp);
        entry.active = true;
        emit AgentRegistered(agent, msg.sender, oracle, policyId, name, metadataURI, tags);
    }

    function update(
        address agent,
        address oracle,
        bytes32 policyId,
        string calldata metadataURI,
        string[] calldata tags
    ) external {
        Agent storage entry = agents[agent];
        if (entry.registrar == address(0)) revert InvalidAgent();
        if (entry.registrar != msg.sender) revert NotRegistrar();
        entry.oracle = oracle;
        entry.policyId = policyId;
        entry.metadataURI = metadataURI;
        entry.tags = tags;
        entry.updatedAt = uint64(block.timestamp);
        emit AgentUpdated(agent, msg.sender, oracle, policyId, metadataURI, tags);
    }

    function setActive(address agent, bool active) external {
        Agent storage entry = agents[agent];
        if (entry.registrar == address(0)) revert InvalidAgent();
        if (entry.registrar != msg.sender) revert NotRegistrar();
        entry.active = active;
        entry.updatedAt = uint64(block.timestamp);
        emit AgentStatusChanged(agent, msg.sender, active);
    }

    function agentCount() external view returns (uint256) {
        return agentList.length;
    }

    function agentsPaginated(uint256 offset, uint256 limit) external view returns (Agent[] memory page) {
        uint256 total = agentList.length;
        if (offset >= total) return new Agent[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new Agent[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = agents[agentList[i]];
        }
    }

    /// @notice Reclaim an entry by proving control of the agent, marking it verified.
    /// @dev Control = caller is the agent, or the agent's EIP-173/SentryAgentBase owner().
    function claimAgent(address agent) external {
        Agent storage entry = agents[agent];
        if (entry.registrar == address(0)) revert InvalidAgent();
        if (!_controls(agent, msg.sender)) revert NotAgentController();
        entry.registrar = msg.sender;
        entry.updatedAt = uint64(block.timestamp);
        agentVerified[agent] = true;
        emit AgentClaimed(agent, msg.sender);
    }

    function _controls(address agent, address who) private view returns (bool) {
        if (who == agent) return true;
        try IOwnable(agent).owner() returns (address o) {
            return o == who && o != address(0);
        } catch {
            return false;
        }
    }

    function getAgent(address agent) external view returns (Agent memory) {
        return agents[agent];
    }
}
