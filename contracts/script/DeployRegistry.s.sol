// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Script.sol";
import "../src/SentryAgentRegistry.sol";

/// @notice Deploys SentryAgentRegistry and writes the address to
///         `deployments/$CHAINID-registry.json` for the SDK + CLI + seed
///         step. The registry is ownerless, permissionless, and holds no
///         funds — first-writer-wins per agent address.
contract DeployRegistry is Script {
    function run() external returns (SentryAgentRegistry registry) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(pk);
        require(deployer.balance >= 0.05 ether, "LOW_STT_BALANCE");
        console2.log("Deployer:", deployer);
        console2.log("STT balance:", deployer.balance);

        vm.startBroadcast(pk);
        registry = new SentryAgentRegistry();
        vm.stopBroadcast();

        console2.log("SentryAgentRegistry deployed at:", address(registry));

        string memory json = "registryDeployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "registry", address(registry));
        vm.serializeAddress(json, "deployer", deployer);
        string memory out = vm.serializeUint(json, "deployedAt", block.timestamp);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), "-registry.json");
        vm.writeFile(path, out);
        console2.log("Wrote artifact:", path);
    }
}
