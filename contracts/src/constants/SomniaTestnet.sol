// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Somnia Testnet constants; addresses must match deployed platform contracts.
library SomniaTestnet {
    uint256 internal constant CHAIN_ID = 50312;
    string internal constant RPC_URL = "https://dream-rpc.somnia.network";

    address internal constant AGENT_PLATFORM = 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776;

    /// @notice LLM Inference base agent; default request cost is about 0.12 STT.
    uint256 internal constant LLM_INFERENCE_AGENT_ID = 12847293847561029384;

    uint256 internal constant JSON_API_AGENT_ID = 13174292974160097713;

    // Matches platform.getRequestDeposit() at default subcommitteeSize=3.
    uint256 internal constant DEFAULT_REQUEST_DEPOSIT = 0.12 ether;
}
