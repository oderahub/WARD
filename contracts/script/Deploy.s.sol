// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Script.sol";
import "../src/SentryOracle.sol";
import "../src/SentryQueue.sol";

/// @notice Deploys SentryOracle + SentryQueue and writes the addresses to
///         `deployments/$CHAINID.json` for the SDK + CLI. Neither contract
///         holds funds, has an owner, or executes external calls — both are
///         pure metadata + view contracts.
contract Deploy is Script {
    function run() external returns (SentryOracle oracle, SentryQueue queue) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        require(deployer.balance >= 0.1 ether, "LOW_STT_BALANCE");
        console2.log("Deployer:", deployer);
        console2.log("STT balance:", deployer.balance);

        vm.startBroadcast(pk);
        oracle = new SentryOracle();
        queue = new SentryQueue(oracle);
        vm.stopBroadcast();

        console2.log("SentryOracle deployed at:", address(oracle));
        console2.log("SentryQueue  deployed at:", address(queue));

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "sentryOracle", address(oracle));
        vm.serializeAddress(json, "sentryQueue", address(queue));
        vm.serializeAddress(json, "deployer", deployer);
        string memory out = vm.serializeUint(json, "deployedAt", block.timestamp);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(path, out);
        console2.log("Wrote artifact:", path);
    }
}
