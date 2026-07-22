// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {CounterAgent} from "../src/CounterAgent.sol";
import {Counter} from "../src/Counter.sol";
import {SentryOracle} from "sentry-somnia/SentryOracle.sol";

/// @notice Deploys CounterAgent using the late-binding pattern.
///         POLICY_ID is OPTIONAL at deploy time:
///           - If POLICY_ID env var is set & non-zero: binds it immediately
///             via setPolicyId(). Agent ships gated.
///           - If POLICY_ID is unset (or 0x0): agent ships UNGATED; bind
///             later with `cast send <agent> "setPolicyId(bytes32)" 0x...`.
contract DeployAgent is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        SentryOracle oracle = SentryOracle(vm.envAddress("SENTRY_ORACLE"));
        address counter = vm.envAddress("COUNTER");
        address deployer = vm.addr(pk);

        // POLICY_ID is optional. envOr returns 0x0 when unset.
        bytes32 policyId = vm.envOr("POLICY_ID", bytes32(0));

        vm.startBroadcast(pk);
        CounterAgent agent = new CounterAgent(oracle, Counter(counter), deployer);
        if (policyId != bytes32(0)) {
            agent.setPolicyId(policyId);
        }
        vm.stopBroadcast();

        // Ensure the deployments/ directory exists before vm.writeFile — first
        // deploys against a fresh checkout otherwise fail on the missing dir.
        vm.createDir("deployments", true);

        string memory line = string.concat(
            '{"counter":"', vm.toString(counter),
            '","agent":"', vm.toString(address(agent)),
            '","policyId":"', vm.toString(policyId),
            '","owner":"', vm.toString(deployer),
            '"}'
        );
        vm.writeFile("deployments/agent.json", line);

        console2.log("CounterAgent deployed at", address(agent));
        if (policyId == bytes32(0)) {
            console2.log("POLICY_ID NOT bound -- agent is running ungated.");
            console2.log("Bind later via:");
            console2.log("   cast send", address(agent), '"setPolicyId(bytes32)" 0xYOURPOLICY \\');
            console2.log("     --private-key $DEPLOYER_PK --rpc-url $SOMNIA_TESTNET_RPC");
        } else {
            console2.log("Bound to policyId", vm.toString(policyId));
        }
    }
}
