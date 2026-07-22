// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {Counter} from "../src/Counter.sol";

contract DeployCounter is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);
        Counter counter = new Counter();
        vm.stopBroadcast();

        // Ensure the deployments/ directory exists before vm.writeFile — first
        // deploys against a fresh checkout otherwise fail on the missing dir.
        vm.createDir("deployments", true);

        string memory line = string.concat(
            '{"counter":"', vm.toString(address(counter)), '"}'
        );
        vm.writeFile("deployments/counter.json", line);
    }
}
