// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Avalanche Fuji (C-Chain testnet) constants.
/// @dev WardOracle / WardQueue / the integration layer are chain-agnostic;
///      these constants exist for deploy scripts, tests, and example actors.
///      Unlike Avalanche, Avalanche has no on-chain agent platform, so there is no
///      AGENT_PLATFORM address or agent-id here — Ward on Avalanche guards
///      arbitrary contract actors (treasury bots, keepers, DeFi automation),
///      not calls into an on-chain LLM service.
library AvalancheFuji {
    uint256 internal constant CHAIN_ID = 43113;
    string internal constant RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
    string internal constant EXPLORER_URL = "https://testnet.snowtrace.io";

    // Native gas token is AVAX (18 decimals), so `msg.value` caps in policies are
    // denominated in wei-of-AVAX exactly as they were in wei-of-AVAX on Avalanche.
}
